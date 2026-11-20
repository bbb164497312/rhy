/* WebGL 流体层，忠实移植自开源 WebGL-Fluid-Simulation（pavel）：速度场 FBO 跑旋度→涡量约束→
   散度→压力迭代→梯度回减→平流，染料沿速度场卷走混色，外加多级 bloom 与抖动颗粒。
   仅剥离壁纸引擎外壳、鼠标/触摸/GUI/音频监听；注入改为两个规律往复的虚拟指针，
   速度判定照搬原件 pointermove（本帧像素位移 ×5）。GLSL 为 ES 1.00 风格，webgl2 优先、回退 webgl1。 */
(function (global) {
  'use strict';

  /* 主注入双色：品红 + 青（对齐 r3 MV 锚定色，去橙） */
  var RED = [1.0, 0.361, 0.620];
  var BLUE = [0.204, 0.780, 0.745];

  /* r3 MV 调色板（去橙）：品红 / 青 / 蓝 / 紫 / 薄荷 / 亮粉，随机撒点只从这套取色 */
  var PALETTE = [
    [1.000, 0.361, 0.620],
    [0.204, 0.780, 0.745],
    [0.227, 0.420, 0.910],
    [0.706, 0.361, 1.000],
    [0.561, 0.878, 0.416],
    [0.910, 0.267, 0.561]
  ];

  function generateColor() {
    var c = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    return [c[0] * 0.15, c[1] * 0.15, c[2] * 0.15];
  }

  function FluidLayer(canvas) {
    this.canvas = canvas;
    this.pulse = 0;
    this.strength = 1;
    this.ok = false;
    this._last = 0;
    this._raf = 0;
    /* 两个虚拟指针：复刻原件 pointermove 的“本帧像素位移 ×5”速度判定 */
    this._ptr = {
      red:  { x: 0, y: 0, lx: 0, ly: 0, dx: 0, dy: 0, t: 0 },
      blue: { x: 0, y: 0, lx: 0, ly: 0, dx: 0, dy: 0, t: 0 }
    };

    var ctx = this._createContext(canvas);
    if (!ctx) return;
    this.gl = ctx.gl;
    this.ext = ctx.ext;

    var gl = this.gl;
    this.config = {
      SIM_RESOLUTION: 192,
      DYE_RESOLUTION: 512,
      DENSITY_DISSIPATION: 0.97,
      VELOCITY_DISSIPATION: 0.98,
      PRESSURE_DISSIPATION: 0.8,
      PRESSURE_ITERATIONS: 12,
      CURL: 30,
      SPLAT_RADIUS: 0.24,
      SHADING: true,
      COLORFUL: true,
      PAUSED: false,
      TRANSPARENT: true,
      BLOOM: true,
      BLOOM_ITERATIONS: 2,
      BLOOM_RESOLUTION: 256,
      BLOOM_INTENSITY: 0.7,
      BLOOM_THRESHOLD: 0.6,
      BLOOM_SOFT_KNEE: 0.7
    };
    if (!this.ext.supportLinearFiltering) {
      this.config.SHADING = false;
      this.config.BLOOM = false;
    }

    this._compile();
    this._initFramebuffers();
    this._seed();

    this.ok = true;
    this.active = true;
    this._raf = 0;
    var self = this;
    this._loop = function (ts) { self.frame(ts); };
    this._raf = requestAnimationFrame(this._loop);
  }

  /* ---------- 上下文与纹理格式（照搬 getWebGLContext，去掉壁纸属性） ---------- */

  FluidLayer.prototype._createContext = function (canvas) {
    var gl = canvas.getContext('webgl2', { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false });
    var isWebGL2 = !!gl;
    if (!isWebGL2)
      gl = canvas.getContext('webgl', { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false })
        || canvas.getContext('experimental-webgl', { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false });
    if (!gl) return null;

    var halfFloat = gl.getExtension('OES_texture_half_float');
    var supportLinear, rgba, type;
    if (isWebGL2) {
      gl.getExtension('EXT_color_buffer_float');
      supportLinear = gl.getExtension('OES_texture_float_linear');
      type = gl.HALF_FLOAT;
      rgba = this._testFormat(gl, gl.RGBA16F, gl.RGBA, type);
      if (!rgba) { type = gl.UNSIGNED_BYTE; rgba = this._testFormat(gl, gl.RGBA, gl.RGBA, type); }
    } else {
      supportLinear = gl.getExtension('OES_texture_half_float_linear');
      type = halfFloat ? halfFloat.HALF_FLOAT_OES : gl.UNSIGNED_BYTE;
      rgba = this._testFormat(gl, gl.RGBA, gl.RGBA, type);
      if (!rgba) { type = gl.UNSIGNED_BYTE; rgba = this._testFormat(gl, gl.RGBA, gl.RGBA, type); }
    }
    if (!rgba) return null;
    gl.clearColor(0.0, 0.0, 0.0, 1.0);

    return {
      gl: gl,
      ext: {
        formatRGBA: rgba,
        halfFloatTexType: type,
        supportLinearFiltering: !!supportLinear
      }
    };
  };

  FluidLayer.prototype._testFormat = function (gl, internalFormat, format, type) {
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.deleteTexture(texture);
    gl.deleteFramebuffer(fbo);
    if (!ok) return null;
    return { internalFormat: internalFormat, format: format };
  };

  /* ---------- 着色器程序 ---------- */

  FluidLayer.prototype._compile = function () {
    var gl = this.gl;
    var self = this;

    function compileShader(type, source) {
      var shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw gl.getShaderInfoLog(shader);
      return shader;
    }

    function GLProgram(vs, fs) {
      this.uniforms = {};
      this.program = gl.createProgram();
      gl.attachShader(this.program, vs);
      gl.attachShader(this.program, fs);
      gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
        throw gl.getProgramInfoLog(this.program);
      var count = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
      for (var i = 0; i < count; i++) {
        var name = gl.getActiveUniform(this.program, i).name;
        this.uniforms[name] = gl.getUniformLocation(this.program, name);
      }
    }
    GLProgram.prototype.bind = function () { gl.useProgram(this.program); };
    this.GLProgram = GLProgram;

    var baseVS = compileShader(gl.VERTEX_SHADER, [
      'precision highp float;',
      'attribute vec2 aPosition;',
      'varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;',
      'uniform vec2 texelSize;',
      'void main () {',
      '  vUv = aPosition * 0.5 + 0.5;',
      '  vL = vUv - vec2(texelSize.x, 0.0); vR = vUv + vec2(texelSize.x, 0.0);',
      '  vT = vUv + vec2(0.0, texelSize.y); vB = vUv - vec2(0.0, texelSize.y);',
      '  gl_Position = vec4(aPosition, 0.0, 1.0);',
      '}'
    ].join('\n'));

    var clearFS = compileShader(gl.FRAGMENT_SHADER, [
      'precision mediump float; precision mediump sampler2D;',
      'varying highp vec2 vUv; uniform sampler2D uTexture; uniform float value;',
      'void main () { gl_FragColor = value * texture2D(uTexture, vUv); }'
    ].join('\n'));

    var colorFS = compileShader(gl.FRAGMENT_SHADER, [
      'precision mediump float; uniform vec4 color;',
      'void main () { gl_FragColor = color; }'
    ].join('\n'));

    var backgroundFS = compileShader(gl.FRAGMENT_SHADER, [
      'void main () { gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0); }'
    ].join('\n'));

    var displayFS = compileShader(gl.FRAGMENT_SHADER, [
      'precision highp float; precision highp sampler2D;',
      'varying vec2 vUv; uniform sampler2D uTexture;',
      'void main () {',
      '  vec3 C = texture2D(uTexture, vUv).rgb;',
      '  float a = max(C.r, max(C.g, C.b));',
      '  float mask = smoothstep(0.14, 0.42, a);',
      '  gl_FragColor = vec4(C * mask, a * mask);',
      '}'
    ].join('\n'));

    var displayBloomFS = compileShader(gl.FRAGMENT_SHADER, [
      'precision highp float; precision highp sampler2D;',
      'varying vec2 vUv; uniform sampler2D uTexture; uniform sampler2D uBloom; uniform sampler2D uDithering; uniform vec2 ditherScale;',
      'void main () {',
      '  vec3 C = texture2D(uTexture, vUv).rgb;',
      '  vec3 bloom = texture2D(uBloom, vUv).rgb;',
      '  vec3 noise = texture2D(uDithering, vUv * ditherScale).rgb;',
      '  noise = noise * 2.0 - 1.0; bloom += noise / 800.0; bloom = pow(bloom.rgb, vec3(1.0 / 2.2)); C += bloom;',
      '  float a = max(C.r, max(C.g, C.b)); gl_FragColor = vec4(C, a);',
      '}'
    ].join('\n'));

    var displayShadingFS = compileShader(gl.FRAGMENT_SHADER, [
      'precision highp float; precision highp sampler2D;',
      'varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;',
      'uniform sampler2D uTexture; uniform vec2 texelSize;',
      'void main () {',
      '  vec3 L = texture2D(uTexture, vL).rgb; vec3 R = texture2D(uTexture, vR).rgb;',
      '  vec3 T = texture2D(uTexture, vT).rgb; vec3 B = texture2D(uTexture, vB).rgb;',
      '  vec3 C = texture2D(uTexture, vUv).rgb;',
      '  float dx = length(R) - length(L); float dy = length(T) - length(B);',
      '  vec3 n = normalize(vec3(dx, dy, length(texelSize))); vec3 l = vec3(0.0, 0.0, 1.0);',
      '  float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0); C.rgb *= diffuse;',
      '  float a = max(C.r, max(C.g, C.b)); gl_FragColor = vec4(C, a);',
      '}'
    ].join('\n'));

    var displayBloomShadingFS = compileShader(gl.FRAGMENT_SHADER, [
      'precision highp float; precision highp sampler2D;',
      'varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;',
      'uniform sampler2D uTexture; uniform sampler2D uBloom; uniform sampler2D uDithering; uniform vec2 ditherScale; uniform vec2 texelSize;',
      'void main () {',
      '  vec3 L = texture2D(uTexture, vL).rgb; vec3 R = texture2D(uTexture, vR).rgb;',
      '  vec3 T = texture2D(uTexture, vT).rgb; vec3 B = texture2D(uTexture, vB).rgb;',
      '  vec3 C = texture2D(uTexture, vUv).rgb;',
      '  float dx = length(R) - length(L); float dy = length(T) - length(B);',
      '  vec3 n = normalize(vec3(dx, dy, length(texelSize))); vec3 l = vec3(0.0, 0.0, 1.0);',
      '  float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0); C.rgb *= diffuse;',
      '  vec3 bloom = texture2D(uBloom, vUv).rgb;',
      '  vec3 noise = texture2D(uDithering, vUv * ditherScale).rgb;',
      '  noise = noise * 2.0 - 1.0; bloom += noise / 800.0; bloom = pow(bloom.rgb, vec3(1.0 / 2.2)); C += bloom;',
      '  float a = max(C.r, max(C.g, C.b)); gl_FragColor = vec4(C, a);',
      '}'
    ].join('\n'));

    var splatFS = compileShader(gl.FRAGMENT_SHADER, [
      'precision highp float; precision highp sampler2D;',
      'varying vec2 vUv; uniform sampler2D uTarget; uniform float aspectRatio;',
      'uniform vec3 color; uniform vec2 point; uniform float radius;',
      'void main () {',
      '  vec2 p = vUv - point.xy; p.x *= aspectRatio;',
      '  vec3 splat = exp(-dot(p, p) / radius) * color;',
      '  vec3 base = texture2D(uTarget, vUv).xyz;',
      '  gl_FragColor = vec4(base + splat, 1.0);',
      '}'
    ].join('\n'));

    var advFS = compileShader(gl.FRAGMENT_SHADER, [
      'precision highp float; precision highp sampler2D;',
      'varying vec2 vUv; uniform sampler2D uVelocity; uniform sampler2D uSource;',
      'uniform vec2 texelSize; uniform vec2 dyeTexelSize; uniform float dt; uniform float dissipation;',
      'void main () {',
      '  vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;',
      '  gl_FragColor = dissipation * texture2D(uSource, coord); gl_FragColor.a = 1.0;',
      '}'
    ].join('\n'));

    var advManualFS = compileShader(gl.FRAGMENT_SHADER, [
      'precision highp float; precision highp sampler2D;',
      'varying vec2 vUv; uniform sampler2D uVelocity; uniform sampler2D uSource;',
      'uniform vec2 texelSize; uniform vec2 dyeTexelSize; uniform float dt; uniform float dissipation;',
      'vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {',
      '  vec2 st = uv / tsize - 0.5; vec2 iuv = floor(st); vec2 fuv = fract(st);',
      '  vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);',
      '  vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);',
      '  vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);',
      '  vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);',
      '  return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);',
      '}',
      'void main () {',
      '  vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;',
      '  gl_FragColor = dissipation * bilerp(uSource, coord, dyeTexelSize); gl_FragColor.a = 1.0;',
      '}'
    ].join('\n'));

    var divergenceFS = compileShader(gl.FRAGMENT_SHADER, [
      'precision mediump float; precision mediump sampler2D;',
      'varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB;',
      'uniform sampler2D uVelocity;',
      'void main () {',
      '  float L = texture2D(uVelocity, vL).x; float R = texture2D(uVelocity, vR).x;',
      '  float T = texture2D(uVelocity, vT).y; float B = texture2D(uVelocity, vB).y;',
      '  vec2 C = texture2D(uVelocity, vUv).xy;',
      '  if (vL.x < 0.0) { L = -C.x; } if (vR.x > 1.0) { R = -C.x; }',
      '  if (vT.y > 1.0) { T = -C.y; } if (vB.y < 0.0) { B = -C.y; }',
      '  float div = 0.5 * (R - L + T - B); gl_FragColor = vec4(div, 0.0, 0.0, 1.0);',
      '}'
    ].join('\n'));

    var curlFS = compileShader(gl.FRAGMENT_SHADER, [
      'precision mediump float; precision mediump sampler2D;',
      'varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB;',
      'uniform sampler2D uVelocity;',
      'void main () {',
      '  float L = texture2D(uVelocity, vL).y; float R = texture2D(uVelocity, vR).y;',
      '  float T = texture2D(uVelocity, vT).x; float B = texture2D(uVelocity, vB).x;',
      '  float vorticity = R - L - T + B; gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);',
      '}'
    ].join('\n'));

    var vorticityFS = compileShader(gl.FRAGMENT_SHADER, [
      'precision highp float; precision highp sampler2D;',
      'varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;',
      'uniform sampler2D uVelocity; uniform sampler2D uCurl; uniform float curl; uniform float dt;',
      'void main () {',
      '  float L = texture2D(uCurl, vL).x; float R = texture2D(uCurl, vR).x;',
      '  float T = texture2D(uCurl, vT).x; float B = texture2D(uCurl, vB).x;',
      '  float C = texture2D(uCurl, vUv).x;',
      '  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));',
      '  force /= length(force) + 0.0001; force *= curl * C; force.y *= -1.0;',
      '  vec2 vel = texture2D(uVelocity, vUv).xy; gl_FragColor = vec4(vel + force * dt, 0.0, 1.0);',
      '}'
    ].join('\n'));

    var pressureFS = compileShader(gl.FRAGMENT_SHADER, [
      'precision mediump float; precision mediump sampler2D;',
      'varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB;',
      'uniform sampler2D uPressure; uniform sampler2D uDivergence;',
      'void main () {',
      '  float L = texture2D(uPressure, vL).x; float R = texture2D(uPressure, vR).x;',
      '  float T = texture2D(uPressure, vT).x; float B = texture2D(uPressure, vB).x;',
      '  float C = texture2D(uPressure, vUv).x;',
      '  float divergence = texture2D(uDivergence, vUv).x;',
      '  float pressure = (L + R + B + T - divergence) * 0.25;',
      '  gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);',
      '}'
    ].join('\n'));

    var gradientFS = compileShader(gl.FRAGMENT_SHADER, [
      'precision mediump float; precision mediump sampler2D;',
      'varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;',
      'uniform sampler2D uPressure; uniform sampler2D uVelocity;',
      'void main () {',
      '  float L = texture2D(uPressure, vL).x; float R = texture2D(uPressure, vR).x;',
      '  float T = texture2D(uPressure, vT).x; float B = texture2D(uPressure, vB).x;',
      '  vec2 velocity = texture2D(uVelocity, vUv).xy;',
      '  velocity.xy -= vec2(R - L, T - B); gl_FragColor = vec4(velocity, 0.0, 1.0);',
      '}'
    ].join('\n'));

    var bloomPreFS = compileShader(gl.FRAGMENT_SHADER, [
      'precision mediump float; precision mediump sampler2D;',
      'varying vec2 vUv; uniform sampler2D uTexture; uniform vec3 curve; uniform float threshold;',
      'void main () {',
      '  vec3 c = texture2D(uTexture, vUv).rgb; float br = max(c.r, max(c.g, c.b));',
      '  float rq = clamp(br - curve.x, 0.0, curve.y); rq = curve.z * rq * rq;',
      '  c *= max(rq, br - threshold) / max(br, 0.0001); gl_FragColor = vec4(c, 0.0);',
      '}'
    ].join('\n'));

    var bloomBlurFS = compileShader(gl.FRAGMENT_SHADER, [
      'precision mediump float; precision mediump sampler2D;',
      'varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB; uniform sampler2D uTexture;',
      'void main () {',
      '  vec4 sum = vec4(0.0);',
      '  sum += texture2D(uTexture, vL); sum += texture2D(uTexture, vR);',
      '  sum += texture2D(uTexture, vT); sum += texture2D(uTexture, vB);',
      '  sum *= 0.25; gl_FragColor = sum;',
      '}'
    ].join('\n'));

    var bloomFinalFS = compileShader(gl.FRAGMENT_SHADER, [
      'precision mediump float; precision mediump sampler2D;',
      'varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB; uniform sampler2D uTexture; uniform float intensity;',
      'void main () {',
      '  vec4 sum = vec4(0.0);',
      '  sum += texture2D(uTexture, vL); sum += texture2D(uTexture, vR);',
      '  sum += texture2D(uTexture, vT); sum += texture2D(uTexture, vB);',
      '  sum *= 0.25; gl_FragColor = sum * intensity;',
      '}'
    ].join('\n'));

    this.clearProgram               = new GLProgram(baseVS, clearFS);
    this.colorProgram               = new GLProgram(baseVS, colorFS);
    this.backgroundProgram          = new GLProgram(baseVS, backgroundFS);
    this.displayProgram             = new GLProgram(baseVS, displayFS);
    this.displayBloomProgram        = new GLProgram(baseVS, displayBloomFS);
    this.displayShadingProgram      = new GLProgram(baseVS, displayShadingFS);
    this.displayBloomShadingProgram = new GLProgram(baseVS, displayBloomShadingFS);
    this.bloomPrefilterProgram      = new GLProgram(baseVS, bloomPreFS);
    this.bloomBlurProgram           = new GLProgram(baseVS, bloomBlurFS);
    this.bloomFinalProgram          = new GLProgram(baseVS, bloomFinalFS);
    this.splatProgram               = new GLProgram(baseVS, splatFS);
    this.advectionProgram           = new GLProgram(baseVS, this.ext.supportLinearFiltering ? advFS : advManualFS);
    this.divergenceProgram          = new GLProgram(baseVS, divergenceFS);
    this.curlProgram                = new GLProgram(baseVS, curlFS);
    this.vorticityProgram           = new GLProgram(baseVS, vorticityFS);
    this.pressureProgram            = new GLProgram(baseVS, pressureFS);
    this.gradientSubtractProgram    = new GLProgram(baseVS, gradientFS);

    /* 共用全屏三角形/矩形缓冲（照搬 blit 初始化） */
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    this.ditheringTexture = this._createDitherTexture();
  };

  /* 程序化 4x4 抖动颗粒，避免依赖外部 LDR_RGB1_0.png */
  FluidLayer.prototype._createDitherTexture = function () {
    var gl = this.gl;
    var size = 4;
    var data = new Uint8Array(size * size * 4);
    for (var i = 0; i < size * size; i++) {
      data[i * 4] = Math.floor(Math.random() * 255);
      data[i * 4 + 1] = Math.floor(Math.random() * 255);
      data[i * 4 + 2] = Math.floor(Math.random() * 255);
      data[i * 4 + 3] = 255;
    }
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { texture: texture, width: size, height: size,
      attach: function (id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; } };
  };

  /* ---------- 帧缓冲 ---------- */

  FluidLayer.prototype._createFBO = function (w, h, internalFormat, format, type, param) {
    var gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      texture: texture, fbo: fbo, width: w, height: h,
      attach: function (id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; }
    };
  };

  FluidLayer.prototype._createDoubleFBO = function (w, h, internalFormat, format, type, param) {
    var fbo1 = this._createFBO(w, h, internalFormat, format, type, param);
    var fbo2 = this._createFBO(w, h, internalFormat, format, type, param);
    var self = this;
    return {
      get read() { return fbo1; },
      set read(v) { fbo1 = v; },
      get write() { return fbo2; },
      set write(v) { fbo2 = v; },
      swap: function () { var t = fbo1; fbo1 = fbo2; fbo2 = t; }
    };
  };

  FluidLayer.prototype._resizeFBO = function (target, w, h, internalFormat, format, type, param) {
    var gl = this.gl;
    var nf = this._createFBO(w, h, internalFormat, format, type, param);
    this.clearProgram.bind();
    gl.uniform1i(this.clearProgram.uniforms.uTexture, target.attach(0));
    gl.uniform1f(this.clearProgram.uniforms.value, 1);
    this._blit(nf.fbo);
    return nf;
  };

  FluidLayer.prototype._resizeDoubleFBO = function (target, w, h, internalFormat, format, type, param) {
    target.read = this._resizeFBO(target.read, w, h, internalFormat, format, type, param);
    target.write = this._createFBO(w, h, internalFormat, format, type, param);
    return target;
  };

  FluidLayer.prototype._initFramebuffers = function () {
    var gl = this.gl;
    var simRes = this._getResolution(this.config.SIM_RESOLUTION);
    var dyeRes = this._getResolution(this.config.DYE_RESOLUTION);
    this.simWidth = simRes.width; this.simHeight = simRes.height;
    this.dyeWidth = dyeRes.width; this.dyeHeight = dyeRes.height;

    var texType = this.ext.halfFloatTexType;
    var rgba = this.ext.formatRGBA;
    var filtering = this.ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

    if (this.density == null)
      this.density = this._createDoubleFBO(this.dyeWidth, this.dyeHeight, rgba.internalFormat, rgba.format, texType, filtering);
    else
      this.density = this._resizeDoubleFBO(this.density, this.dyeWidth, this.dyeHeight, rgba.internalFormat, rgba.format, texType, filtering);

    if (this.velocity == null)
      this.velocity = this._createDoubleFBO(this.simWidth, this.simHeight, rgba.internalFormat, rgba.format, texType, filtering);
    else
      this.velocity = this._resizeDoubleFBO(this.velocity, this.simWidth, this.simHeight, rgba.internalFormat, rgba.format, texType, filtering);

    this.divergence = this._createFBO(this.simWidth, this.simHeight, rgba.internalFormat, rgba.format, texType, gl.NEAREST);
    this.curl = this._createFBO(this.simWidth, this.simHeight, rgba.internalFormat, rgba.format, texType, gl.NEAREST);
    this.pressure = this._createDoubleFBO(this.simWidth, this.simHeight, rgba.internalFormat, rgba.format, texType, gl.NEAREST);

    this._initBloomFramebuffers();
  };

  FluidLayer.prototype._initBloomFramebuffers = function () {
    var gl = this.gl;
    var res = this._getResolution(this.config.BLOOM_RESOLUTION);
    var texType = this.ext.halfFloatTexType;
    var rgba = this.ext.formatRGBA;
    var filtering = this.ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
    this.bloom = this._createFBO(res.width, res.height, rgba.internalFormat, rgba.format, texType, filtering);
    this.bloomFramebuffers = [];
    for (var i = 0; i < this.config.BLOOM_ITERATIONS; i++) {
      var width = res.width >> (i + 1);
      var height = res.height >> (i + 1);
      if (width < 2 || height < 2) break;
      this.bloomFramebuffers.push(this._createFBO(width, height, rgba.internalFormat, rgba.format, texType, filtering));
    }
  };

  FluidLayer.prototype._blit = function (destination) {
    var gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, destination);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  };

  FluidLayer.prototype._getResolution = function (resolution) {
    var gl = this.gl;
    var aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspectRatio < 1) aspectRatio = 1.0 / aspectRatio;
    var max = Math.round(resolution * aspectRatio);
    var min = Math.round(resolution);
    if (gl.drawingBufferWidth > gl.drawingBufferHeight) return { width: max, height: min };
    return { width: min, height: max };
  };

  FluidLayer.prototype._getTextureScale = function (texture, width, height) {
    return { x: width / texture.width, y: height / texture.height };
  };

  /* ---------- 求解步（照搬 step） ---------- */

  FluidLayer.prototype._step = function (dt) {
    var gl = this.gl;
    var cfg = this.config;
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, this.simWidth, this.simHeight);

    this.curlProgram.bind();
    gl.uniform2f(this.curlProgram.uniforms.texelSize, 1.0 / this.simWidth, 1.0 / this.simHeight);
    gl.uniform1i(this.curlProgram.uniforms.uVelocity, this.velocity.read.attach(0));
    this._blit(this.curl.fbo);

    this.vorticityProgram.bind();
    gl.uniform2f(this.vorticityProgram.uniforms.texelSize, 1.0 / this.simWidth, 1.0 / this.simHeight);
    gl.uniform1i(this.vorticityProgram.uniforms.uVelocity, this.velocity.read.attach(0));
    gl.uniform1i(this.vorticityProgram.uniforms.uCurl, this.curl.attach(1));
    gl.uniform1f(this.vorticityProgram.uniforms.curl, cfg.CURL);
    gl.uniform1f(this.vorticityProgram.uniforms.dt, dt);
    this._blit(this.velocity.write.fbo);
    this.velocity.swap();

    this.divergenceProgram.bind();
    gl.uniform2f(this.divergenceProgram.uniforms.texelSize, 1.0 / this.simWidth, 1.0 / this.simHeight);
    gl.uniform1i(this.divergenceProgram.uniforms.uVelocity, this.velocity.read.attach(0));
    this._blit(this.divergence.fbo);

    this.clearProgram.bind();
    gl.uniform1i(this.clearProgram.uniforms.uTexture, this.pressure.read.attach(0));
    gl.uniform1f(this.clearProgram.uniforms.value, cfg.PRESSURE_DISSIPATION);
    this._blit(this.pressure.write.fbo);
    this.pressure.swap();

    this.pressureProgram.bind();
    gl.uniform2f(this.pressureProgram.uniforms.texelSize, 1.0 / this.simWidth, 1.0 / this.simHeight);
    gl.uniform1i(this.pressureProgram.uniforms.uDivergence, this.divergence.attach(0));
    for (var i = 0; i < cfg.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(this.pressureProgram.uniforms.uPressure, this.pressure.read.attach(1));
      this._blit(this.pressure.write.fbo);
      this.pressure.swap();
    }

    this.gradientSubtractProgram.bind();
    gl.uniform2f(this.gradientSubtractProgram.uniforms.texelSize, 1.0 / this.simWidth, 1.0 / this.simHeight);
    gl.uniform1i(this.gradientSubtractProgram.uniforms.uPressure, this.pressure.read.attach(0));
    gl.uniform1i(this.gradientSubtractProgram.uniforms.uVelocity, this.velocity.read.attach(1));
    this._blit(this.velocity.write.fbo);
    this.velocity.swap();

    this.advectionProgram.bind();
    gl.uniform2f(this.advectionProgram.uniforms.texelSize, 1.0 / this.simWidth, 1.0 / this.simHeight);
    if (!this.ext.supportLinearFiltering)
      gl.uniform2f(this.advectionProgram.uniforms.dyeTexelSize, 1.0 / this.simWidth, 1.0 / this.simHeight);
    var velocityId = this.velocity.read.attach(0);
    gl.uniform1i(this.advectionProgram.uniforms.uVelocity, velocityId);
    gl.uniform1i(this.advectionProgram.uniforms.uSource, velocityId);
    gl.uniform1f(this.advectionProgram.uniforms.dt, dt);
    gl.uniform1f(this.advectionProgram.uniforms.dissipation, cfg.VELOCITY_DISSIPATION);
    this._blit(this.velocity.write.fbo);
    this.velocity.swap();

    gl.viewport(0, 0, this.dyeWidth, this.dyeHeight);
    if (!this.ext.supportLinearFiltering)
      gl.uniform2f(this.advectionProgram.uniforms.dyeTexelSize, 1.0 / this.dyeWidth, 1.0 / this.dyeHeight);
    gl.uniform1i(this.advectionProgram.uniforms.uVelocity, this.velocity.read.attach(0));
    gl.uniform1i(this.advectionProgram.uniforms.uSource, this.density.read.attach(1));
    gl.uniform1f(this.advectionProgram.uniforms.dissipation, cfg.DENSITY_DISSIPATION);
    this._blit(this.density.write.fbo);
    this.density.swap();
  };

  /* ---------- 注入 ---------- */

  FluidLayer.prototype._splat = function (x, y, dx, dy, color) {
    var gl = this.gl;
    var canvas = this.canvas;
    gl.viewport(0, 0, this.simWidth, this.simHeight);
    this.splatProgram.bind();
    gl.uniform1i(this.splatProgram.uniforms.uTarget, this.velocity.read.attach(0));
    gl.uniform1f(this.splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(this.splatProgram.uniforms.point, x / canvas.width, 1.0 - y / canvas.height);
    gl.uniform3f(this.splatProgram.uniforms.color, dx, -dy, 1.0);
    gl.uniform1f(this.splatProgram.uniforms.radius, this.config.SPLAT_RADIUS / 100.0);
    this._blit(this.velocity.write.fbo);
    this.velocity.swap();

    gl.viewport(0, 0, this.dyeWidth, this.dyeHeight);
    gl.uniform1i(this.splatProgram.uniforms.uTarget, this.density.read.attach(0));
    gl.uniform3f(this.splatProgram.uniforms.color, color[0], color[1], color[2]);
    this._blit(this.density.write.fbo);
    this.density.swap();
  };

  /* 照抄原件 multipleSplats：全屏随机位置、随机色相、速度 ±500，染料 ×10 */
  FluidLayer.prototype._multipleSplats = function (amount) {
    var w = this.canvas.width, h = this.canvas.height;
    for (var i = 0; i < amount; i++) {
      var col = this.config.COLORFUL ? generateColor() : RED;
      var c = [col[0] * 10.0, col[1] * 10.0, col[2] * 10.0];
      var x = w * Math.random();
      var y = h * Math.random();
      var dx = 1000 * (Math.random() - 0.5);
      var dy = 1000 * (Math.random() - 0.5);
      this._splat(x, y, dx, dy, c);
    }
  };

  /* 两个虚拟指针在画面中段盘绕游走，墨锋在中心区翻卷交融；
     速度判定照搬原件 pointermove：本帧像素位移 ×5。strength 由外部按阶段喂给。 */
  FluidLayer.prototype._autoSplat = function (dt) {
    var w = this.canvas.width, h = this.canvas.height;
    var rp = this._ptr.red, bp = this._ptr.blue;
    var k = this.strength == null ? 1 : this.strength;

    if (!rp._init) {
      rp.x = w * 0.30; rp.y = h * 0.35; rp.lx = rp.x; rp.ly = rp.y;
      bp.x = w * 0.70; bp.y = h * 0.60; bp.lx = bp.x; bp.ly = bp.y;
      rp._init = bp._init = true;
    }

    rp.t += dt; bp.t += dt;
    rp.lx = rp.x; rp.ly = rp.y;
    bp.lx = bp.x; bp.ly = bp.y;

    rp.x = w * (0.30 + 0.18 * Math.sin(rp.t * 0.50));
    rp.y = h * (0.35 + 0.20 * Math.cos(rp.t * 0.37));
    bp.x = w * (0.70 + 0.18 * Math.sin(bp.t * 0.43 + Math.PI));
    bp.y = h * (0.60 + 0.18 * Math.sin(bp.t * 0.31));

    rp.dx = (rp.x - rp.lx) * 5 + 30;
    rp.dy = (rp.y - rp.ly) * 5;
    bp.dx = (bp.x - bp.lx) * 5 - 30;
    bp.dy = (bp.y - bp.ly) * 5;

    var c = 0.50 * k;
    this._splat(rp.x, rp.y, rp.dx, rp.dy, [RED[0] * c, RED[1] * c, RED[2] * c]);
    this._splat(bp.x, bp.y, bp.dx, bp.dy, [BLUE[0] * c, BLUE[1] * c, BLUE[2] * c]);

    /* 节拍脉冲强时再补少量原件随机撒点，维持中段混色 */
    if (this.pulse > 0.35) this._multipleSplats(Math.round(this.pulse * 3 * k));
  };

  FluidLayer.prototype.setStrength = function (v) { this.strength = v; };

  FluidLayer.prototype._seed = function () {
    this._multipleSplats(3);
  };

  /* ---------- 渲染（照搬 render / applyBloom） ---------- */

  FluidLayer.prototype._applyBloom = function (source, destination) {
    var gl = this.gl;
    if (this.bloomFramebuffers.length < 2) return;
    var last = destination;
    gl.disable(gl.BLEND);
    this.bloomPrefilterProgram.bind();
    var knee = this.config.BLOOM_THRESHOLD * this.config.BLOOM_SOFT_KNEE + 0.0001;
    var curve0 = this.config.BLOOM_THRESHOLD - knee;
    var curve1 = knee * 2;
    var curve2 = 0.25 / knee;
    gl.uniform3f(this.bloomPrefilterProgram.uniforms.curve, curve0, curve1, curve2);
    gl.uniform1f(this.bloomPrefilterProgram.uniforms.threshold, this.config.BLOOM_THRESHOLD);
    gl.uniform1i(this.bloomPrefilterProgram.uniforms.uTexture, source.attach(0));
    gl.viewport(0, 0, last.width, last.height);
    this._blit(last.fbo);

    this.bloomBlurProgram.bind();
    for (var i = 0; i < this.bloomFramebuffers.length; i++) {
      var dest = this.bloomFramebuffers[i];
      gl.uniform2f(this.bloomBlurProgram.uniforms.texelSize, 1.0 / last.width, 1.0 / last.height);
      gl.uniform1i(this.bloomBlurProgram.uniforms.uTexture, last.attach(0));
      gl.viewport(0, 0, dest.width, dest.height);
      this._blit(dest.fbo);
      last = dest;
    }

    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.BLEND);
    for (var j = this.bloomFramebuffers.length - 2; j >= 0; j--) {
      var baseTex = this.bloomFramebuffers[j];
      gl.uniform2f(this.bloomBlurProgram.uniforms.texelSize, 1.0 / last.width, 1.0 / last.height);
      gl.uniform1i(this.bloomBlurProgram.uniforms.uTexture, last.attach(0));
      gl.viewport(0, 0, baseTex.width, baseTex.height);
      this._blit(baseTex.fbo);
      last = baseTex;
    }

    gl.disable(gl.BLEND);
    this.bloomFinalProgram.bind();
    gl.uniform2f(this.bloomFinalProgram.uniforms.texelSize, 1.0 / last.width, 1.0 / last.height);
    gl.uniform1i(this.bloomFinalProgram.uniforms.uTexture, last.attach(0));
    gl.uniform1f(this.bloomFinalProgram.uniforms.intensity, this.config.BLOOM_INTENSITY);
    gl.viewport(0, 0, destination.width, destination.height);
    this._blit(destination.fbo);
  };

  FluidLayer.prototype._render = function (target) {
    var gl = this.gl;
    var cfg = this.config;
    if (cfg.BLOOM) this._applyBloom(this.density.read, this.bloom);

    if (target == null || !cfg.TRANSPARENT) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.BLEND);
    } else {
      gl.disable(gl.BLEND);
    }

    var width = target == null ? gl.drawingBufferWidth : this.dyeWidth;
    var height = target == null ? gl.drawingBufferHeight : this.dyeHeight;
    gl.viewport(0, 0, width, height);

    if (!cfg.TRANSPARENT) {
      this.colorProgram.bind();
      gl.uniform4f(this.colorProgram.uniforms.color, 0, 0, 0, 1);
      this._blit(target);
    }

    var program;
    if (cfg.SHADING) program = cfg.BLOOM ? this.displayBloomShadingProgram : this.displayShadingProgram;
    else program = cfg.BLOOM ? this.displayBloomProgram : this.displayProgram;
    program.bind();
    if (cfg.SHADING) gl.uniform2f(program.uniforms.texelSize, 1.0 / width, 1.0 / height);
    gl.uniform1i(program.uniforms.uTexture, this.density.read.attach(0));
    if (cfg.BLOOM) {
      gl.uniform1i(program.uniforms.uBloom, this.bloom.attach(1));
      gl.uniform1i(program.uniforms.uDithering, this.ditheringTexture.attach(2));
      var scale = this._getTextureScale(this.ditheringTexture, width, height);
      gl.uniform2f(program.uniforms.ditherScale, scale.x, scale.y);
    }
    this._blit(target);
  };

  FluidLayer.prototype._resizeCanvas = function () {
    var canvas = this.canvas;
    var w = canvas.clientWidth || window.innerWidth;
    var h = canvas.clientHeight || window.innerHeight;
    if (canvas.width !== Math.floor(w) || canvas.height !== Math.floor(h)) {
      canvas.width = Math.floor(w);
      canvas.height = Math.floor(h);
      this._initFramebuffers();
    }
  };

  FluidLayer.prototype.frame = function (ts) {
    if (!this.ok || !this.active) { this._raf = 0; return; }
    if (!this._last) this._last = ts;
    var dt = Math.min(0.016, (ts - this._last) / 1000 || 0.016);
    this._last = ts;
    this.pulse = Math.max(0, this.pulse - dt / 0.34);

    this._resizeCanvas();
    this._autoSplat(dt);
    if (!this.config.PAUSED) this._step(dt);
    this._render(null);
    var self = this;
    this._raf = requestAnimationFrame(function () { self.frame(performance.now()); });
  };

  /* 按需启停：对局外 / 墨水特效关闭时暂停模拟与渲染，恢复时接着上一帧继续 */
  FluidLayer.prototype.setActive = function (on) {
    on = !!on;
    if (on === this.active) return;
    this.active = on;
    if (on) {
      this._last = 0;
      var self = this;
      this._raf = requestAnimationFrame(function () { self.frame(performance.now()); });
    } else {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
  };

  FluidLayer.prototype.setPulse = function (p) {
    this.pulse = Math.max(this.pulse, p || 0);
  };

  global.FluidLayer = FluidLayer;
})(window);
