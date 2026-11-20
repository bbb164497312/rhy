/* 颜料入水晕开层：透明 WebGL 全屏画布，叠在 MV 视频之上、游戏画布之下。
   参照开源反馈式墨色扩散思路（PavelDoGreat WebGL Fluid / Observable black-ink 双 FBO
   ping-pong、InkField 扩散反馈、@crazygl/hero-floating-ink 域扭曲漂移）：
   两枚 FBO 交替存染料场，每帧做四邻域扩散 + 慢速对流 + 缓慢衰减，持续在游走的
   注入点滴入 MV 色颜料，颜料在水中缓缓洇开、交融、飘移，而不是一贴一贴的独立色块。
   无 WebGL 时静默降级，不影响游戏。 */
(function (global) {
  'use strict';

  var VERT = [
    'attribute vec2 aPos;',
    'varying vec2 vUv;',
    'void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }'
  ].join('\n');

  /* 反馈扩散片元：读上一帧染料 → 对流回采 → 四邻域模糊扩散 → 衰减 → 注入新墨 */
  var FEED = [
    'precision mediump float;',
    'varying vec2 vUv;',
    'uniform sampler2D uPrev;',
    'uniform vec2 uTexel;',
    'uniform float uTime;',
    'uniform float uEnergy;',
    'uniform float uAspect;',
    'uniform vec2 uEye;',
    'uniform float uEyeR;',
    'uniform float uEyeOn;',
    'uniform float uEyePulse;',

    'float hash(vec2 p){',
    '  p = fract(p * vec2(123.34, 456.21));',
    '  p += dot(p, p + 45.32);',
    '  return fract(p.x * p.y);',
    '}',
    'float vNoise(vec2 p){',
    '  vec2 i = floor(p); vec2 f = fract(p);',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  float a = hash(i);',
    '  float b = hash(i + vec2(1.0, 0.0));',
    '  float c = hash(i + vec2(0.0, 1.0));',
    '  float d = hash(i + vec2(1.0, 1.0));',
    '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);',
    '}',
    '  /* WebGL1 无整数取模：用 fract 做五色循环，避开 GLSL ES 3.00 专属语法 */',
    '  vec3 palette(float k){',
    '    float m = fract(k * 0.2) * 5.0;',
    '    if (m < 1.0) return vec3(0.227, 0.420, 0.910);',
    '    if (m < 2.0) return vec3(1.000, 0.361, 0.620);',
    '    if (m < 3.0) return vec3(0.561, 0.878, 0.416);',
    '    if (m < 4.0) return vec3(0.706, 0.361, 1.000);',
    '    return vec3(0.949, 0.847, 0.361);',
    '  }',
    '',
    'void main(){',
    '  vec2 uv = vUv;',
    '  /* pavel 式轻量平流：用噪声场造一股缓慢旋流回采上一帧，染料自己飘移混色，',
    '     不引入速度 FBO（WebGL1 兼容）；位移量级保持在几个纹素，不整片糊 */',
    '  vec2 na = vec2(vNoise(uv * 3.0 + vec2(uTime * 0.08, 0.0)), vNoise(uv * 3.0 + vec2(0.0, uTime * 0.07)));',
    '  vec2 drift = (na - 0.5) * uTexel * 3.0;',
    '  vec4 prev = texture2D(uPrev, uv - drift);',
    '  vec4 dye = prev;',
    '  dye.rgb *= 0.86;',
    '  dye.a   *= 0.86;',
    '  for (int i = 0; i < 8; i++) {',
    '    float fi = float(i);',
    '    vec2 ep = vec2(',
    '      0.5 + 0.32 * sin(uTime * 0.50 + fi * 2.1),',
    '      0.5 + 0.32 * cos(uTime * 0.43 + fi * 1.3));',
    '    vec2 d = uv - ep; d.x *= uAspect;',
    '    float g = exp(-dot(d, d) / 0.006);',
    '    vec3 col = palette(fi);',
    '    dye.rgb += col * g * 0.013;',
    '    dye.a   += g * 0.013;',
    '  }',

    '  /* 眼周墨：只在节拍脉冲瞬间迸出（对应参考件"只在移动/接触处上色"），',
    '     静止间隔靠衰减自然褪回暗场，不再常驻底晕把原地一直点亮 */',
    '  vec2 ed = uv - uEye; ed.x *= uAspect;',
    '  float el = length(ed);',
    '  float p = uEyePulse;',
    '  float shellR = uEyeR * (1.0 + (1.0 - p) * 1.15);',
    '  float shellW = uEyeR * (0.22 + 0.28 * p);',
    '  float egShell = exp(-pow((el - shellR) / shellW, 2.0));',
    '  float egCore = exp(-dot(ed, ed) / (uEyeR * uEyeR * 0.30));',
    '  float eg = (egShell * 0.7 + egCore * 0.35) * p;',
    '  vec3 eyeCol = vec3(1.0, 0.361, 0.620) * 0.45 + vec3(0.227, 0.420, 0.910) * 0.30 + vec3(0.706, 0.361, 1.0) * 0.25;',
    '  vec3 hotCol = vec3(1.0, 0.361, 0.620) + vec3(0.949, 0.847, 0.361) * 0.5 * sin(uTime * 3.0);',
    '  eyeCol = mix(eyeCol, hotCol, p * 0.5);',
    '  float egAmp = 0.34 * p * uEyeOn;',
    '  dye.rgb += eyeCol * eg * egAmp;',
    '  dye.a   += eg * egAmp;',

    '  gl_FragColor = clamp(dye,0.0,1.0);',
    '}'
  ].join('\n');

  /* 显示片元：把染料场化成透明叠加色，低浓度压淡、高浓度显色。
     边缘梯度增强 + 颗粒噪点借鉴 johnowhitaker/inkwash displayFS（MIT 思路：
     邻域梯度拉墨边、双八度 fbm 做纸纹颗粒），WebGL1 移植 */
  var SHOW = [
    'precision mediump float;',
    'varying vec2 vUv;',
    'uniform sampler2D uTex;',
    'uniform float uEnergy;',
    'uniform vec2 uTexel;',
    'float hash2(vec2 p){',
    '  p = fract(p * vec2(123.34, 456.21));',
    '  p += dot(p, p + 45.32);',
    '  return fract(p.x * p.y);',
    '}',
    'float vnoise2(vec2 p){',
    '  vec2 i = floor(p), f = fract(p);',
    '  vec2 u = f * f * (3.0 - 2.0 * f);',
    '  float a = hash2(i), b = hash2(i + vec2(1.0, 0.0));',
    '  float c = hash2(i + vec2(0.0, 1.0)), d = hash2(i + vec2(1.0, 1.0));',
    '  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);',
    '}',
    'float fbm2(vec2 p){',
    '  float v = 0.0, amp = 0.5;',
    '  for (int k = 0; k < 4; k++){ v += amp * vnoise2(p); p *= 2.07; amp *= 0.5; }',
    '  return v;',
    '}',
    'void main(){',
    '  vec4 dye = texture2D(uTex, vUv);',
    '  vec4 L = texture2D(uTex, vUv - vec2(uTexel.x, 0.0));',
    '  vec4 R = texture2D(uTex, vUv + vec2(uTexel.x, 0.0));',
    '  vec4 B = texture2D(uTex, vUv - vec2(0.0, uTexel.y));',
    '  vec4 T = texture2D(uTex, vUv + vec2(0.0, uTexel.y));',
    '  float edge = length(vec2(R.r - L.r, T.g - B.g));',
    '  float lum = dot(dye.rgb, vec3(0.299, 0.587, 0.114));',
    '  dye.rgb = mix(vec3(lum), dye.rgb, 1.10);',
    '  dye.rgb *= 1.05;',
    '  float grain = fbm2(vUv * 120.0);',
    '  dye.rgb *= 1.0 + (grain - 0.5) * 0.18 * clamp(lum * 2.0, 0.0, 1.0);',
    '  dye.rgb *= 1.0 + edge * 0.8;',
    '  /* 廉价 bloom：高浓度墨才进亮部遮罩，四邻域模糊后回叠一层荧光晕开 */',
    '  float br = max(dye.r, max(dye.g, dye.b));',
    '  vec3 bloom = (L.rgb + R.rgb + B.rgb + T.rgb) * 0.25;',
    '  float bmask = smoothstep(0.55, 1.0, br);',
    '  dye.rgb += bloom * bmask * 0.25;',
    '  float a = smoothstep(0.02, 0.34, dye.a);',
    '  a = min(a, 0.60);',
    '  a *= 0.55 + 0.25 * uEnergy;',
    '  gl_FragColor = vec4(dye.rgb * a, a);',
    '}'
  ].join('\n');

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    return s;
  }
  function makeProg(gl, fsSrc) {
    var vs = compile(gl, gl.VERTEX_SHADER, VERT);
    var fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    var fsLog = gl.getShaderInfoLog(fs) || '';
    var linkLog = gl.getProgramInfoLog(prog) || '';
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      prog.__err = fsLog + ' || ' + linkLog;
      return null;
    }
    return prog;
  }

  function OilLayer(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.running = false;
    this.energy = 0.5;
    this.eye = { x: 0.5, y: 0.5, r: 0.2, on: 0, pulse: 0 };
    this._raf = 0;
    this._start = 0;
    this._resize = this.resize.bind(this);
    this.fbos = null;

    var gl = canvas.getContext('webgl', {
      alpha: true, premultipliedAlpha: true, antialias: false,
      preserveDrawingBuffer: false
    }) || canvas.getContext('experimental-webgl', { alpha: true });
    if (!gl) return;
    this.gl = gl;

    this.progFeed = makeProg(gl, FEED);
    this.progShow = makeProg(gl, SHOW);
    this.debug = {
      feed: !!this.progFeed,
      show: !!this.progShow,
      err: (this.progFeed && this.progFeed.__err) || (this.progShow && this.progShow.__err) || ''
    };
    if (!this.progFeed || !this.progShow) { this.gl = null; return; }

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.buf = buf;
    this.locPos = gl.getAttribLocation(this.progFeed, 'aPos');

    this.fU = {
      prev: gl.getUniformLocation(this.progFeed, 'uPrev'),
      texel: gl.getUniformLocation(this.progFeed, 'uTexel'),
      time: gl.getUniformLocation(this.progFeed, 'uTime'),
      energy: gl.getUniformLocation(this.progFeed, 'uEnergy'),
      aspect: gl.getUniformLocation(this.progFeed, 'uAspect'),
      eye: gl.getUniformLocation(this.progFeed, 'uEye'),
      eyeR: gl.getUniformLocation(this.progFeed, 'uEyeR'),
      eyeOn: gl.getUniformLocation(this.progFeed, 'uEyeOn'),
      eyePulse: gl.getUniformLocation(this.progFeed, 'uEyePulse')
    };
    this.sU = {
      tex: gl.getUniformLocation(this.progShow, 'uTex'),
      energy: gl.getUniformLocation(this.progShow, 'uEnergy'),
      texel: gl.getUniformLocation(this.progShow, 'uTexel')
    };

    gl.clearColor(0, 0, 0, 0);
    this.resize();
    window.addEventListener('resize', this._resize);
    this.running = true;
    this._start = performance.now();
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  function makeFBO(gl, w, h) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex: tex, fbo: fbo, w: w, h: h };
  }

  OilLayer.prototype.resize = function () {
    if (!this.gl) return;
    var gl = this.gl;
    var dpr = Math.min(1.25, global.devicePixelRatio || 1);
    var w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
    var h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    if (!this.fbos || this.fbos.a.w !== w || this.fbos.a.h !== h) {
      this.fbos = { a: makeFBO(gl, w, h), b: makeFBO(gl, w, h) };
    }
    gl.viewport(0, 0, w, h);
  };

  OilLayer.prototype.setEnergy = function (v) { this.energy = clamp01(v); };

  /* 无头探针：回读染料场平均/峰值，供自检判断编译与墨量 */
  OilLayer.prototype.probe = function () {
    if (!this.gl || !this.fbos) return { ok: false, debug: this.debug };
    var gl = this.gl, w = this.canvas.width, h = this.canvas.height;
    var buf = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos.b.fbo);
    var fboStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    var r = 0, g = 0, b = 0, a = 0, maxA = 0;
    for (var i = 0; i < w * h; i++) {
      var k = i * 4;
      r += buf[k]; g += buf[k + 1]; b += buf[k + 2]; a += buf[k + 3];
      if (buf[k + 3] > maxA) maxA = buf[k + 3];
    }
    var n = w * h;
    var b0 = 0, b1 = 0, b2 = 0;
    var px = function (fx, fy) {
      var x = Math.min(w - 1, Math.max(0, Math.floor(fx * w)));
      var y = Math.min(h - 1, Math.max(0, Math.floor(fy * h)));
      var k = (y * w + x) * 4;
      return [buf[k], buf[k + 1], buf[k + 2], buf[k + 3]];
    };
    for (var q = 0; q < n; q++) {
      var aq = buf[q * 4 + 3];
      if (aq > 30) b1++;
      if (aq > 120) b2++;
      if (aq > 3) b0++;
    }
    return { ok: true, w: w, h: h, avgR: Math.round(r / n), avgG: Math.round(g / n),
      avgB: Math.round(b / n), avgA: Math.round(a / n), maxA: maxA,
      locPos: this.locPos,
      feedCompiled: this.progFeed ? gl.getProgramParameter(this.progFeed, gl.LINK_STATUS) : false,
      cover3: Math.round(100 * b0 / n), cover30: Math.round(100 * b1 / n),
      cover120: Math.round(100 * b2 / n),
      center: px(0.5, 0.5), corner: px(0.05, 0.05),
      fboStatus: fboStatus === gl.FRAMEBUFFER_COMPLETE ? 'complete' : ('status_' + fboStatus),
      debug: this.debug };
  };

  OilLayer.prototype.setEye = function (nx, ny, nr, on, pulse) {
    this.eye.x = nx; this.eye.y = ny; this.eye.r = nr; this.eye.on = on ? 1 : 0;
    this.eye.pulse = clamp01(pulse || 0);
  };

  /* 按需启停：对局外 / 墨水特效关闭时暂停反馈模拟，释放 GPU；恢复时接着上一帧染料场继续 */
  OilLayer.prototype.setActive = function (on) {
    on = !!on;
    if (on === this.running) return;
    this.running = on;
    if (on) {
      this._start = performance.now();
      this._raf = requestAnimationFrame(this._loop);
    } else {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
  };

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  OilLayer.prototype._loop = function () {
    if (!this.running) return;
    var gl = this.gl;
    this.resize();
    var t = (performance.now() - this._start) / 1000;
    var w = this.canvas.width, h = this.canvas.height;
    var fbos = this.fbos;

    /* 1) 反馈扩散：读 a → 写 b */
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbos.b.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.progFeed);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(this.locPos);
    gl.vertexAttribPointer(this.locPos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fbos.a.tex);
    gl.uniform1i(this.fU.prev, 0);
    gl.uniform2f(this.fU.texel, 1 / w, 1 / h);
    gl.uniform1f(this.fU.time, t);
    gl.uniform1f(this.fU.energy, this.energy);
    gl.uniform1f(this.fU.aspect, w / h);
    gl.uniform2f(this.fU.eye, this.eye.x, this.eye.y);
    gl.uniform1f(this.fU.eyeR, this.eye.r);
    gl.uniform1f(this.fU.eyeOn, this.eye.on);
    gl.uniform1f(this.fU.eyePulse, this.eye.pulse);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    /* 2) 显示：把 b 贴到屏幕 */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.progShow);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(this.locPos);
    gl.vertexAttribPointer(this.locPos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fbos.b.tex);
    gl.uniform1i(this.sU.tex, 0);
    gl.uniform1f(this.sU.energy, this.energy);
    gl.uniform2f(this.sU.texel, 1 / w, 1 / h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    /* 交换 */
    var tmp = fbos.a; fbos.a = fbos.b; fbos.b = tmp;

    this._raf = requestAnimationFrame(this._loop);
  };

  OilLayer.prototype.destroy = function () {
    this.running = false;
    cancelAnimationFrame(this._raf);
    if (this.gl) window.removeEventListener('resize', this._resize);
  };

  function init() {
    if (typeof document === 'undefined') return;
    var cv = document.getElementById('oil');
    if (!cv) return;
    global.OilLayer = new OilLayer(cv);
  }

  if (typeof document !== 'undefined' && document.readyState !== 'loading') init();
  else if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);

  global.OilLayer = global.OilLayer || null;
})(window);
