/* 游戏核心：判定 + 渲染 + 特效
   判定思路参考 osu!mania：判定线位置固定，音符按"距离命中时刻还剩多少秒"换算屏幕 Y，
   时间基准只认音频时钟，绝不用 requestAnimationFrame 的时间戳。 */

(function (global) {
  'use strict';

  var CFG = {
    LANES: 4,
    BEAT: 60 / 132,
    OFFSET: 0.045,         // 实测第一拍相位，闪频和判定线弹跳都要对齐它，否则音画错位
    APPROACH: 1.20,        // 音符从出现到判定线走的秒数（固定下落式对标 Phigros 默认快落手感；快歌取偏快档约 2.6 拍）
    PERFECT: 0.100,        // ±100ms
    GOOD: 0.215,           // ±215ms
    LATE_GRACE: 0.085,     // 迟到宽容：晚 215~300ms 仍算 GOOD，只有超过才算 MISS
    BOT_EARLY: 0.045,      // 自动打提前量：贴线前 45ms 落键，压在 PERFECT 小窗内
    FLASH_EVERY: 1,        // 每拍都闪（越颠越好）
    FLASH_DUR: 0.13,
    LINE_RATIO: 0.78,      // 判定线高度比例（作为竖屏基准）
    TAIL_START: 95,        // 尾部特效起点：弹窗与贴纸从副歌后段开始飘
    DANCE_FROM: 100.0,     // 「ひとりじゃない」手势段：全程唯一允许整屏闪的区间
    DANCE_TO: 110.0,
    HOLD_MIN_KEEP: 0.30,   // 长条至少按住 30% 就算没断，手机误触早放不再直接判 MISS 断连击
  };

  /* 玻璃色板：从本 MV 取色（青绿 / 品红 / 紫），明度对齐、饱和度压住。
     音符主体一律半透明白玻璃 + 阵营色薄边，不用实色块 */
  var C = {
    left: '#34C7BE',        /* 青色头发（色差残影用） */
    right: '#E8448F',       /* 紫粉脸（色差残影用） */
    leftDeep: '#0F3E44',
    rightDeep: '#3A1640',
    ink: '#120B26',
    magenta: '#B45CFF',
    mint: '#C9EFCF',
    gold: '#E8A24A',
    paper: '#F2ECFF',
    glassHi: 'rgba(255,255,255,0.92)'
  };

  /* 四轨音块：取 MV 缎带彩虹序列 蓝→绿→黄→粉，不再是两半蓝粉 */
  var LANE_COLS = ['#3A6BE8', '#8FE06A', '#F2D85C', '#FF5C9E'];
  var LANE_DEEP = ['#1B2579', '#14524E', '#7A5A1E', '#3A1640'];
  var LANE_TINT = ['58,107,232', '143,224,106', '242,216,92', '255,92,158'];
  /* 背景碎片/几何块/结界的四色，同样取 MV 缎带彩虹 */
  var TONE_RGB = ['255,92,158', '58,107,232', '143,224,106', '242,216,92'];
  /* 前期马卡龙反色轨道套：柔中带饱和，避免叠暗底发灰；粉、婴儿蓝、薰衣草紫、薄荷 */
  var MACARON_LANE_COLS = ['#7FB4FF', '#8FE8C8', '#C9A6FF', '#FF9CCE'];
  var MACARON_LANE_DEEP = ['#2E4A86', '#2A6658', '#5A3A80', '#7A3A66'];
  var MACARON_LANE_TINT = ['127,180,255', '143,232,200', '201,166,255', '255,156,206'];
  var MACARON_TONE_RGB = ['255,92,158', '58,107,232', '143,232,200', '180,92,255'];
  /* 游走墨团 / 垂落色流的 MV 七色：品红、青、蓝、紫、薄荷、亮粉，去掉橙色 */
  var AMBIENT_RGB = ['232,68,143', '52,199,190', '58,90,168', '180,92,255', '201,239,207', '255,92,158', '173,196,255'];
  /* 流光配色：2/3 原 MV 色（去橙），1/3 马卡龙粉/蓝/紫/薄荷 */
  var MV_FLOW = ['232,68,143', '52,199,190', '58,90,168', '180,92,255', '201,239,207', '255,92,158'];
  /* 前期马卡龙流光：柔粉/婴儿蓝/薰衣草紫/薄荷 与 亮粉/宝蓝/霓虹紫 成对穿插，
     柔色给梦幻感、高饱和色撑住不发灰（恢复 v2.86 七色混排） */
  var MACARON_FLOW = ['255,173,208', '255,92,158', '173,196,255', '58,107,232', '210,182,255', '180,92,255', '178,235,225'];
  var WALKER_FLOW = MV_FLOW.concat(MV_FLOW.slice(0, 2), MACARON_FLOW);
  function flowPalette(stage) { return stage && stage.oil >= 0.5 ? MV_FLOW : MACARON_FLOW; }
  function isClimax(stage) { return !!(stage && stage.oil >= 0.5); }
  function cssRgb(t) { return 'rgb(' + t + ')'; }
  /* Chroma Drencher project.json 原始七色（红粉/黄/橙/紫/绿/品红/蓝），垂流专用 */
  var DRIP_RGB = ['255,40,100', '255,255,0', '255,150,0', '150,0,255', '150,255,100', '255,0,200', '40,100,255'];

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* 按 MV 段落切换双色搭配：不是整条彩虹，而是每段固定一组撞色，
     主歌黄绿、副歌红紫/红蓝、桥段蓝紫；oil 控制混彩流光在该段的存在感 */
  function stageInfo(t) {
    if (t < 5)    return { pal: ['52,199,190', '180,92,255'], oil: 0.12 };
    if (t < 40)   return { pal: ['143,224,106', '242,216,92'], oil: 0.18 };
    if (t < 80)   return { pal: ['255,92,158', '180,92,255'], oil: 0.55 };
    if (t < 95)   return { pal: ['58,107,232', '180,92,255'], oil: 0.10 };
    if (t < 128)  return { pal: ['255,92,158', '58,107,232'], oil: 0.58 };
    if (t < 142)  return { pal: ['58,107,232', '180,92,255'], oil: 0.08 };
    if (t < 172)  return { pal: ['242,216,92', '255,92,158'], oil: 0.60 };
    return { pal: ['180,92,255', '242,236,255'], oil: 0.05 };
  }
  global.stageInfo = stageInfo;

  /* 调亮 / 调暗一个十六进制色，用来做音符的上下渐变 */
  function shade(hex, amt) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    if (amt >= 0) {
      r = Math.round(r + (255 - r) * amt);
      g = Math.round(g + (255 - g) * amt);
      b = Math.round(b + (255 - b) * amt);
    } else {
      r = Math.round(r * (1 + amt));
      g = Math.round(g * (1 + amt));
      b = Math.round(b * (1 + amt));
    }
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  /* 十六进制色转 "r,g,b" 字符串，供 rgba() 拼接 */
  function hexRGB(hex) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return r + ',' + g + ',' + b;
  }

  /* 圆角矩形路径 */
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  class RhythmGame {
    constructor(opts) {
      this.canvas = opts.canvas;
      this.ctx = this.canvas.getContext('2d', { alpha: true });
      this.rough = global.Rough ? global.Rough.canvas(this.canvas, { seed: 20261112 }) : null;
      this.audio = opts.audio;
      this.videoEl = opts.videoEl || null;
      this.onFinish = opts.onFinish || function () {};
      this.onStats = opts.onStats || function () {};
      this.onHpEvent = opts.onHpEvent || function () {};

      this.chart = null;
      this.running = false;
      this.paused = false;
      this.time = 0;
      this.fxLevel = 1;      // 0=温和 1=标准 2=全开
      /* 分项特效开关：由主控 settings 同步；默认全开 */
      this.flags = Object.assign(
        { mv: true, walker: true, meteor: true, ink: true, eye: true },
        opts.flags || {}
      );
      /* 底部按键提示字母：随键位方案切换，默认 SDJK */
      this.keyLabels = opts.keyLabels || ['S', 'D', 'J', 'K'];
      this.stage = stageInfo(0);
      this.palA = this.stage.pal[0];
      this.palB = this.stage.pal[1];

      this.notes = null;
      this.nextIdx = [0, 0, 0, 0];
      this.held = [false, false, false, false];
      this.heldDropAt = [-99, -99, -99, -99];
      this.holdStart = [-99, -99, -99, -99];
      this.keyFlash = [0, 0, 0, 0];

      this.score = 0;
      this.combo = 0;
      this.maxCombo = 0;
      this.perfect = 0;
      this.good = 0;
      this.miss = 0;
      this.judgedTotal = 0;
      /* 自动打"真人小失误"模型：音符序号 + 上一次 GOOD 序号，用于冷却与概率控制 */
      this._autoNoteIdx = 0;
      this._lastAutoGoodIdx = -999;

      this.particles = [];
      this.popups = [];
      this.tailFx = [];
      this.tailNext = 0;
      /* 本作母题特效池：彩虹缎带、贴纸均由 MV 抠图贴图优先绘制 */
      this.ribbons = [];
      this.clouds = [];
      this.hearts = [];
      this.dots = [];
      this.ripples = [];
      this.buds = [];
      this.drips = [];
      this.walkers = [];
      this.walkCanvas = null;
      this.wctx = null;
      this.walkHue = 0;
      this.trails = null;
      this.shake = 0;
      this.hitFlash = [0, 0, 0, 0];
      this.actx = null;
      this._panCache = {};   // 四条轨固定声像节点复用，避免每次音效新建 panner 堆积
      this.lastHitSfx = 0;
      this.holdPulse = 0;
      this.rings = [];
      this.edgePulse = 0;
      this.comboPop = 0;     // 连击数字弹出动画：替代原来每拍一次的整屏白闪
      this.auto = false;     // 纯享版：自动打，观众只看
      this.glitch = 0;       // 电子错误强度 0..1
      this.hitLines = [];    // 打击瞬间的横向撕裂条
      this.dpr = 1;
      this._eyeTrail = null;
      this._eyeR = null;
      this._eyeB = null;

      /* 原 MV 抠帧透明贴纸：直接复用 DOM 里静态 <img>，未加载完成时退回矢量绘制 */
      this.sticker = { eye: null, eye2: null, eyeClosed: null, star: null, starBlue: null,
        heartPink: null, heartBlue: null };
      var stickerMap = {
        'sticker-eye.png': 'eye', 'sticker-eye2.png': 'eye2',
        'sticker-eye-closed.png': 'eyeClosed',
        'sticker-star.png': 'star',
        'sticker-star-blue.png': 'starBlue', 'sticker-heart-pink.png': 'heartPink',
        'sticker-heart-blue.png': 'heartBlue'
      };
      var stickerImgs = (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function')
        ? document.querySelectorAll('img.pp-src') : [];
      for (var si = 0; si < stickerImgs.length; si++) {
        var stickerKey = stickerImgs[si].src.split('/').pop();
        if (stickerMap[stickerKey]) this.sticker[stickerMap[stickerKey]] = stickerImgs[si];
      }

      this.lastFlash = -1;
      this.flashAt = -99;
      this.beatAt = -99;
      this.shiftAt = -99;
      this.shiftDir = 1;
      this._lastSync = -999;
      this.demoClock = false;
      this.demoStart = 0;

      this.fpsAcc = 0;
      this.fpsFrames = 0;
      this.fpsValue = 60;
      this.lowQuality = false;

      this.resize();
      this._boundResize = this.resize.bind(this);
      window.addEventListener('resize', this._boundResize);
      window.addEventListener('orientationchange', this._boundResize);
    }

    /* ---------- 布局 ---------- */

    resize() {
      var c = this.canvas;
      var dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      var w = c.clientWidth || window.innerWidth;
      var h = c.clientHeight || window.innerHeight;
      if (w === 0 || h === 0) return;
      c.width = Math.floor(w * dpr);
      c.height = Math.floor(h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w;
      this.h = h;

      /* 按屏幕比例切换两种排布：
         宽屏（PC／手机横过来）轨道收在中间，两侧留出背景与 HUD —— osu!mania 的观感；
         竖屏（手机竖着拿）轨道铺满宽度，否则四条轨会被挤成一根细竖条 */
      var aspect = h > 0 ? w / h : 1;
      this.isPortrait = aspect < 1.0;
      if (this.isPortrait) {
        this.trackW = Math.min(w * 0.96, 640);
      } else {
        this.trackW = Math.min(w * 0.62, 780);
      }
      this.trackX = (w - this.trackW) / 2;
      this.laneW = this.trackW / CFG.LANES;
      this.judgeY = Math.round(h * (this.isPortrait ? 0.74 : 0.80));
      this.noteH = Math.max(16, Math.round(Math.min(this.laneW * (this.isPortrait ? 0.22 : 0.16), 46)));
      this.pxPerSec = this.judgeY / CFG.APPROACH;
      this.dpr = dpr;
      this._bgDirty = true;

      /* ref_b 游走墨团的常驻拖尾画布（褪色留在离屏层，再 screen 贴回主画布） */
      if (!this.walkCanvas) this.walkCanvas = document.createElement('canvas');
      this.walkCanvas.width = Math.round(w * dpr);
      this.walkCanvas.height = Math.round(h * dpr);
      this.wctx = this.walkCanvas.getContext('2d');
      this.wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /* 背景静态层烤成离屏图：原来 drawTracks 每帧重建十几个渐变（含两块整屏全屏渐变），
       手机 GPU 上全屏渐变极贵。这里全部画一次，每帧只贴一次 */
    bakeBG() {
      var w = this.w, h = this.h, dpr = this.dpr || 1;
      var cv = document.createElement('canvas');
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      var g = cv.getContext('2d');
      g.scale(dpr, dpr);
      var topY = h * 0.46;

      var veil = g.createLinearGradient(0, 0, 0, h);
      veil.addColorStop(0, 'rgba(10, 11, 16, 0.00)');
      veil.addColorStop(0.30, 'rgba(10, 11, 16, 0.02)');
      veil.addColorStop(0.50, 'rgba(10, 11, 16, 0.12)');
      veil.addColorStop(0.66, 'rgba(10, 11, 16, 0.34)');
      veil.addColorStop(0.84, 'rgba(10, 11, 16, 0.60)');
      veil.addColorStop(1, 'rgba(10, 11, 16, 0.78)');
      g.fillStyle = veil; g.fillRect(0, 0, w, h);

      var eL = g.createLinearGradient(0, topY, 0, h);
      eL.addColorStop(0, 'rgba(58, 107, 232, 0)');
      eL.addColorStop(0.40, 'rgba(58, 107, 232, 0.16)');
      eL.addColorStop(1, 'rgba(58, 107, 232, 0.62)');
      g.fillStyle = eL; g.fillRect(this.trackX, topY, 1.5, h - topY);
      var eR = g.createLinearGradient(0, topY, 0, h);
      eR.addColorStop(0, 'rgba(255, 92, 158, 0)');
      eR.addColorStop(0.40, 'rgba(255, 92, 158, 0.16)');
      eR.addColorStop(1, 'rgba(255, 92, 158, 0.62)');
      g.fillStyle = eR; g.fillRect(this.trackX + this.trackW - 1.5, topY, 1.5, h - topY);

      for (var i = 0; i < CFG.LANES; i++) {
        var x = this.trackX + this.laneW * i;
        var pane = g.createLinearGradient(0, topY, 0, h);
        pane.addColorStop(0, 'rgba(255, 255, 255, 0.000)');
        pane.addColorStop(0.34, 'rgba(255, 255, 255, 0.012)');
        pane.addColorStop(0.70, 'rgba(255, 255, 255, 0.036)');
        pane.addColorStop(1, 'rgba(255, 255, 255, 0.012)');
        g.fillStyle = pane; g.fillRect(x, topY, this.laneW - 1, h - topY);
        var foot = g.createLinearGradient(0, h * 0.72, 0, h);
        foot.addColorStop(0, 'rgba(0,0,0,0)');
        foot.addColorStop(1, 'rgba(' + this.laneTint(i) + ', 0.075)');
        g.fillStyle = foot; g.fillRect(x, h * 0.72, this.laneW - 1, h * 0.28);
        if (i > 0) {
          var sep = g.createLinearGradient(0, topY, 0, h);
          sep.addColorStop(0, 'rgba(242, 236, 255, 0)');
          sep.addColorStop(0.44, 'rgba(242, 236, 255, 0.05)');
          sep.addColorStop(0.74, 'rgba(242, 236, 255, 0.17)');
          sep.addColorStop(1, 'rgba(242, 236, 255, 0.10)');
          g.fillStyle = sep; g.fillRect(x - 0.5, topY, 1, h - topY);
        }
      }

      g.globalCompositeOperation = 'screen';
      var lS = g.createRadialGradient(this.trackX - this.trackW * 0.12, h, 0, this.trackX - this.trackW * 0.12, h, this.trackW * 0.95);
      lS.addColorStop(0, 'rgba(58, 107, 232, 0.115)');
      lS.addColorStop(1, 'rgba(58, 107, 232, 0)');
      g.fillStyle = lS; g.fillRect(0, h * 0.5, w * 0.52, h * 0.5);
      var rS = g.createRadialGradient(this.trackX + this.trackW * 1.12, h, 0, this.trackX + this.trackW * 1.12, h, this.trackW * 0.95);
      rS.addColorStop(0, 'rgba(255, 92, 158, 0.115)');
      rS.addColorStop(1, 'rgba(255, 92, 158, 0)');
      g.fillStyle = rS; g.fillRect(w * 0.48, h * 0.5, w * 0.52, h * 0.5);
      g.globalCompositeOperation = 'source-over';

      var cx = (this.trackX + this.trackW / 2) - 1.5;
      var grd = g.createLinearGradient(cx - 9, 0, cx + 9, 0);
      grd.addColorStop(0, 'rgba(58, 107, 232, 0)');
      grd.addColorStop(0.32, 'rgba(58, 107, 232, 0.28)');
      grd.addColorStop(0.5, 'rgba(6, 6, 10, 0.92)');
      grd.addColorStop(0.68, 'rgba(255, 92, 158, 0.28)');
      grd.addColorStop(1, 'rgba(255, 92, 158, 0)');
      g.fillStyle = grd;
      var y0 = h * 0.58, segs = 30;
      for (var si = 0; si < segs; si++) {
        var t0 = y0 + (h - y0) * (si / segs);
        var t1 = y0 + (h - y0) * ((si + 1) / segs);
        g.globalAlpha = 0.80 * Math.pow((si + 1) / segs, 1.15);
        g.fillRect(cx - 9, t0, 18, t1 - t0 + 1);
      }
      g.globalAlpha = 1;
      this._bgCv = cv;
      this._bgDirty = false;
    }

    laneCenter(i) {
      return this.trackX + this.laneW * (i + 0.5);
    }

    laneColor(i) {
      var n = ((i % 4) + 4) % 4;
      return isClimax(this.stage) ? LANE_COLS[n] : MACARON_LANE_COLS[n];
    }

    laneDeep(i) {
      var n = ((i % 4) + 4) % 4;
      return isClimax(this.stage) ? LANE_DEEP[n] : MACARON_LANE_DEEP[n];
    }

    laneTint(i) {
      var n = ((i % 4) + 4) % 4;
      return isClimax(this.stage) ? LANE_TINT[n] : MACARON_LANE_TINT[n];
    }

    toneRgb(i) {
      var n = ((i % 4) + 4) % 4;
      return isClimax(this.stage) ? TONE_RGB[n] : MACARON_TONE_RGB[n];
    }

    /* ---------- 生命周期 ---------- */

    prepare(chart) {
      this.chart = chart;
      this.nextIdx = [0, 0, 0, 0];
      this.held = [false, false, false, false];
      this.heldDropAt = [-99, -99, -99, -99];
      this.holdStart = [-99, -99, -99, -99];
      this.keyFlash = [0, 0, 0, 0];
      this.score = 0;
      this.combo = 0;
      this.maxCombo = 0;
      this.perfect = 0;
      this.good = 0;
      this.miss = 0;
      this.judgedTotal = 0;
      /* 自动打"真人小失误"模型：音符序号 + 上一次 GOOD 序号，用于冷却与概率控制 */
      this._autoNoteIdx = 0;
      this._lastAutoGoodIdx = -999;
      this.particles = [];
      this.popups = [];
      this.tailFx = [];
      this.ribbons = [];
      this.clouds = [];
      this.hearts = [];
      this.dots = [];
      this.ripples = [];
      this.buds = [];
      this.drips = [];
      this.walkers = [];
      /* 重开一局清空流光拖尾离屏画布，避免上一局的轨迹残影残留到新局 */
      if (this.wctx) this.wctx.clearRect(0, 0, this.w, this.h);
      this.tailNext = 0;
      this.trails = [];
      this.shake = 0;
      this.hitFlash = [0, 0, 0, 0];
      this.lastHitSfx = 0;
      this.holdPulse = 0;
      this.rings = [];
      this.edgePulse = 0;
      this.glitch = 0;
      this.hitLines = [];
      this._eyeTrail = null;
      this.lastFlash = -1;
      this.flashAt = -99;
      this.beatAt = -99;
      this.shiftAt = -99;

      /* 长条音符的历史拖尾数组 */
      for (var l = 0; l < CFG.LANES; l++) {
        var lane = chart.lanes[l];
        for (var i = 0; i < lane.length; i++) {
          lane[i].done = false;
          lane[i].holding = false;
          lane[i].headJudge = null;
          lane[i].hitAt = 0;
          lane[i].trail = [];
          lane[i]._trail = null;
        }
      }
      this.emitStats();
    }

    start(fromTime) {
      this.running = true;
      this.paused = false;
      this.time = fromTime || 0;
      this.demoStart = performance.now() / 1000 - (fromTime || 0);
      this.initSfx();
    }

    pause() {
      this.paused = true;
    }

    resume() {
      this.paused = false;
    }

    stop() {
      this.running = false;
      this.paused = false;
    }

    /* ---------- 判定 ---------- */

    press(lane) {
      if (!this.running || this.paused) return;
      if (this.auto) return;   // 自动演示由时间驱动，不接受手动按键干扰
      this.held[lane] = true;
      this.holdStart[lane] = this.audio.time;
      this.keyFlash[lane] = 1;
      if (this.onHpEvent) this.onHpEvent('press');

      var now = this.time;
      var notes = this.chart.lanes[lane];
      var idx = this.nextIdx[lane];

      while (idx < notes.length && notes[idx].done && !notes[idx].holding) idx++;
      this.nextIdx[lane] = idx;

      /* 这一轨暂时没有可判音符 —— 也要给反馈，否则手感就是"按了没反应" */
      if (idx >= notes.length) {
        this.emptyTap(lane);
        return;
      }

      var n = notes[idx];
      var dt = n.t - now;

      if (n.holding) return;                // 已经在按

      /* 提前按：不判分，给一次空按反馈；若一直按住，update 里会自动接管 */
      if (dt > CFG.GOOD) {
        this.emptyTap(lane);
        return;
      }

      var abs = Math.abs(dt);
      if (abs <= CFG.PERFECT) this.judge(n, lane, 'PERFECT');
      else if (abs <= CFG.GOOD) this.judge(n, lane, 'GOOD');
      /* 晚了但仍在"迟到宽容"里：也算 GOOD。原来这里直接判 MISS，
         手机触屏本来就有几十毫秒延迟，玩家明明点上了却被判错，
         准确率就是这么被冤枉拉下去的 */
      else if (-dt <= CFG.GOOD + CFG.LATE_GRACE) this.judge(n, lane, 'GOOD');
      else this.judge(n, lane, 'MISS');     // 按太晚
    }

    /* 空按：闪轨道 + 几粒白点；主流音游防乱按的做法之一是空按断连击，
       盲按连点保不住 chain，也不加分 */
    emptyTap(lane) {
      this.keyFlash[lane] = 0.85;
      var cx = this.laneCenter(lane);
      var count = this.lowQuality ? 2 : 4;
      for (var i = 0; i < count; i++) {
        this.particles.push({
          x: cx + (Math.random() - 0.5) * this.laneW * 0.5,
          y: this.judgeY - 6 - Math.random() * 10,
          vx: (Math.random() - 0.5) * 90,
          vy: -40 - Math.random() * 90,
          size: 2 + Math.random() * 3,
          life: 0.18 + Math.random() * 0.12,
          maxLife: 0.3,
          color: C.paper,
          rot: Math.random() * Math.PI
        });
      }
      if (this.combo > 0) this.combo = 0;
      this.comboPop = 0;
      this.emitStats();
    }

    /* ---------- 打击音效：样本取自 osu!mania 皮肤，WebAudio 解码后直接播放 ---------- */
    initSfx() {
      if (this.actx) {
        if (this.actx.state === 'suspended') {
          try { this.actx.resume(); } catch (e) { /* 忽略 */ }
        }
        return;
      }
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ctx;
      try { ctx = new AC(); } catch (e) { return; }
      this.actx = ctx;
      this.bufSharp = null;
      this.bufSoft = null;

      var self = this;
      var raw = window.SFX_B64 || {};

      function load(b64, assign) {
        if (!b64) return;
        try {
          var bin = atob(b64);
          var len = bin.length;
          var arr = new Uint8Array(len);
          for (var i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
          ctx.decodeAudioData(arr.buffer, function (buf) {
            assign(buf);
          }, function () { /* 解码失败就退回合成音 */ });
        } catch (e) { /* 忽略 */ }
      }

      load(raw.sharp, function (b) { self.bufSharp = b; });
      load(raw.soft, function (b) { self.bufSoft = b; });
    }

    /* 声像输出：pan -1 全左 ~ +1 全右；不支持 StereoPanner 时直连 destination */
    _out(ctx, pan) {
      if (typeof pan !== 'number' || !ctx.createStereoPanner) return ctx.destination;
      var key = Math.round(pan * 100);
      if (!this._panCache[key]) {
        var p = ctx.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, pan));
        p.connect(ctx.destination);
        this._panCache[key] = p;
      }
      return this._panCache[key];
    }

    /* 四条轨对应的声像：S 最左、D 偏左、J 偏右、K 最右 */
    _lanePan(lane) {
      return [-0.8, -0.28, 0.28, 0.8][lane] || 0;
    }

    /* 播放一个 AudioBuffer，音量与音高可调，可带左右声像 */
    playBuffer(buf, gainVal, rate, pan) {
      if (!this.actx || this.audio.muted || !buf) return false;
      var ctx = this.actx;
      var src = ctx.createBufferSource();
      var gain = ctx.createGain();
      src.buffer = buf;
      src.playbackRate.value = rate || 1;
      gain.gain.value = gainVal;
      src.connect(gain);
      gain.connect(this._out(ctx, pan));
      src.start(0);
      return true;
    }

    /* 兜底：没有样本时用振荡器现场合成 */
    playTone(freq, level, dur, pan) {
      if (!this.actx || this.audio.muted) return;
      var ctx = this.actx;
      var t0 = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(120, freq * 0.62), t0 + dur * 0.7);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(level, t0 + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain);
      gain.connect(this._out(ctx, pan));
      osc.start(t0);
      osc.stop(t0 + dur + 0.01);
    }

    /* 玻璃/铃音命中音：基频 + 一组不谐和泛音簇，各泛音独立衰减、高频衰减更快，
       起音极快、尾音清亮；参考钟/玻璃音色的 partials 叠加做法 */
    playGlass(base, level, dur, pan) {
      if (!this.actx || this.audio.muted) return;
      var ctx = this.actx, t0 = ctx.currentTime;
      /* [频率倍数, 音量比, 衰减比, 失谐 cents] —— 不谐和泛音列，模拟玻璃共振 */
      var partials = [
        [1.00, 1.00, 1.00, 0],
        [2.40, 0.42, 0.55, 15],
        [4.80, 0.18, 0.30, -12],
        [7.90, 0.08, 0.16, 0]
      ];
      partials.forEach(function (p) {
        var mult = p[0], gRatio = p[1], dRatio = p[2], detuneCents = p[3];
        var osc = ctx.createOscillator(), g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(base * mult, t0);
        if (detuneCents !== 0) osc.detune.setValueAtTime(detuneCents, t0);
        var pd = dur * dRatio;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(level * gRatio, t0 + 0.0012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + pd);
        osc.connect(g); g.connect(this._out(ctx, pan));
        osc.start(t0); osc.stop(t0 + pd + 0.01);
      }, this);
    }

    /* 敲击瞬态：高通白噪短 snap，提供"咔"的冲击起音，比粉噪更脆更短 */
    noiseSnap(dur, level, hpFreq, pan) {
      if (!this.actx || this.audio.muted) return;
      var ctx = this.actx, t0 = ctx.currentTime;
      var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      var src = ctx.createBufferSource(); src.buffer = buf;
      var hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = hpFreq;
      var g = ctx.createGain();
      g.gain.setValueAtTime(level, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(hp); hp.connect(g); g.connect(this._out(ctx, pan));
      src.start(t0);
    }

    /* MV 里那种老游戏机的 UI 音：短促方波 beep，弹窗糊脸时响一下 */
    beep() {
      if (!this.actx || this.audio.muted) return;
      var ctx = this.actx;
      var t0 = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(880, t0);
      osc.frequency.setValueAtTime(660, t0 + 0.045);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.16, t0 + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.12);
    }

    /* 命中音：同一帧最多一次，避免多押叠在一起爆音；声像随所在轨 */
    playHit(verdict, lane) {
      if (!this.actx || this.audio.muted) return;
      var t = this.actx.currentTime;
      if (t - this.lastHitSfx < 0.03) return;
      this.lastHitSfx = t;
      var pan = this._lanePan(lane);

      if (verdict === 'PERFECT') {
        /* 样本只垫底厚度，玻璃泛音簇为亮层主体；短高通白噪给敲击接触瞬态 */
        this.playBuffer(this.bufSharp, 0.35, 1.25, pan);
        this.playGlass(2600, 0.38, 0.09, pan);
        this.noiseSnap(0.012, 0.14, 6000, pan);
      } else if (verdict === 'GOOD') {
        this.playBuffer(this.bufSoft, 0.30, 1.15, pan);
        this.playGlass(1700, 0.28, 0.09, pan);
        this.noiseSnap(0.012, 0.09, 4500, pan);
      } else {
        this.playTone(180, 0.10, 0.18, pan);
      }
    }

    /* 长条按住时的铃音 tick：玻璃泛音簇，音高随按住进度往上爬；
       叠一丝高通白噪起音，和短音命中音同一套玻璃质感 */
    playTick(freq, level, pan) {
      if (!this.actx || this.audio.muted) return;
      this.playGlass(freq, level, 0.07, pan);
      this.noiseSnap(0.012, level * 0.30, 5000, pan);
    }

    /* 打击瞬间在画面上撕一条横向错位，配合 #chroma 的红蓝残影 */
    pushHitLine(lane) {
      if (this.lowQuality) return;
      this.hitLines.push({
        y: 0.12 + Math.random() * 0.72,
        h: 1 + Math.random() * 3.2,
        dir: Math.random() < 0.5 ? -1 : 1,
        life: 0.17,
        maxLife: 0.17,
        color: this.laneColor(lane)
      });
      if (this.hitLines.length > 7) this.hitLines.shift();
    }

    /* 从 MV 里搬过来的"癫"：磁带式横向撕裂、心跳冲击线、上下红条警报。
       全部挂在拍子上，一拍一次，不靠整屏爆闪 */
    drawBeatFx(now) {
      var ctx = this.ctx;
      var w = this.w, h = this.h;
      var beatPos = (now - CFG.OFFSET) / CFG.BEAT;
      var bp = beatPos - Math.floor(beatPos);
      var k = Math.max(0, 1 - bp * 3.0);
      if (k <= 0.02) return;
      var dpr = this.dpr || 1;

      /* 1) 磁带撕裂：两条随机高度的横带整体错开，像信号被打断 */
      for (var i = 0; i < 2; i++) {
        var y = ((i * 0.47 + 0.09) % 1) * h;
        var bh = h * (0.016 + 0.030 * k);
        var off = (i % 2 === 0 ? 1 : -1) * (8 + 22 * k);
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.05 + 0.10 * k;
        ctx.fillStyle = this.laneColor(i * 2);
        ctx.fillRect(off, y, w, bh);
        ctx.restore();
      }

      /* 2) 强拍墨渍/流星：中心向外铺开几团不规则油彩与短线 */
      if (this.flags.meteor && this.fxLevel > 0 && k > 0.35) {
        if (!this._rays) {
          this._rays = [];
          for (var j = 0; j < 9; j++) {
            this._rays.push({
              a: Math.random() * Math.PI * 2,
              r0: 0.18 + Math.random() * 0.22,
              size: 0.05 + Math.random() * 0.08,
              seed: Math.random() * 10
            });
          }
        }
        var hx = this.trackX + this.trackW / 2;
        var hy = this.judgeY - this.h * 0.21;
        var maxR = Math.max(w, h) * 0.55;
        var A = (k - 0.35) / 0.65;
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (var r = 0; r < this._rays.length; r++) {
          var R = this._rays[r];
          var bx = hx + Math.cos(R.a) * maxR * R.r0;
          var by = hy + Math.sin(R.a) * maxR * R.r0;
          var br = maxR * R.size * (0.6 + A);
          ctx.globalAlpha = (0.05 + 0.20 * A * A);
          var bg = ctx.createRadialGradient(bx, by, 0, bx, by, br);
          bg.addColorStop(0, 'rgba(' + this.toneRgb(r) + ',1)');
          bg.addColorStop(1, 'rgba(' + this.toneRgb(r) + ',0)');
          ctx.fillStyle = bg;
          this._inkBlob(ctx, bx, by, br, R.seed, 0.24);
          ctx.fill();
        }
        ctx.restore();
      }

      /* 3) 上下品红压边：MV 里那种"系统告警"的描边 */
      if (this.fxLevel > 0 && k > 0.5) {
        ctx.save();
        ctx.globalAlpha = (k - 0.5) * 0.5;
        ctx.fillStyle = C.right;
        var hb = Math.max(3, h * 0.006);
        ctx.fillRect(0, 0, w, hb);
        ctx.fillRect(0, h - hb, w, hb);
        ctx.restore();
      }
    }

    /* 把画布自己切一条、横向错开重绘 —— 真正的"信号错位"，不是画一个色条 */
    drawGlitchSlices() {
      if (!this.hitLines.length) return;
      var ctx = this.ctx;
      var w = this.w, h = this.h;
      var dpr = this.dpr || 1;
      ctx.save();
      for (var i = 0; i < this.hitLines.length; i++) {
        var L = this.hitLines[i];
        var a = L.life / L.maxLife;
        var y = clamp(L.y, 0, 0.98) * h;
        var bh = Math.min(L.h, h - y);
        if (bh <= 0) continue;
        var off = L.dir * (10 + 12 * a);
        ctx.globalAlpha = 0.14 * a;
        ctx.fillStyle = L.color;
        ctx.fillRect(off, y, w, bh);
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }

    release(lane) {
      this.held[lane] = false;
      if (this.onHpEvent) this.onHpEvent('release');
      if (this.auto) return;   // 自动演示不走松手判定
      if (!this.running || this.paused || !this.chart) return;
      var now = this.audio.time;
      var notes = this.chart.lanes[lane];
      for (var i = 0; i < notes.length; i++) {
        var n = notes[i];
        if (n.holding) {
          var need = n.t + n.dur - 0.06;
          if (now < need) {
            /* 尾巴还没走完就松手。只要按住的时间够长，就按"提前放"算 GOOD，
               不再直接判 MISS —— 手机上一戳一放太常见，误判会把准确率白拉下去 */
            var kept = n.dur > 0 ? (now - n.t) / n.dur : 1;
            n.holding = false;
            n.done = true;
            if (this.onHpEvent) this.onHpEvent('holdend');
            if (kept >= CFG.HOLD_MIN_KEEP) {
              this.register('GOOD', lane, n);
              this.popups.push({
                text: '早放', x: this.laneCenter(lane), y: this.judgeY - 58,
                life: 0.4, maxLife: 0.4, color: this.laneColor(lane), size: 20
              });
              this.spawnBurst(lane, this.judgeY, 11, 'GOOD');
            } else {
              this.register('MISS', lane, n);
              this.popups.push({
                text: '断', x: this.laneCenter(lane), y: this.judgeY - 60,
                life: 0.5, maxLife: 0.5, color: C.right, size: 26
              });
              this.glitch = 1;
            }
          }
          return;
        }
      }
    }

    judge(n, lane, verdict) {
      var now = this.time;
      this.playHit(verdict, lane);
      this.shake = Math.max(this.shake, verdict === 'MISS' ? 18 : 8);
      if (verdict !== 'MISS') {
        this.hitFlash[lane] = 1;
        this.glitch = Math.max(this.glitch, 0.8);
        this.pushHitLine(lane);
      } else {
        this.glitch = 1;
      }

      if (n.type === 'hold') {
        /* 头部就判 MISS 的，不再当长条按住，直接结束，避免尾部再记一次 */
        if (verdict === 'MISS') {
          n.done = true;
          n.hitAt = now;
          this.spawnBurst(lane, this.judgeY, 6, 'MISS');
          this.showPopup(lane, verdict);
          this.register('MISS', lane, n);
          return;
        }
        n.holding = true;
        n.headJudge = verdict;
        n.hitAt = now;
        this.spawnBurst(lane, this.judgeY, 17, verdict);
        this.showPopup(lane, verdict);
        if (this.onHpEvent) this.onHpEvent('holdstart');
        return;
      }

      n.done = true;
      n.hitAt = now;
      this.spawnBurst(lane, this.judgeY, verdict === 'MISS' ? 6 : 26, verdict);
      this.showPopup(lane, verdict);
      this.register(verdict, lane, n);
    }

    /* 自动打"真人小失误"：主歌段稳打全 PERFECT；高潮密集段以低概率判 GOOD，
       带冷却避免连发，绝不判 MISS、不断连击。GOOD 也计入连击（见 register） */
    _pickAutoVerdict(n) {
      var t = this.time;
      this._autoNoteIdx = (this._autoNoteIdx || 0) + 1;
      if (t < 40) return 'PERFECT';                 /* 前奏/主歌：不失误 */
      var cooldown = (this._autoNoteIdx - this._lastAutoGoodIdx) >= 10;
      var p = n.type === 'hold' ? 0.02 : 0.04;     /* 长条头失误概率更低 */
      if (cooldown && Math.random() < p) {
        this._lastAutoGoodIdx = this._autoNoteIdx;
        return 'GOOD';
      }
      return 'PERFECT';
    }

    /* 自动演示：时间驱动直接命中，不走 press/release/held 状态机。
       避免真机掉帧、触摸干扰、松手竞态导致长音提前断连击；auto 仅 PERFECT/GOOD，不 MISS */
    _autoJudge(lane, n) {
      var now = this.time;
      var verdict = this._pickAutoVerdict(n);
      this.playHit(verdict, lane);
      this.shake = Math.max(this.shake, 8);
      this.hitFlash[lane] = 1;
      this.glitch = Math.max(this.glitch, 0.8);
      this.pushHitLine(lane);
      /* 与手打一致的按键反馈：命中即点亮对应轨道按键；长条进入按住态，收尾再松开 */
      this.keyFlash[lane] = 1;

      if (n.type === 'hold') {
        n.holding = true;
        n.headJudge = verdict;
        n.hitAt = now;
        this.held[lane] = true;
        this.holdStart[lane] = now;
        this.spawnBurst(lane, this.judgeY, 17, verdict);
        this.showPopup(lane, verdict);
        if (this.onHpEvent) this.onHpEvent('holdstart');
        return;
      }
      n.done = true;
      n.hitAt = now;
      this.spawnBurst(lane, this.judgeY, 26, verdict);
      this.showPopup(lane, verdict);
      this.register(verdict, lane, n);
    }

    register(verdict, lane, n) {
      this.judgedTotal += 1;
      if (verdict === 'PERFECT') {
        this.perfect += 1;
        this.combo += 1;
        this.score += 300 + Math.min(this.combo, 100) * 3;
      } else if (verdict === 'GOOD') {
        this.good += 1;
        this.combo += 1;
        this.score += 100 + Math.min(this.combo, 100);
      } else {
        this.miss += 1;
        this.combo = 0;
      }
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
      if (verdict !== 'MISS') this.comboPop = 1;
      this.emitStats();
    }

    emitStats() {
      var judged = this.perfect + this.good + this.miss;
      /* GOOD 也算正确：只要没 MISS，准确率就是 100% */
      var acc = judged > 0
        ? (this.perfect + this.good) / judged * 100
        : 100;
      var goodRatio = judged > 0 ? this.good / judged : 0;
      this.onStats({
        score: this.score,
        combo: this.combo,
        maxCombo: this.maxCombo,
        accuracy: acc,
        goodRatio: goodRatio,
        perfect: this.perfect,
        good: this.good,
        miss: this.miss,
        progress: this.chart ? clamp(this.time / this.chart.duration, 0, 1) : 0
      });
    }

    /* ---------- 特效池 ---------- */

    showPopup(lane, verdict) {
      var color = verdict === 'PERFECT' ? C.paper
        : (verdict === 'GOOD' ? this.laneColor(lane) : C.right);
      this.popups.push({
        text: verdict,
        x: this.laneCenter(lane),
        y: this.judgeY - 44,
        life: 0.42,
        maxLife: 0.42,
        color: color,
        size: verdict === 'PERFECT' ? 30 : 24
      });
    }

    spawnBurst(lane, y, count, verdict) {
      var q = this.lowQuality ? Math.ceil(count / 2) : count;
      var color = verdict === 'MISS' ? C.right : this.laneColor(lane);
      var cx = this.laneCenter(lane);

      for (var i = 0; i < q; i++) {
        var ang = (Math.random() * Math.PI * 2);
        var spd = 160 + Math.random() * 460;
        var white = i % 4 === 0;
        this.particles.push({
          x: cx + (Math.random() - 0.5) * this.laneW * 0.75,
          y: y + (Math.random() - 0.5) * 12,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd - 70,
          size: white ? 3.5 + Math.random() * 8 : 2.5 + Math.random() * 7,
          life: 0.36 + Math.random() * 0.40,
          maxLife: 0.76,
          color: white ? 'rgba(255, 255, 255, 1)' : color,
          rot: Math.random() * Math.PI,
          spin: (Math.random() - 0.5) * 14,
          kind: i % 9 === 5 ? 'shard' : 'dot'
        });
      }
      if (this.particles.length > 560) {
        this.particles.splice(0, this.particles.length - 560);
      }

      /* 命中墨渍：一团一团不规则墨滴/油彩滩涂，向外铺开再化开，不用同心圆环 */
      if (verdict !== 'MISS') {
        this.rings.push({
          x: cx, y: y, r0: 4, r1: this.noteH * 3.2,
          life: 0.24, maxLife: 0.24, color: '#FFFFFF', seed: Math.random() * 10,
          width: 3, blob: true
        });
        this.rings.push({
          x: cx, y: y, r0: 3, r1: this.noteH * 2.4,
          life: 0.36, maxLife: 0.36, color: color, seed: Math.random() * 10,
          width: 2, blob: true
        });
        this.rings.push({
          x: cx, y: y, r0: this.noteH * 0.5, r1: this.noteH * 1.5,
          life: 0.52, maxLife: 0.52, color: 'rgba(242, 236, 255,0.55)', seed: Math.random() * 10,
          width: 1, fill: true, blob: true
        });
        if (this.rings.length > 34) this.rings.splice(0, this.rings.length - 34);

        /* 命中瞬间在判定点上补一颗"玻璃爆点"——一小团很短的白色扁光 */
        this.popups.push({
          text: '', x: cx, y: y, life: 0.18, maxLife: 0.18,
          color: 'rgba(255,255,255,0.95)', size: 0, flash: this.noteH * 2.0
        });
      }
    }

    /* ---------- 每帧更新 ---------- */

    update(dt) {
      if (!this.running || !this.chart) return;

      if (this.paused) return;

      this.time = this.demoClock
        ? (performance.now() / 1000 - this.demoStart)
        : this.audio.time;
      var now = this.time;
      this.stage = stageInfo(now);
      this.palA = this.stage.pal[0];
      this.palB = this.stage.pal[1];

      /* 抖动与轨道命中闪光的衰减 */
      if (this.shake > 0) {
        this.shake = Math.max(0, this.shake - dt * 46);
      }
      for (var s = 0; s < CFG.LANES; s++) {
        if (this.hitFlash[s] > 0) {
          this.hitFlash[s] = Math.max(0, this.hitFlash[s] - dt / 0.30);
        }
      }
      if (this.holdPulse > 0) this.holdPulse = Math.max(0, this.holdPulse - dt / 0.22);

      /* 命中冲击波环 */
      for (var rr = this.rings.length - 1; rr >= 0; rr--) {
        var rg = this.rings[rr];
        rg.life -= dt;
        if (rg.life <= 0) { this.rings.splice(rr, 1); continue; }
        rg.r = rg.r0 + (rg.r1 - rg.r0) * (1 - rg.life / rg.maxLife);
      }

      /* 画面元素全程都在：金币、报错框、星星、裂心，按段落调密度，但从不间断 */
      if (this.tailNext === 0) this.tailNext = now;
      if (now >= this.tailNext) {
        this.spawnTailFx(now);
        if (Math.random() < 0.45) this.spawnTailFx(now);
        var densityGap = now > 126 ? 0.16 : (now > 96 ? 0.34 : 0.66);
        this.tailNext = now + densityGap + Math.random() * 0.20;
      }
      for (var t = this.tailFx.length - 1; t >= 0; t--) {
        var f = this.tailFx[t];
        f.life -= dt;
        f.squash = Math.max(0, (f.squash || 0) - dt * 3.4);
        if (f.kind === 'fall' && !f.landed) {
          /* 从上面掉下来的弹窗：受重力下落，落到 restY 就停住并压一下 */
          f.vy += 96 * dt;
          f.y += f.vy * dt;
          f.x += f.vx * dt;
          f.rot += f.spin * dt;
          if (f.y >= f.restY) {
            f.y = f.restY;
            f.landed = true;
            f.spin = 0;
            f.rot = (Math.random() - 0.5) * 0.03;
            f.squash = 1;
            this.shake = Math.max(this.shake, 5);
          }
        } else {
          f.x += f.vx * dt;
          f.y += f.vy * dt;
          f.rot += f.spin * dt;
        }
        if (f.life <= 0) this.tailFx.splice(t, 1);
      }

      /* 人物/眼睛周围向外扩散的不规则水波涟漪（MV 里一圈圈荡开的环），强度与轨道同源 */
      var climE = clamp((this.stage.oil - 0.08) / (0.55 - 0.08), 0, 1);
      var beatP = ((now - CFG.OFFSET) / CFG.BEAT) % 1;
      if (beatP < 0.06 && now > 5) {
        var ecx = this.trackX + this.trackW / 2;
        var ecy = this.judgeY - this.h * 0.21;
        var eR = Math.min(this.trackW * 0.34, this.h * 0.20);
        this._spawnRipple(ecx, ecy, eR, climE);
      }
      for (var rp = this.ripples.length - 1; rp >= 0; rp--) {
        var rpl = this.ripples[rp];
        rpl.life -= dt;
        if (rpl.life <= 0) { this.ripples.splice(rp, 1); continue; }
        rpl.r = rpl.r0 + (rpl.r1 - rpl.r0) * (1 - rpl.life / rpl.maxLife);
      }
      for (var bd = this.buds.length - 1; bd >= 0; bd--) {
        var bud = this.buds[bd];
        bud.life -= dt;
        bud.x += bud.vx * dt;
        bud.y += bud.vy * dt;
        bud.rot += bud.spin * dt;
        bud.scale += dt * 0.35;
        if (bud.life <= 0) this.buds.splice(bd, 1);
      }

      /* 垂落彩色流：自上而下的柔光细流，出屏后从顶部回绕重生 */
      if (this.drips.length === 0) this._seedDrips();
      for (var di = this.drips.length - 1; di >= 0; di--) {
        var dpr = this.drips[di];
        dpr.y += dpr.speed * dt * (1 + 0.6 * this.edgePulse);
        dpr.phase += dt;
        dpr.ci = (dpr.ci + dt * 0.12) % DRIP_RGB.length;
        if (dpr.y - dpr.len > this.h) {
          this.drips[di] = this._makeDrip(true);
        }
      }

      /* ref_b walker 思路：航向游走、随机转向、边缘反弹；颜色沿 HSL 色轮转 */
      if (this.walkers.length === 0) this._seedWalkers();
      this.walkHue = (this.walkHue + dt * 15) % 360;
      for (var wi = this.walkers.length - 1; wi >= 0; wi--) {
        var wk = this.walkers[wi];
        var roll = Math.random();
        if (roll < 0.2) { wk.dir += wk.turn; wk.sign = wk.turn; }
        else if (roll > 0.8) { wk.dir -= wk.turn; wk.sign = -wk.turn; }
        else { wk.dir += wk.sign; }
        var spd = wk.spd * (1 + this.edgePulse * 0.6);
        wk.px = wk.x; wk.py = wk.y;
        wk.x += Math.cos(wk.dir) * spd * dt;
        wk.y += Math.sin(wk.dir) * spd * dt;
        /* 出屏回绕：从一侧出去后从另一侧回来，不做边缘反弹 */
        if (wk.x < -20) wk.x = this.w + 20;
        else if (wk.x > this.w + 20) wk.x = -20;
        if (wk.y < -20) wk.y = this.h + 20;
        else if (wk.y > this.h + 20) wk.y = -20;
        if (Math.abs(wk.x - wk.px) > this.w * 0.5 || Math.abs(wk.y - wk.py) > this.h * 0.5) { wk.px = wk.x; wk.py = wk.y; }
      }

      /* FPS 采样，低于阈值自动降特效 */
      this.fpsAcc += dt;
      this.fpsFrames += 1;
      if (this.fpsAcc >= 1) {
        this.fpsValue = this.fpsFrames / this.fpsAcc;
        this.fpsAcc = 0;
        this.fpsFrames = 0;
        this.lowQuality = this.fpsValue < 44;
      }

      if (this.comboPop > 0) this.comboPop = Math.max(0, this.comboPop - dt / 0.35);

      /* 按键闪光衰减 */
      for (var k = 0; k < CFG.LANES; k++) {
        if (this.keyFlash[k] > 0) this.keyFlash[k] = Math.max(0, this.keyFlash[k] - dt * 5);
      }

      /* 强拍脉冲：减掉第一拍相位，所有跳动才和音乐同拍 */
      var beatPos = (now - CFG.OFFSET) / CFG.BEAT;
      var beatIdx = Math.floor(beatPos);
      if (beatIdx !== this.beatAt) {
        this.beatAt = beatIdx;
        /* 每一拍点亮屏幕外那一圈红蓝光晕 —— 这就是原来"每拍整屏白闪"的替代品：
           不闪眼睛，但整块画面会随着拍子往外扩一次 */
        this.edgePulse = 1;
      }
      this.edgePulse = Math.max(0, this.edgePulse - dt / 0.34);
      this.glitch = Math.max(0, this.glitch - dt / 0.26);
      for (var hl = this.hitLines.length - 1; hl >= 0; hl--) {
        this.hitLines[hl].life -= dt;
        if (this.hitLines[hl].life <= 0) this.hitLines.splice(hl, 1);
      }

      /* 整屏白闪已按要求关闭：不再按拍点亮视频、不拉满色差；错位撕裂只由 glitch/edgePulse 驱动 */
      this.lastFlash = Math.floor(beatPos / CFG.FLASH_EVERY);

      /* 纯享版：自动判定。到线就自动 press，长条到尾自动 release，观众只看视觉 */
      /* 纯享版：自动判定。到线就自动 press，长条到尾自动 release，观众只看视觉 */
      if (this.auto && this.running && !this.paused) {
        for (var al = 0; al < CFG.LANES; al++) {
          var alane = this.chart.lanes[al];
          var aidx = this.nextIdx[al];
          while (aidx < alane.length && alane[aidx].done) aidx++;
          if (aidx >= alane.length) continue;
          var an = alane[aidx];
          /* 长音保持与收尾交给主循环，这里不调 release，避免提前松手竞态 */
          if (an.holding) continue;
          var adt = an.t - now;
          /* 到点即命中：不卡晚边界、不经过 held 状态，掉帧也不会整颗漏掉 */
          if (adt <= CFG.PERFECT) {
            this._autoJudge(al, an);
          }
        }
      }

      /* 每条轨每帧只处理队首那一个音符 —— 抄 osu!mania 的做法：
         命中后索引只前进一格，绝不会把同一轨后面的音符一起消掉 */
      for (var l = 0; l < CFG.LANES; l++) {
        var lane = this.chart.lanes[l];
        var idx = this.nextIdx[l];
        while (idx < lane.length && lane[idx].done) idx++;
        this.nextIdx[l] = idx;
        if (idx >= lane.length) continue;

        var n = lane[idx];
        if (n.t - now > CFG.APPROACH) continue;

        if (n.holding) {
          var heldNow = this.held[l];
          if (heldNow) this.heldDropAt[l] = -99;
          /* 自动演示不依赖 held，视为始终保持；手动长按才检测松手掉落 */
          var dropped = !heldNow && !this.auto;
          var graceOut = false;
          /* 手动长按：手指滑动 / 系统长按取消让 held 短暂掉一下，给 0.12s 宽限，
             期间手指回来就不断连击；自动演示不据 held 判 MISS */
          if (dropped) {
            if (this.heldDropAt[l] < 0) this.heldDropAt[l] = now;
            if (now - this.heldDropAt[l] > 0.12) graceOut = true;
          }

          if (graceOut) {
            n.holding = false;
            n.done = true;
            this.register('MISS', l, n);
          } else {
            if (!dropped) {
              /* 按住期间持续反馈：每四分之一拍"嗒"一声 + 判定线上一圈光 + 粒子
                 音高随进度往上爬，按住的时间越长越亮、越响，手感才跟得上 */
              var tickIdx = Math.floor((now - n.t) / (CFG.BEAT / 4));
              if (tickIdx !== n.ticked) {
                n.ticked = tickIdx;
                this.holdPulse = 1;
                var prog = clamp((now - n.t) / Math.max(0.14, n.dur), 0, 1);
                this.playTick(1120 + prog * 700, 0.16 + 0.05 * (tickIdx % 3), this._lanePan(l));
                this.spawnBurst(l, this.judgeY - this.noteH * 0.5, tickIdx % 2 === 0 ? 9 : 5, n.headJudge || 'GOOD');
                this.rings.push({
                  x: this.laneCenter(l), y: this.judgeY, r0: 3, r1: this.laneW * 0.42,
                  life: 0.22, maxLife: 0.22, color: C.paper, width: 1.4,
                  seed: Math.random() * 10, blob: true
                });
              }
            }
            if (now >= n.t + n.dur) {
              n.holding = false;
              n.done = true;
              this.held[l] = false;
              this.register(n.headJudge || 'GOOD', l, n);
              if (this.onHpEvent) this.onHpEvent('holdend');
              this.spawnBurst(l, this.judgeY, 30, 'PERFECT');
              this.playTick(1860, 0.30, this._lanePan(l));
              this.playTone(240, 0.10, 0.12, this._lanePan(l));
              this.holdPulse = 1;
              this.shake = Math.max(this.shake, 10);
              this.rings.push({
                x: this.laneCenter(l), y: this.judgeY, r0: 6, r1: this.laneW * 1.1,
                life: 0.34, maxLife: 0.34, color: '#FFFFFF', width: 2.5,
                seed: Math.random() * 10, blob: true
              });
            }
          }
          continue;
        }

        var dt2 = now - n.t;

        /* 按住不放：只有本次按键是在贴线前一瞬按下的才接管，
           提前很久就按住的手指不能自动吃键（防盲按长押） */
        if (this.held[l] && dt2 >= -0.03 && dt2 <= CFG.PERFECT && (now - this.holdStart[l]) <= 0.12) {
          this.judge(n, l, 'GOOD');
          continue;
        }

        /* 过线太久没按。多留 LATE_GRACE 的宽容窗，
           避免"手指正要落下去的那一帧"被抢先判 MISS */
        if (dt2 > CFG.GOOD + CFG.LATE_GRACE) {
          n.done = true;
          this.showPopup(l, 'MISS');
          this.spawnBurst(l, this.judgeY, 6, 'MISS');
          this.register('MISS', l, n);
        }
      }

      /* 粒子 */
      for (var p = this.particles.length - 1; p >= 0; p--) {
        var pt = this.particles[p];
        pt.life -= dt;
        if (pt.life <= 0) { this.particles.splice(p, 1); continue; }
        pt.x += pt.vx * dt;
        pt.y += pt.vy * dt;
        pt.vy += 260 * dt;
        pt.vx *= 0.96;
      }

      /* 判定文字 */
      for (var s = this.popups.length - 1; s >= 0; s--) {
        var pp = this.popups[s];
        pp.life -= dt;
        if (pp.life <= 0) { this.popups.splice(s, 1); continue; }
        pp.y -= 42 * dt;
      }

      /* 进度 & 结束 */
      this.emitStats();
      if (now >= this.chart.duration - 0.15) {
        this.stop();
        this.onFinish();
      }

      /* 视频跟随音频时钟：小偏差用播放速率平滑追平，偏差大才 seek 对齐，
         避免长间隔大阈值导致画面越追越慢、反复 seek 打断解码 */
      if (this.videoEl && now - (this._lastSync || 0) > 0.5) {
        this._lastSync = now;
        var vv = this.videoEl;
        try {
          if (vv.readyState >= 1 && !vv.paused) {
            var vdiff = vv.currentTime - now;   /* 正=视频快，负=视频慢 */
            var vad = Math.abs(vdiff);
            if (vad > 0.35) {
              vv.currentTime = now;            /* 偏差大：直接对齐，不调速 */
              vv.playbackRate = 1;
            } else if (vad > 0.06) {
              /* 慢了轻微提速、快了轻微降速，夹在 0.97~1.03，平滑追平 */
              var vtarget = vdiff < 0 ? 1.03 : 0.97;
              if (Math.abs(vv.playbackRate - vtarget) > 0.001) vv.playbackRate = vtarget;
            } else if (Math.abs(vv.playbackRate - 1) > 0.001) {
              vv.playbackRate = 1;
            }
          }
        } catch (e) { /* 忽略 */ }
      }
    }

    triggerShift() {
      this.shiftAt = this.audio.time;
      this.shiftDir = Math.random() < 0.5 ? -1 : 1;
    }

    /* ---------- 渲染 ---------- */

    render() {
      var ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      if (!this.chart) return;

      var now = this.time;
      var beatPos = (now - CFG.OFFSET) / CFG.BEAT;
      var pulse = Math.exp(-(beatPos - Math.floor(beatPos)) * 6.5);

      var sx = 0, sy = 0, rot = 0;
      if (this.shake > 0.4) {
        sx = (Math.random() * 2 - 1) * this.shake;
        sy = (Math.random() * 2 - 1) * this.shake * 0.8;
        /* 震动带一点旋转，纯平移看起来像抖分辨率，加了角度才像"画面在挨打" */
        rot = (Math.random() * 2 - 1) * this.shake * 0.0016;
      }
      ctx.save();
      ctx.translate(this.w / 2 + sx, this.h / 2 + sy);
      ctx.rotate(rot);
      ctx.translate(-this.w / 2, -this.h / 2);

      this.drawTracks(pulse, now);
      this.drawDoorGlow(now);
      this.drawWitchLayer(now, pulse);
      this.drawDrips(now);
      this.drawWalkers(now);
      this.drawMonitorEye(now);
      this.drawJudgeLine(pulse, now);
      this.drawNotes(now);
      this.drawParticles();
      this.drawRipples(now);
      this.drawPopups();
      this.drawCombo(now);
      this.drawEyeballs(now);
      this.drawKeyHints(now);
      this.drawTailFx(now);
      this.drawBeatFx(now);
      this.drawGlitchSlices();
      ctx.restore();

      /* 屏幕外那一圈红蓝晕：整屏不闪，靠它和震动撑住"颠" */
      this.drawEdgeHalo(now);
      this.drawOppression(now);
    }

    /* 压迫/恐怖氛围层：桥段与终段高潮压暗，叠 CRT 扫描线与越界暗红边条，
       参考 analog horror 监控画面的 vignette + 扫描干扰，不做整屏白闪 */
    drawOppression(now) {
      var op = 0.15;
      if (now >= 128 && now <= 142) op = 1.0;
      else if (now >= 142 && now <= 172) op = 0.9;
      else if (now >= 40 && now <= 128) op = 0.35;
      if (op <= 0.3) return;
      var ctx = this.ctx;
      var w = this.w, h = this.h;

      /* 扫描线：随时间轻微上下漂移，压迫越强越密越暗 */
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.06 * op;
      ctx.fillStyle = '#070410';
      var lineGap = 3;
      var off = Math.floor(now * 24) % lineGap;
      for (var y = off; y < h; y += lineGap) {
        ctx.fillRect(0, y, w, 1);
      }

      /* 越界暗红边条：实体像顶到屏幕外，只露出血色边缘，呼吸式开合 */
      var breathe = 0.5 + 0.5 * Math.sin(now * 2.1);
      var bw = w * (0.018 + 0.014 * breathe) * op;
      var bh = h * (0.012 + 0.010 * breathe) * op;
      ctx.globalAlpha = 0.22 * op;
      ctx.fillStyle = '#5A0E2E';
      ctx.fillRect(0, 0, bw, h);
      ctx.fillRect(w - bw, 0, bw, h);
      ctx.fillRect(0, 0, w, bh);
      ctx.fillRect(0, h - bh, w, bh);
      ctx.restore();
    }

    /* 誓见氛围层：闪屏减下来之后用来填空缺的一层。
       漂浮的日文词、对话气泡符号、几何色块与网格碎片，全部低频慢动、不闪，
       只给背景加厚度，呼应 MV 里的誓见取景框与霓虹城市 */
    drawWitchLayer(now, pulse) {
      var ctx = this.ctx;
      var w = this.w, h = this.h;
      var P = this._witch;

      if (!P) {
        var pool = ['監視', '見てる', '知ってる', 'ひとり', '声', 'MWAH', 'シェイク', '泣いて',
                    'あたし', 'きみ', 'モニタ', '★', '◆', '▶', '◀', '【', '】', '〈', '〉', '…'];
        var list = [];
        for (var i = 0; i < 52; i++) {
          list.push({
            ch: pool[i % pool.length],
            x: Math.random(),
            y: Math.random(),
            size: 9 + Math.random() * 16,
            spd: 0.5 + Math.random() * 1.4,
            ph: Math.random() * Math.PI * 2,
            hot: Math.random() < 0.42,
            v: Math.random() < 0.22      // 少数是竖排的日式文字列
          });
        }

        /* 剪纸感的黑碎片，只擦两侧留白，不压轨道。
           多边形顶点半径必须预先算好，不能每帧随机，否则形状会抖成噪点 */
        var frags = [];
        for (var f = 0; f < 11; f++) {
          var ptn = Math.floor(3 + Math.random() * 3);
          var rad = [];
          for (var rv = 0; rv < ptn; rv++) rad.push(0.52 + Math.random() * 0.48);
          frags.push({
            x: Math.random(), y: Math.random(),
            s: 8 + Math.random() * 26,
            rot: Math.random() * Math.PI,
            spd: 0.2 + Math.random() * 0.5,
            side: Math.random() < 0.5 ? -1 : 1,
            pts: ptn,
            rad: rad
          });
        }

        /* 混乱几何块：平面色块 + 线稿图标混杂，交叠着慢慢转 */
        var blocks = [];
        for (var b = 0; b < 20; b++) {
          blocks.push({
            x: 0.03 + Math.random() * 0.94,
            y: 0.10 + Math.random() * 0.86,
            s: 10 + Math.random() * 46,
            rot: Math.random() * Math.PI,
            spd: (Math.random() - 0.5) * 0.18,
            shape: Math.floor(Math.random() * 4),
            tone: Math.floor(Math.random() * 4)
          });
        }

        /* 碎片化网格：一格一格的拼贴纸，色块交替，跟着时间极慢地错位 */
        var grid = [];
        for (var gy = 0; gy < 7; gy++) {
          for (var gx = 0; gx < 5; gx++) {
            grid.push({
              x: gx / 5, y: gy / 7,
              w: 0.10 + Math.random() * 0.10,
              h: 0.06 + Math.random() * 0.09,
              tone: (gx + gy) % 3,
              drift: 0.2 + Math.random() * 0.6
            });
          }
        }

        /* 噪点簇 */
        var noise = [];
        for (var n = 0; n < 90; n++) {
          noise.push({
            x: Math.random(), y: Math.random(),
            s: 0.6 + Math.random() * 1.6,
            a: 0.02 + Math.random() * 0.05
          });
        }

        /* 撕纸拼贴块：犬咖喱那种"剪纸＋黏土"的层叠，每块自带一道浅色纸边，
           是整层里唯一有实体面积的东西，剩下全靠它压出层次 */
        var papers = [];
        for (var pp = 0; pp < 7; pp++) {
          var pn = Math.floor(5 + Math.random() * 4);
          var prad = [];
          for (var pv = 0; pv < pn; pv++) prad.push(0.62 + Math.random() * 0.38);
          papers.push({
            x: Math.random(), y: Math.random(),
            s: 44 + Math.random() * 96,
            rot: Math.random() * Math.PI,
            pts: pn, rad: prad,
            tone: Math.floor(Math.random() * 3)
          });
        }

        /* 线稿图标：只保留四角星描边；花瓣与眼睛线稿已移除 */
        var glyphs = [];
        for (var gl = 0; gl < 9; gl++) {
          glyphs.push({
            x: 0.04 + Math.random() * 0.92,
            y: 0.08 + Math.random() * 0.84,
            s: 9 + Math.random() * 24,
            rot: Math.random() * Math.PI,
            kind: 0,
            ph: Math.random() * Math.PI * 2
          });
        }

        /* 半调网点：印刷网纹的圆点阵，补"旧印刷品"的脏感 */
        var halftones = [];
        for (var ht = 0; ht < 5; ht++) {
          halftones.push({
            x: 0.05 + Math.random() * 0.78,
            y: 0.10 + Math.random() * 0.70,
            w: 60 + Math.random() * 90,
            hh: 40 + Math.random() * 70,
            step: 6 + Math.random() * 4
          });
        }

        /* 拼接割裂碎片：犬咖喱那种"玻璃/纸被砸碎"的锐角三角形，
           数量更多、飘得更快、带红蓝错位，是"癫"的主要来源 */
        var shards = [];
        for (var sh = 0; sh < 26; sh++) {
          shards.push({
            x: Math.random(), y: Math.random(),
            s: 6 + Math.random() * 30,
            rot: Math.random() * Math.PI * 2,
            vx: (Math.random() - 0.5) * 0.02,
            vy: (Math.random() - 0.5) * 0.02,
            spin: (Math.random() - 0.5) * 0.6,
            tone: Math.floor(Math.random() * 3),
            ph: Math.random() * Math.PI * 2
          });
        }

        P = this._witch = {
          chars: list, frags: frags, blocks: blocks, grid: grid, noise: noise,
          papers: papers, glyphs: glyphs, halftones: halftones, shards: shards
        };
      }

      var beat = (now - CFG.OFFSET) / CFG.BEAT;
      var cx = w / 2;
      var cy = this.judgeY - h * 0.12;
      var R = Math.min(w, h) * 0.46;

      ctx.save();

      /* --- 1 碎片化网格底：平面色块一格一格贴上去，像撕碎又拼起来的纸 --- */
      for (var gg = 0; gg < P.grid.length; gg++) {
        var Q = P.grid[gg];
        var ox = Math.sin(now * 0.11 * Q.drift + gg) * 6;
        var oy = Math.cos(now * 0.09 * Q.drift + gg) * 5;
        ctx.globalAlpha = (Q.tone === 2 ? 0.030 : 0.020) + 0.012 * pulse;
        ctx.fillStyle = 'rgba(' + this.toneRgb(Q.tone) + ',1)';
        ctx.fillRect(Q.x * w + ox, Q.y * h + oy, Q.w * w, Q.h * h);
      }

      /* --- 2 混乱几何块与线稿图标交叠 --- */
      for (var bb = 0; bb < P.blocks.length; bb++) {
        var B = P.blocks[bb];
        var bx = B.x * w + Math.sin(now * 0.14 + bb) * 9;
        var by = B.y * h + Math.cos(now * 0.11 + bb) * 7;
        ctx.save();
        ctx.translate(bx, by);
        ctx.rotate(B.rot + now * B.spd);
        ctx.globalAlpha = 0.045 + 0.018 * Math.abs(Math.sin(now * 0.3 + bb));
        ctx.fillStyle = 'rgba(' + this.toneRgb(B.tone) + ',1)';
        if (B.shape === 0) {
          ctx.fillRect(-B.s / 2, -B.s / 2, B.s, B.s);
        } else if (B.shape === 1) {
          ctx.beginPath();
          ctx.moveTo(0, -B.s * 0.6);
          ctx.lineTo(B.s * 0.55, B.s * 0.35);
          ctx.lineTo(-B.s * 0.55, B.s * 0.35);
          ctx.closePath();
          ctx.fill();
        } else if (B.shape === 2) {
          ctx.fillRect(-B.s * 0.5, -B.s * 0.18, B.s, B.s * 0.36);
          ctx.fillRect(-B.s * 0.18, -B.s * 0.5, B.s * 0.36, B.s);
        } else {
          /* 线稿：只描边不填，和上面的平面色块形成"混杂" */
          ctx.strokeStyle = ctx.fillStyle;
          ctx.lineWidth = 1;
          ctx.strokeRect(-B.s * 0.4, -B.s * 0.4, B.s * 0.8, B.s * 0.8);
        }
        ctx.restore();
      }

      ctx.globalAlpha = 1;

      /* --- 2.5 拼接割裂锐角碎片：飘在半空，每拍闪一下，带红蓝错位 --- */
      for (var shd = 0; shd < P.shards.length; shd++) {
        var S = P.shards[shd];
        var sx = (S.x + now * S.vx) % 1; if (sx < 0) sx += 1;
        var sy = (S.y + now * S.vy) % 1; if (sy < 0) sy += 1;
        var sxpx = sx * w, sypx = sy * h;
        var flick = 0.5 + 0.5 * Math.sin(now * 2.4 + S.ph);
        var alpha = 0.05 + 0.10 * flick * pulse;
        ctx.save();
        ctx.translate(sxpx, sypx);
        ctx.rotate(S.rot + now * S.spin);
        var col = 'rgba(' + this.toneRgb(S.tone) + ',';
        ctx.fillStyle = col + (alpha * 0.85).toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(0, -S.s);
        ctx.lineTo(S.s * 0.7, S.s * 0.5);
        ctx.lineTo(-S.s * 0.6, S.s * 0.35);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      /* --- 3 结界：一圈不规则柔光墨团绕中心慢转，替代原来的虚线圆环与放射刻度线 --- */
      ctx.setLineDash([]);
      var haloN = 9;
      for (var hk = 0; hk < haloN; hk++) {
        var hang = hk / haloN * Math.PI * 2 + beat * 0.045;
        var hox = Math.cos(hang) * R * 0.86;
        var hoy = Math.sin(hang) * R * 0.72;
        var hr = R * (0.16 + 0.05 * Math.sin(hk * 1.7 + now));
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = (0.08 + 0.05 * pulse) * (hk % 2 ? 1 : 0.7);
        var hg = ctx.createRadialGradient(cx + hox, cy + hoy, 0, cx + hox, cy + hoy, hr);
        hg.addColorStop(0, 'rgba(' + this.toneRgb(hk) + ',1)');
        hg.addColorStop(1, 'rgba(' + this.toneRgb(hk) + ',0)');
        ctx.fillStyle = hg;
        this._inkBlob(ctx, cx + hox, cy + hoy, hr, hk * 2.3, 0.22);
        ctx.fill();
        ctx.restore();
      }

      /* 六芒多边形（"结界核心"）：只描边，很细，压在心的后面 */
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-beat * 0.03);
      ctx.globalAlpha = 0.10 + 0.06 * pulse;
      ctx.strokeStyle = 'rgba(242, 236, 255,1)';
      ctx.lineWidth = 1.2;
      for (var sg = 0; sg < 2; sg++) {
        ctx.beginPath();
        for (var v = 0; v < 3; v++) {
          var va = v / 3 * Math.PI * 2 + (sg ? Math.PI : 0);
          var vx = Math.cos(va) * R * 0.46;
          var vy = Math.sin(va) * R * 0.46;
          if (v === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
        }
        ctx.closePath();
        ctx.stroke();
      }
      ctx.restore();

      /* --- 4 漂浮的错误字符碎片：横排为主，少数竖排，像掉了字的旧报纸 --- */
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (var c = 0; c < P.chars.length; c++) {
        var ch = P.chars[c];
        var yy = (ch.y * h + Math.sin(now * ch.spd + ch.ph) * 18 + h) % h;
        var xx = ch.x * w + Math.cos(now * 0.22 + ch.ph) * 10;
        ctx.globalAlpha = 0.048 + 0.042 * Math.abs(Math.sin(now * 0.5 + ch.ph));
        ctx.font = ch.size + 'px ui-monospace, Consolas, monospace';
        ctx.fillStyle = ch.hot ? 'rgba(255, 92, 158, 1)' : 'rgba(58, 107, 232, 1)';
        if (ch.v) {
          var s2 = ch.ch.split('');
          for (var q = 0; q < s2.length; q++) {
            ctx.fillText(s2[q], xx, yy + q * ch.size * 1.05);
          }
        } else {
          ctx.fillText(ch.ch, xx, yy);
        }
      }

      /* --- 5 剪纸黑碎片：不规则多边形，边缘贴着画面两侧 --- */
      ctx.globalAlpha = 0.24;
      ctx.fillStyle = 'rgba(6, 6, 9, 1)';
      for (var g = 0; g < P.frags.length; g++) {
        var fr = P.frags[g];
        var fx = fr.side < 0 ? fr.x * w * 0.17 : w - fr.x * w * 0.17;
        var fy = (fr.y * h + Math.sin(now * fr.spd + g) * 20 + h) % h;
        ctx.save();
        ctx.translate(fx, fy);
        ctx.rotate(fr.rot + now * 0.05 * fr.spd);
        ctx.beginPath();
        for (var pi = 0; pi < fr.pts; pi++) {
          var pa = pi / fr.pts * Math.PI * 2;
          var pr = fr.s * fr.rad[pi];
          if (pi === 0) ctx.moveTo(Math.cos(pa) * pr, Math.sin(pa) * pr);
          else ctx.lineTo(Math.cos(pa) * pr, Math.sin(pa) * pr);
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      /* --- 6 层叠视觉噪音：极小的一层点位，加"印刷网纹"的脏感 --- */
      ctx.globalAlpha = 1;
      for (var nn = 0; nn < P.noise.length; nn++) {
        var nz = P.noise[nn];
        ctx.globalAlpha = nz.a + 0.02 * pulse;
        ctx.fillStyle = nn % 3 === 0 ? 'rgba(242, 236, 255,1)' : 'rgba(' + this.toneRgb(nn) + ',1)';
        ctx.fillRect(nz.x * w, nz.y * h, nz.s, nz.s);
      }

      /* --- 7 撕纸拼贴块：不规则剪纸块 + 一道浅色纸边，做出"贴上去的一层" --- */
      for (var pp2 = 0; pp2 < P.papers.length; pp2++) {
        var PW = P.papers[pp2];
        var px2 = PW.x * w + Math.sin(now * 0.05 + pp2) * 10;
        var py2 = PW.y * h + Math.cos(now * 0.04 + pp2) * 8;
        ctx.save();
        ctx.translate(px2, py2);
        ctx.rotate(PW.rot + now * 0.01);
        /* 纸边：同一形状外扩一小圈，浅色，像剪纸叠在纸上露出的白边 */
        ctx.globalAlpha = 0.048 + 0.016 * pulse;
        ctx.strokeStyle = PW.tone === 0 ? 'rgba(242, 236, 255,1)'
          : 'rgba(' + this.toneRgb(PW.tone) + ',1)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (var pj = 0; pj < PW.pts; pj++) {
          var ja = pj / PW.pts * Math.PI * 2;
          var jr = PW.s * PW.rad[pj];
          if (pj === 0) ctx.moveTo(Math.cos(ja) * jr, Math.sin(ja) * jr);
          else ctx.lineTo(Math.cos(ja) * jr, Math.sin(ja) * jr);
        }
        ctx.closePath();
        ctx.stroke();
        /* 纸面本身：极淡的实色，只作为一层"面积"存在 */
        ctx.globalAlpha = 0.034 + 0.014 * pulse;
        ctx.fillStyle = PW.tone === 0 ? 'rgba(18,11,38,1)'
          : (PW.tone === 1 ? 'rgba(58,22,64,1)' : 'rgba(15,62,68,1)');
        ctx.fill();
        ctx.restore();
      }

      /* --- 8 胶片孔带：MV 那种录像带的齿孔边，左右各一条，慢慢向上跑 --- */
      ctx.save();
      ctx.globalAlpha = 0.145;
      ctx.fillStyle = 'rgba(4,4,7,1)';
      var bandW = Math.max(10, w * 0.012);
      ctx.fillRect(0, 0, bandW, h);
      ctx.fillRect(w - bandW, 0, bandW, h);
      var holeH = Math.max(6, h * 0.011);
      var holeStep = holeH * 2.1;
      var holeOff = (now * 26) % holeStep;
      ctx.globalAlpha = 0.20;
      ctx.fillStyle = 'rgba(242, 236, 255,1)';
      for (var hh = -1; hh < h / holeStep + 1; hh++) {
        var hy = hh * holeStep + holeOff;
        ctx.fillRect(bandW * 0.28, hy, bandW * 0.44, holeH);
        ctx.fillRect(w - bandW * 0.72, hy, bandW * 0.44, holeH);
      }
      ctx.restore();

      /* --- 9 线稿图标：四角星描边 --- */
      for (var gi = 0; gi < P.glyphs.length; gi++) {
        var G = P.glyphs[gi];
        var gx2 = G.x * w + Math.sin(now * 0.16 + G.ph) * 12;
        var gy2 = G.y * h + Math.cos(now * 0.13 + G.ph) * 14;
        ctx.save();
        ctx.translate(gx2, gy2);
        ctx.rotate(G.rot + now * 0.04);
        ctx.globalAlpha = 0.075 + 0.035 * Math.abs(Math.sin(now * 0.4 + G.ph));
        ctx.strokeStyle = 'rgba(242, 236, 255,1)';
        ctx.lineWidth = 1;
        if (G.kind === 0) {
          for (var sp = 0; sp < 5; sp++) {
            var sa = sp / 5 * Math.PI * 2 - Math.PI / 2;
            var sr = G.s;
            ctx.beginPath();
            ctx.moveTo(Math.cos(sa) * sr * 0.30, Math.sin(sa) * sr * 0.30);
            ctx.lineTo(Math.cos(sa + 0.42) * sr, Math.sin(sa + 0.42) * sr);
            ctx.stroke();
          }
        }
        ctx.restore();
      }

      /* --- 10 半调网点：旧印刷品的圆点阵。
         以前是每帧画几百个 arc，手机上会吃掉好几毫秒；改成把圆点做成
         一张 12×12 的重复贴图（pattern），每片网点只剩一次 fillRect --- */
      if (!this._htPat) {
        var htCv = document.createElement('canvas');
        htCv.width = 12;
        htCv.height = 12;
        var htCtx = htCv.getContext('2d');
        this._htPat = [];
        for (var hpc = 0; hpc < 3; hpc++) {
          htCtx.clearRect(0, 0, 12, 12);
          htCtx.fillStyle = hpc === 0 ? 'rgba(242, 236, 255,1)'
            : (hpc === 1 ? 'rgba(255, 92, 158,1)' : 'rgba(58, 107, 232,1)');
          htCtx.beginPath();
          htCtx.arc(6, 6, 1.35, 0, Math.PI * 2);
          htCtx.fill();
          this._htPat.push(ctx.createPattern(htCv, 'repeat'));
        }
      }
      for (var hti = 0; hti < P.halftones.length; hti++) {
        var HT = P.halftones[hti];
        if (!this._htPat[hti % 3]) continue;
        ctx.save();
        ctx.globalAlpha = 0.052 + 0.018 * pulse;
        ctx.fillStyle = this._htPat[hti % 3];
        ctx.fillRect(HT.x * w, HT.y * h, HT.w, HT.hh);
        ctx.restore();
      }

      ctx.restore();
    }

    drawTracks(pulse, now) {
      var ctx = this.ctx;
      if (this._bgDirty || !this._bgCv) this.bakeBG();
      ctx.drawImage(this._bgCv, 0, 0, this.w, this.h);
      /* 按键命中：瞬态光柱 */
      var h = this.h;
      for (var i = 0; i < CFG.LANES; i++) {
        if (this.keyFlash[i] <= 0) continue;
        var x = this.trackX + this.laneW * i;
        var kf = this.keyFlash[i];
        var hitG = ctx.createLinearGradient(0, this.judgeY - h * 0.36, 0, this.judgeY + 8);
        hitG.addColorStop(0, 'rgba(255,255,255,0)');
        hitG.addColorStop(0.62, 'rgba(255,255,255,' + (0.045 * kf).toFixed(3) + ')');
        hitG.addColorStop(1, 'rgba(' + this.laneTint(i) + ',' + (0.26 * kf).toFixed(3) + ')');
        ctx.fillStyle = hitG;
        ctx.fillRect(x, this.judgeY - h * 0.36, this.laneW - 1, h * 0.36 + 8);
      }
    }

    /* 开门白光：对齐 MV 结尾全白帧的白度曲线，音游底子随它由黑渐亮到白、再收回。
       时间窗取自 bg.mp4 实测：172.9s 起爬、173.8–174.4s 满白、174.9s 收回。
       叠在背景层之上、眼睛与音符之下，只泛亮底子，不盖住判定。 */
    drawDoorGlow(now) {
      var ctx = this.ctx;
      var S = 172.9, R = 173.8, F = 174.4, E = 174.9;
      var a = 0;
      if (now >= S && now <= E) {
        if (now < R) { var k = (now - S) / (R - S); a = k * k; }
        else if (now < F) { a = 1; }
        else { a = 1 - (now - F) / (E - F); }
      }
      if (a <= 0.003) return;
      ctx.save();
      ctx.globalAlpha = Math.min(1, a);
      ctx.fillStyle = 'rgb(248, 248, 252)';
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.restore();
    }

    drawJudgeLine(pulse, now) {
      var ctx = this.ctx;
      var cx = this.trackX + this.trackW / 2;

      /* 判定线不能只是一根会变粗的横杠。主流音游的判定线都是"活的"：
         大幅上下漂、明显旋转、随拍微微张开，命中时整条被拉扯一下 */
      var driftY = Math.sin(now * 1.05) * 7 + Math.sin(now * 2.7 + 1.2) * 3.5;
      var rot = Math.sin(now * 0.62) * 0.035 + pulse * 0.012;
      var wide = this.trackW * (1 + pulse * 0.028);
      var thick = 3 + pulse * 7;
      var y = this.judgeY + driftY;

      /* 故障错位：FX 全开时整条判定线被扯开一点点 */
      var shift = 0;
      if (this.fxLevel === 2 && now - this.shiftAt < 0.14) {
        shift = this.shiftDir * (7 * Math.sin((now - this.shiftAt) * Math.PI * 60));
      }

      ctx.save();
      ctx.translate(cx + shift, y);
      ctx.rotate(rot);

      /* 脚下的光：判定线下面一层很薄的暖光，像台面被打亮 */
      var halo = ctx.createLinearGradient(0, 0, 0, 28);
      halo.addColorStop(0, 'rgba(255, 92, 158,' + (0.16 + 0.16 * pulse).toFixed(3) + ')');
      halo.addColorStop(1, 'rgba(255, 92, 158, 0)');
      ctx.fillStyle = halo;
      ctx.fillRect(-wide / 2, thick / 2, wide, 28);

      /* 白芯：一条 1.5px 的高光，玻璃感全靠它 */
      ctx.fillStyle = 'rgba(255,255,255,' + (0.50 + 0.40 * pulse).toFixed(3) + ')';
      ctx.fillRect(-wide / 2, -thick / 2 - 0.8, wide, 1.6);

      /* 主条：缎带四色 蓝→绿→黄→粉，正中留一道很窄的暗缝 */
      var grad = ctx.createLinearGradient(-wide / 2, 0, wide / 2, 0);
      grad.addColorStop(0, 'rgba(58, 107, 232, 0.92)');
      grad.addColorStop(0.30, 'rgba(143, 224, 106, 0.62)');
      grad.addColorStop(0.5, 'rgba(8, 8, 12, 0.95)');
      grad.addColorStop(0.70, 'rgba(242, 216, 92, 0.62)');
      grad.addColorStop(1, 'rgba(255, 92, 158, 0.92)');
      ctx.fillStyle = grad;
      ctx.fillRect(-wide / 2, -thick / 2, wide, thick);

      /* 3D 电影红蓝错位残影：整条线往左右错开一层，像没戴 3D 眼镜 */
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = 'rgba(58, 107, 232,0.55)';
      ctx.fillRect(-wide / 2 - 3 - pulse * 4, -thick / 2, wide, thick);
      ctx.fillStyle = 'rgba(255, 92, 158,0.55)';
      ctx.fillRect(-wide / 2 + 3 + pulse * 4, -thick / 2, wide, thick);
      ctx.globalAlpha = 1;

      /* 每条轨的命中点：一段更亮的白线 + 命中时炸开的光斑与光柱 */
      for (var i = 0; i < CFG.LANES; i++) {
        var lx = -wide / 2 + this.laneW * (i + 0.5);
        var wLane = this.laneW * 0.84;
        var f = this.hitFlash[i];
        var col = this.laneColor(i);

        ctx.save();
        ctx.globalAlpha = 0.24 + 0.28 * pulse;
        ctx.fillStyle = C.paper;
        roundRect(ctx, lx - wLane / 2, -1.8, wLane, 3.6, 1.8);
        ctx.fill();
        ctx.restore();

        if (f > 0.01) {
          ctx.save();
          ctx.globalAlpha = f * 0.9;
          ctx.shadowColor = col;
          ctx.shadowBlur = 26 * f;
          ctx.fillStyle = col;
          roundRect(ctx, lx - wLane / 2 - 6, -(thick + 14) / 2, wLane + 12, thick + 14, 8);
          ctx.fill();
          ctx.restore();

          ctx.save();
          var beam = ctx.createLinearGradient(0, -110, 0, 0);
          beam.addColorStop(0, 'rgba(255,255,255,0)');
          beam.addColorStop(0.68, 'rgba(255,255,255,' + (0.10 * f).toFixed(3) + ')');
          beam.addColorStop(1, col);
          ctx.globalAlpha = f * 0.55;
          ctx.fillStyle = beam;
          ctx.fillRect(lx - this.laneW * 0.11, -110, this.laneW * 0.22, 110);
          ctx.restore();
        }
      }

      /* 判定线整体的红蓝错位：只在电子错误强的时候露一下 */
      if (this.glitch > 0.35 && this.fxLevel > 0) {
        ctx.save();
        ctx.globalAlpha = (this.glitch - 0.35) * 0.55;
        ctx.fillStyle = 'rgba(255, 92, 158, 0.9)';
        ctx.fillRect(-wide / 2 + 3.5, -thick / 2, wide, thick * 0.5);
        ctx.fillStyle = 'rgba(58, 107, 232, 0.9)';
        ctx.fillRect(-wide / 2 - 3.5, thick * 0.08, wide, thick * 0.5);
        ctx.restore();
      }

      ctx.restore();
    }

    drawNotes(now) {
      var ctx = this.ctx;
      var lanes = this.chart.lanes;

      for (var l = 0; l < CFG.LANES; l++) {
        var lane = lanes[l];
        var idx = this.nextIdx[l];
        /* 往回多看两个，保证刚判定完的还能画一帧残影 */
        var start = Math.max(0, idx - 2);

        for (var i = start; i < lane.length; i++) {
          var n = lane[i];
          var dt = n.t - now;
          if (dt > CFG.APPROACH) break;
          if (n.done && !n.holding && now - n.hitAt > 0.12) continue;

          var y = this.judgeY - dt * this.pxPerSec;
          var cx = this.laneCenter(l);
          var w = this.laneW * 0.66;
          var col = this.laneColor(l);

          var fade = 1;
          if (n.done && !n.holding) fade = clamp(1 - (now - n.hitAt) / 0.12, 0, 1);

          if (n.type === 'hold') {
            this.drawHold(n, cx, w, y, col, now, fade);
          } else {
            this.drawTap(cx, w, y, col, fade, n);
          }
        }
      }
    }

    /* 音符皮肤：半透明白玻璃 + 阵营色薄边 + 上沿高光。
       旧版是"哑光暗芯 + 细边"，干净但发闷；玻璃的层次全在
       上端透、下端沉、中段一道色晕、最上面一条 1.4px 的白边 */
    drawTap(cx, w, y, col, fade, n) {
      var ctx = this.ctx;
      var h = this.noteH;
      var r = Math.min(15, h * 0.42);
      var x = cx - w / 2;
      var top = y - h / 2;
      var li = (n && n.lane != null) ? n.lane : 0;
      var tint = this.laneTint(li);
      var deep = this.laneDeep(li);

      /* 拖影：只留极淡的两帧，像玻璃在空气里划过 */
      if (n && !this.lowQuality && this.fxLevel > 0) {
        if (!n._trail) n._trail = [];
        n._trail.push(y);
        if (n._trail.length > 3) n._trail.shift();
        for (var t = 0; t < n._trail.length - 1; t++) {
          ctx.save();
          ctx.globalAlpha = 0.05 * (t + 1) * fade;
          ctx.fillStyle = 'rgba(' + tint + ', 0.8)';
          roundRect(ctx, x, n._trail[t] - h / 2, w, h, r);
          ctx.fill();
          ctx.restore();
        }
      }

      ctx.save();
      ctx.globalAlpha = fade;

      /* 落到底部那一层影子，让音符"浮"在判定面上 */
      ctx.fillStyle = 'rgba(4, 4, 8, 0.55)';
      roundRect(ctx, x - 1.5, top + 1.5, w + 3, h + 3, r + 1);
      ctx.fill();

      /* 玻璃主体：上端几乎透明（透出背景），中段一道色晕，下端压暗 */
      var g = ctx.createLinearGradient(0, top, 0, top + h);
      g.addColorStop(0, 'rgba(255, 255, 255, 0.17)');
      g.addColorStop(0.22, 'rgba(255, 255, 255, 0.06)');
      g.addColorStop(0.55, 'rgba(' + tint + ', 0.20)');
      g.addColorStop(0.88, 'rgba(' + tint + ', 0.30)');
      g.addColorStop(1, 'rgba(4, 4, 8, 0.34)');
      ctx.fillStyle = g;
      roundRect(ctx, x, top, w, h, r);
      ctx.fill();

      /* 内里的暗底：给玻璃一个厚度，不然它会飘在白背景上 */
      ctx.save();
      ctx.globalAlpha = fade * 0.55;
      ctx.fillStyle = deep;
      roundRect(ctx, x + 2, top + h * 0.44, w - 4, h * 0.46, Math.max(2, r - 1));
      ctx.fill();
      ctx.restore();

      /* 上沿高光 + 一圈白描边：玻璃感全靠这两笔 */
      ctx.save();
      ctx.globalAlpha = fade * 0.80;
      ctx.strokeStyle = C.glassHi;
      ctx.lineWidth = 1.4;
      roundRect(ctx, x + 1.2, top + 1.2, w - 2.4, h - 2.4, Math.max(2, r - 0.6));
      ctx.stroke();
      ctx.restore();

      /* 阵营色薄边 + 很淡的外发光，把音符和背景分开就够了 */
      ctx.save();
      ctx.globalAlpha = fade * 0.70;
      ctx.strokeStyle = 'rgba(' + tint + ', 0.85)';
      ctx.lineWidth = 1;
      ctx.shadowColor = 'rgba(' + tint + ', 0.65)';
      ctx.shadowBlur = 14;
      roundRect(ctx, x + 0.6, top + 0.6, w - 1.2, h - 1.2, Math.max(2, r - 0.3));
      ctx.stroke();
      ctx.restore();

      /* 中间一道细长反光，像玻璃管里的水线 */
      ctx.save();
      ctx.globalAlpha = fade * 0.32;
      var spec = ctx.createLinearGradient(x, 0, x + w, 0);
      spec.addColorStop(0, 'rgba(255, 255, 255, 0)');
      spec.addColorStop(0.5, 'rgba(255, 255, 255, 0.92)');
      spec.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = spec;
      ctx.fillRect(x + w * 0.14, top + h * 0.20, w * 0.72, 1.3);
      ctx.restore();

      ctx.restore();
    }

    /* 长条：玻璃管 + 按住时管内能量流动。
       按住 = 一条亮带沿管身往下跑 + 斜纹加速 + 外发光涨 + 每四分之一拍一圈光（音效在 update 里） */
    drawHold(n, cx, w, yHead, col, now, fade) {
      var ctx = this.ctx;
      var h = this.noteH;
      var dtEnd = (n.t + n.dur) - now;
      var yEnd = this.judgeY - dtEnd * this.pxPerSec;
      var top = Math.min(yEnd, yHead);
      var bottom = Math.max(yEnd, yHead);
      var len = Math.max(1, bottom - top);
      var bw = w; /* 拖管与头部短音符等宽，头尾一致（标准音游 hold 形态） */
      var x = cx - bw / 2;
      var held = n.holding;
      var hp = held ? (this.holdPulse || 0) : 0;
      var li = (n && n.lane != null) ? n.lane : 0;
      var tint = this.laneTint(li);
      var deepRgb = hexRGB(this.laneDeep(li));

      ctx.save();
      ctx.globalAlpha = (held ? 0.96 : 0.72) * (fade || 1);

      /* 外描边：一圈近黑 */
      ctx.fillStyle = 'rgba(4, 4, 8, 0.82)';
      roundRect(ctx, x - 2, top - 1, bw + 4, len + 2, 9);
      ctx.fill();

      /* 垂直双色渐变（同字幕色条思路）：上端(尾部)本轨深色彩 → 下端(头部/判定线)本轨亮彩；
         deep/tint 内部已随段落自动切马卡龙/高潮两套，四条轨道各自身份色 */
      var prog = held ? clamp((now - n.t) / Math.max(0.14, n.dur), 0, 1) : 0;
      var base = ctx.createLinearGradient(0, top, 0, bottom);
      base.addColorStop(0, 'rgba(' + deepRgb + ', 0.34)');
      base.addColorStop(1, 'rgba(' + tint + ', 0.42)');
      ctx.fillStyle = base;
      roundRect(ctx, x, top, bw, len, 8);
      ctx.fill();

      /* 已按段：从判定线(下端头部)往上染色，未按段保持上面的低饱和原色 */
      if (held && prog > 0.001) {
        var litTop = bottom - len * prog;
        ctx.save();
        roundRect(ctx, x, top, bw, len, 8);
        ctx.clip();
        var lit = ctx.createLinearGradient(0, litTop, 0, bottom);
        lit.addColorStop(0, 'rgba(' + deepRgb + ', 0.62)');
        lit.addColorStop(1, 'rgba(' + tint + ', 0.95)');
        ctx.fillStyle = lit;
        ctx.fillRect(x, litTop, bw, bottom - litTop + 0.5);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
        ctx.fillRect(x + bw * 0.46, litTop, bw * 0.08, bottom - litTop);
        ctx.restore();
      }

      /* 竖向压暗：上端尾部略压暗，下端头部保留亮度 */
      var vshade = ctx.createLinearGradient(0, top, 0, bottom);
      vshade.addColorStop(0, 'rgba(4, 4, 8, 0.18)');
      vshade.addColorStop(0.55, 'rgba(4, 4, 8, 0.07)');
      vshade.addColorStop(1, 'rgba(4, 4, 8, 0)');
      ctx.fillStyle = vshade;
      roundRect(ctx, x, top, bw, len, 8);
      ctx.fill();

      /* 两侧细边白光 */
      ctx.save();
      ctx.globalAlpha = (held ? 0.90 : 0.60) * (fade || 1);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.lineWidth = 1;
      roundRect(ctx, x + 0.6, top + 0.6, bw - 1.2, len - 1.2, 7.4);
      ctx.stroke();
      ctx.restore();

      if (held) {
        ctx.save();
        var bandLen = Math.max(24, Math.min(58, len * 0.4));
        var bandY = top + ((now - n.t) * 300) % Math.max(1, len + bandLen) - bandLen;
        var band = ctx.createLinearGradient(0, bandY, 0, bandY + bandLen);
        band.addColorStop(0, 'rgba(255, 255, 255, 0)');
        band.addColorStop(0.45, 'rgba(255, 255, 255,' + (0.14 + 0.36 * hp).toFixed(3) + ')');
        band.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.fillStyle = band;
        var cs = Math.max(top, bandY);
        var ce = Math.min(bottom, bandY + bandLen);
        if (ce > cs) ctx.fillRect(x + 1, cs, bw - 2, ce - cs);
        ctx.restore();

        ctx.save();
        ctx.globalAlpha = (0.14 + 0.28 * hp) * (fade || 1);
        ctx.strokeStyle = 'rgba(' + tint + ', 0.9)';
        ctx.lineWidth = 0.9;
        for (var sy = top + ((now * 210) % 14); sy < bottom - 2; sy += 14) {
          ctx.beginPath();
          ctx.moveTo(x + 1, sy);
          ctx.lineTo(x + bw - 1, sy + 4);
          ctx.stroke();
        }
        ctx.restore();

        ctx.save();
        ctx.globalAlpha = (0.55 + 0.42 * hp) * (fade || 1);
        ctx.shadowColor = col;
        ctx.shadowBlur = 16 + 26 * hp;
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        roundRect(ctx, x + 0.6, top + 0.6, bw - 1.2, len - 1.2, 7.4);
        ctx.stroke();
        ctx.restore();
        ctx.globalAlpha = (held ? 0.96 : 0.72) * (fade || 1);
      }

      /* 长音为一整条连贯长条：头部即长条上端，不再单独叠短音符方块（避免头身分离） */

      /* 尾部：白横杠 */
      ctx.save();
      ctx.globalAlpha = (dtEnd < 0.35 ? 0.85 : 0.5) * (fade || 1);
      ctx.fillStyle = C.paper;
      roundRect(ctx, x, yEnd - 3, bw, 6, 3);
      ctx.fill();
      if (dtEnd < 0.35) {
        ctx.shadowColor = col;
        ctx.shadowBlur = 18;
        ctx.fill();
      }
      ctx.restore();

      ctx.restore();
    }

    /* 画面元素：全部用从原 MV 里截帧裁出来的真实窗口贴图。
       主体仍然是「正着弹出来、原地停住」，另外三成做「从上面掉下来」的那种 ——
       按用户要求加回来了，但尺寸放大，落地会压一下，不会被当成可点的按钮 */
    /* 环境贴纸池：MV 抠图贴纸优先；代码简笔双眼/花瓣已移除 */
    spawnTailFx(now) {
      var gap = (this.w - this.trackW) / 2;
      var narrow = gap < 90;
      var roll = Math.random();
      var kind;
      if (roll < 0.20) kind = 'eye';
      else if (roll < 0.50) kind = 'heartPink';
      else if (roll < 0.72) kind = 'heartBlue';
      else if (roll < 0.81) kind = 'star';
      else if (roll < 0.88) kind = 'starBlue';
      else if (roll < 0.94) kind = 'window';
      else kind = 'bubble';

      var s = narrow ? 26 + Math.random() * 22 : 30 + Math.random() * 30;
      var falls = Math.random() < 0.30;
      var px, py, restY;
      if (narrow) {
        px = this.w * (0.14 + Math.random() * 0.72);
        py = falls ? -s : this.h * (0.16 + Math.random() * 0.18);
        restY = this.h * (0.14 + Math.random() * 0.30);
      } else {
        var zoneW = Math.max(72, gap);
        var frac = 0.12 + Math.random() * 0.76;
        px = Math.random() < 0.5 ? zoneW * frac : this.w - zoneW * frac;
        py = falls ? -s : this.h * (0.10 + Math.random() * 0.50);
        restY = this.h * (0.10 + Math.random() * 0.46);
      }
      px = clamp(px, s * 0.6 + 4, Math.max(s * 0.6 + 4, this.w - s * 0.6 - 4));
      if (!falls) py = clamp(py, s * 0.6 + 4, Math.max(s * 0.6 + 4, this.h - s * 0.6 - 4));
      if (!isFinite(px)) px = this.w * 0.5;
      if (!isFinite(py)) py = -s * 0.5;
      if (!isFinite(restY)) restY = this.h * 0.3;
      restY = clamp(restY, s * 0.6, Math.max(s * 0.6, this.h - s * 0.6));

      var life = falls ? 2.2 + Math.random() * 0.6 : 1.4 + Math.random() * 0.55;
      var heartCols = ['#FF5C9E', '#B45CFF', '#3A6BE8', '#B2EBE1'];
      this.tailFx.push({
        kind: kind,
        x: px, y: py, w: s,
        rot: (Math.random() - 0.5) * 0.16,
        vx: (Math.random() - 0.5) * 12,
        vy: falls ? 80 + Math.random() * 46 : (Math.random() - 0.5) * 8,
        spin: falls ? (Math.random() - 0.5) * 0.5 : (Math.random() - 0.5) * 0.3,
        life: life, maxLife: life, born: now,
        restY: restY, landed: false, squash: 0,
        eyeAlt: kind === 'eye' ? (Math.random() < 0.5 ? 0 : 1) : 0,
        blinkPhase: kind === 'eye' ? Math.random() * 2.2 : 0,
        blinkPeriod: kind === 'eye' ? 1.8 + Math.random() * 0.8 : 0,
        col: heartCols[Math.floor(Math.random() * heartCols.length)]
      });

      /* 爱心落点细胞分裂：向两侧甩出两颗缩小的姊妹心，漂开消散 */
      if (kind === 'heartPink' || kind === 'heartBlue' || kind === 'heart') {
        var budCol = this.tailFx[this.tailFx.length - 1].col;
        for (var b2 = 0; b2 < 2; b2++) {
          var bang = Math.random() * 6.28;
          this.buds.push({
            x: px, y: py,
            vx: Math.cos(bang) * (10 + Math.random() * 14),
            vy: Math.sin(bang) * (10 + Math.random() * 14),
            rot: Math.random() * 6.28,
            spin: (Math.random() - 0.5) * 1.2,
            size: s * 0.28, scale: 0.6,
            color: budCol, seed: Math.random() * 6.28,
            life: 1.6, maxLife: 1.6
          });
        }
        if (this.buds.length > 28) this.buds.splice(0, this.buds.length - 28);
      }
    }

    /* 贴纸矢量绘制：按母题分路，弹出时白闪一下 + 由小弹大 + 快消失时闪两下 */
    drawTailFx(now) {
      var ctx = this.ctx;
      for (var i = 0; i < this.tailFx.length; i++) {
        var f = this.tailFx[i];
        var age = now - f.born;
        var a2 = clamp(f.life / f.maxLife, 0, 1);
        var pop = age < 0.10 ? 0.70 + (age / 0.10) * 0.44
          : (age < 0.24 ? 1.14 - ((age - 0.10) / 0.14) * 0.14 : 1.0);
        var flick = a2;
        if (a2 < 0.40) flick = (Math.floor(age * 22) % 2 === 0) ? a2 : a2 * 0.28;
        var jx = (Math.random() - 0.5) * (a2 > 0.5 ? 3.5 : 1.5);
        var jy = (Math.random() - 0.5) * (a2 > 0.5 ? 3.0 : 1.5);

        ctx.save();
        ctx.globalAlpha = flick;
        ctx.translate(f.x + jx, f.y + jy);
        ctx.rotate(f.rot);
        ctx.scale(pop, pop);
        var s = f.w;

        if (f.kind === 'eye') this._drawStickerEye(ctx, s, f, now);
        else if (f.kind === 'heartPink') this._drawStickerHeartPink(ctx, s, f);
        else if (f.kind === 'heartBlue') this._drawStickerHeartBlue(ctx, s, f);
        else if (f.kind === 'heart') this._drawStickerHeart(ctx, s, f);
        else if (f.kind === 'star') this._drawStickerStar(ctx, s, f);
        else if (f.kind === 'starBlue') this._drawStickerStarBlue(ctx, s, f);
        else if (f.kind === 'ribbon') this._drawStickerRibbon(ctx, s, f);
        else if (f.kind === 'window') this._drawStickerWindow(ctx, s, f);
        else this._drawStickerBubble(ctx, s, f);

        ctx.restore();
      }
    }

    _stickerImg(key) {
      var im = this.sticker && this.sticker[key];
      return (im && im.naturalWidth > 0) ? im : null;
    }

    /* 段落双色插值：与字幕同款 palA→palB 渐变 */
    _palLerp(t) {
      var A = String(this.palA).split(',').map(Number);
      var B = String(this.palB).split(',').map(Number);
      var r = Math.round(A[0] + (B[0] - A[0]) * t);
      var g = Math.round(A[1] + (B[1] - A[1]) * t);
      var b = Math.round(A[2] + (B[2] - A[2]) * t);
      return 'rgb(' + r + ',' + g + ',' + b + ')';
    }

    /* 连击数字四色标：红→粉→蓝→紫，与字幕邻近色系；全局慢速相位让颜色每帧缓慢漂、不突变，颜色仍只在这四样之间 */
    _comboLerp(t, now) {
      var S = [[255, 32, 74], [255, 92, 158], [58, 107, 232], [150, 80, 220]];
      var drift = 0.18 * Math.sin(now * 0.5);
      t = clamp(t + drift, 0, 1);
      var seg = t * (S.length - 1);
      var i = Math.min(S.length - 2, Math.floor(seg));
      var f = seg - i;
      var A = S[i], B = S[i + 1];
      var r = Math.round(A[0] + (B[0] - A[0]) * f);
      var g = Math.round(A[1] + (B[1] - A[1]) * f);
      var b = Math.round(A[2] + (B[2] - A[2]) * f);
      return 'rgb(' + r + ',' + g + ',' + b + ')';
    }

    _drawStickerEye(ctx, s, f, now) {
      /* 同一只眼在睁眼/闭眼帧间循环开合，不再生成时固定死；睁眼两张瞳位左右各异 */
      var closed = false;
      if (f && f.blinkPeriod) {
        var cycle = ((now - f.born) + f.blinkPhase) % f.blinkPeriod;
        closed = cycle > f.blinkPeriod * 0.82; /* 每周期末段快速闭一下 */
      }
      var eyeIm = closed
        ? this._stickerImg('eyeClosed')
        : (f && f.eyeAlt === 1 ? this._stickerImg('eye2') : this._stickerImg('eye'));
      if (!eyeIm) eyeIm = this._stickerImg('eye2') || this._stickerImg('eye') || this._stickerImg('eyeClosed');
      if (eyeIm) {
        ctx.save();
        ctx.shadowColor = 'rgba(4,4,7,0.6)';
        ctx.shadowBlur = 10;
        var iw = s * 0.84, ih = iw * eyeIm.height / eyeIm.width;
        if (closed) ctx.scale(1, 0.86); /* 闭眼时纵向压一点，模拟眼皮落下 */
        ctx.drawImage(eyeIm, -iw / 2, -ih / 2, iw, ih);
        ctx.restore();
        return;
      }
      /* 贴纸未加载时不再退回代码简笔眼，直接留空，避免旧版线稿眼睛回到背景 */
      return;
    }

    _drawStickerHeart(ctx, s, f) {
      ctx.save();
      this.heartPath(ctx, 0, 0, s * 0.34);
      ctx.fillStyle = f.col;
      ctx.fill();
      ctx.lineWidth = s * 0.05;
      ctx.strokeStyle = 'rgba(20,10,30,0.85)';
      ctx.stroke();
      ctx.beginPath();
      this.heartPath(ctx, -s * 0.05, -s * 0.05, s * 0.13);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fill();
      ctx.restore();
    }

    _drawStickerStar(ctx, s, f) {
      /* 优先用原片抠出的四角星透明贴图；未加载完成退回矢量 */
      var starIm = this._stickerImg('star');
      if (starIm) {
        ctx.save();
        var iw = s * 0.96, ih = iw * starIm.height / starIm.width;
        ctx.drawImage(starIm, -iw / 2, -ih / 2, iw, ih);
        ctx.restore();
        return;
      }
      /* 四角星闪光：MV 里白色 / 薄荷高光 */
      ctx.save();
      var r = s * 0.42, w = s * 0.11;
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.quadraticCurveTo(w, -w, r, 0);
      ctx.quadraticCurveTo(w, w, 0, r);
      ctx.quadraticCurveTo(-w, w, -r, 0);
      ctx.quadraticCurveTo(-w, -w, 0, -r);
      ctx.closePath();
      ctx.fillStyle = Math.random() < 0.5 ? '#FFFFFF' : '#C9EFCF';
      ctx.fill();
      ctx.restore();
    }

    _drawStickerHeartPink(ctx, s, f) {
      var im = this._stickerImg('heartPink');
      if (im) {
        var iw = s * 0.62, ih = iw * im.height / im.width;
        ctx.drawImage(im, -iw / 2, -ih / 2, iw, ih);
        return;
      }
      this.heartPath(ctx, 0, 0, s * 0.30);
      ctx.fillStyle = '#FF5C9E';
      ctx.fill();
    }

    _drawStickerHeartBlue(ctx, s, f) {
      var im = this._stickerImg('heartBlue');
      if (im) {
        var iw = s * 0.86, ih = iw * im.height / im.width;
        ctx.drawImage(im, -iw / 2, -ih / 2, iw, ih);
        return;
      }
      this.heartPath(ctx, 0, 0, s * 0.30);
      ctx.fillStyle = '#3A6BE8';
      ctx.fill();
    }

    _drawStickerStarBlue(ctx, s, f) {
      var im = this._stickerImg('starBlue');
      if (im) {
        var iw = s * 0.7, ih = iw * im.height / im.width;
        ctx.drawImage(im, -iw / 2, -ih / 2, iw, ih);
        return;
      }
      var r = s * 0.34, w = s * 0.09;
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.quadraticCurveTo(w, -w, r, 0);
      ctx.quadraticCurveTo(w, w, 0, r);
      ctx.quadraticCurveTo(-w, w, -r, 0);
      ctx.quadraticCurveTo(-w, -w, 0, -r);
      ctx.closePath();
      ctx.fillStyle = '#8FE06A';
      ctx.fill();
    }

    _drawStickerRibbon(ctx, s, f) {
      /* 软边彩色水彩色块：几团径向渐变叠加，不用矩形贴图 */
      var cols = ['255,92,158', '58,107,232', '143,224,106', '242,216,92'];
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      var offs = [[-0.22, 0.05, 0.42], [0.18, -0.10, 0.38], [0.02, 0.16, 0.36]];
      for (var k = 0; k < offs.length; k++) {
        var px = offs[k][0] * s, py = offs[k][1] * s, pr = offs[k][2] * s;
        var g = ctx.createRadialGradient(px, py, 0, px, py, pr);
        g.addColorStop(0, 'rgba(' + cols[k % 4] + ',0.28)');
        g.addColorStop(1, 'rgba(' + cols[k % 4] + ',0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    _drawStickerWindow(ctx, s, f) {
      /* 漂浮小誓见窗：深色 bezel + 暗屏 + 屏里一颗小眼球 */
      ctx.save();
      var ww = s * 0.9, wh = s * 0.72;
      ctx.shadowColor = 'rgba(4,4,7,0.6)';
      ctx.shadowBlur = 10;
      roundRect(ctx, -ww / 2, -wh / 2, ww, wh, s * 0.08);
      ctx.fillStyle = '#1B1230';
      ctx.fill();
      ctx.lineWidth = s * 0.05;
      ctx.strokeStyle = '#B45CFF';
      ctx.stroke();
      roundRect(ctx, -ww * 0.38, -wh * 0.30, ww * 0.76, wh * 0.60, s * 0.05);
      ctx.fillStyle = '#0E0A1E';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.13, 0, Math.PI * 2);
      ctx.fillStyle = '#3A5AA8';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.06, 0, Math.PI * 2);
      ctx.fillStyle = '#150D3E';
      ctx.fill();
      ctx.restore();
    }

    _drawStickerBubble(ctx, s, f) {
      /* 对话气泡：半透明纸白 + 小尾巴，内部只放圆点排版，不写日文避免缺字 */
      ctx.save();
      var ww = s * 0.95, wh = s * 0.6;
      roundRect(ctx, -ww / 2, -wh / 2, ww, wh, s * 0.12);
      ctx.fillStyle = 'rgba(242,236,255,0.9)';
      ctx.fill();
      ctx.lineWidth = s * 0.045;
      ctx.strokeStyle = '#3A2E8C';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-ww * 0.1, wh / 2);
      ctx.lineTo(-ww * 0.28, wh * 0.85);
      ctx.lineTo(ww * 0.05, wh / 2);
      ctx.closePath();
      ctx.fillStyle = 'rgba(242,236,255,0.9)';
      ctx.fill();
      ctx.strokeStyle = '#3A2E8C';
      ctx.lineWidth = s * 0.03;
      ctx.stroke();
      ctx.fillStyle = '#B45CFF';
      for (var d = -1; d <= 1; d++) {
        ctx.beginPath();
        ctx.arc(d * ww * 0.22, 0, s * 0.05, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }


    /* 离线电平包络插值：给居中眼睛的瞳孔张合、光晕强度供能，确定性、不挂分析器 */
    readEnergy(t) {
      var env = window.LEVEL_ENV;
      if (!env || !env.data || !env.data.length) return 0.35;
      var fi = t / env.step;
      var i0 = Math.floor(fi), i1 = Math.min(env.data.length - 1, i0 + 1);
      var frac = fi - i0;
      var v0 = env.data[Math.max(0, i0)];
      return v0 + (env.data[i1] - v0) * frac;
    }

    /* 不规则墨滴/油彩滩涂轮廓：多段正弦扰动半径，边缘不是正圆，也不是规则波浪线 */
    _inkBlob(ctx, x, y, r, seed, rough) {
      var seg = 12;
      ctx.beginPath();
      for (var i = 0; i <= seg; i++) {
        var ang = (i / seg) * Math.PI * 2;
        var wob = 1
          + rough * Math.sin(ang * 3 + seed)
          + rough * 0.6 * Math.sin(ang * 5 + seed * 1.7);
        var px = x + Math.cos(ang) * r * wob;
        var py = y + Math.sin(ang) * r * wob * 0.86;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }

    /* 心形瞳孔路径：MV 副歌特写里虹膜中那颗薄荷色爱心 */
    heartPath(ctx, x, y, s) {
      ctx.beginPath();
      ctx.moveTo(x, y + s * 0.9);
      ctx.bezierCurveTo(x - s * 1.3, y - s * 0.1, x - s * 0.6, y - s * 1.05, x, y - s * 0.35);
      ctx.bezierCurveTo(x + s * 0.6, y - s * 1.05, x + s * 1.3, y - s * 0.1, x, y + s * 0.9);
      ctx.closePath();
    }

    /* 环境飞眼：从两侧缓慢飘入的 detached 眼球，带粉黏液尾 */
    /* 常驻水彩云团：参照程序化积云做法（两层不同尺度 fbm 轮廓、软边覆盖），
       用几团叠加的径向渐变 puff 堆出蓬松云块，低透明度 screen 慢漂，不是方形贴纸 */
    _drawAmbientClouds(now) {
      var ctx = this.ctx;
      if (!this.clouds.length) {
        var cCols = flowPalette(this.stage);
        for (var ci = 0; ci < 6; ci++) {
          this.clouds.push({
            x: Math.random() * this.w,
            y: this.h * (0.08 + Math.random() * 0.45),
            s: Math.min(this.w, this.h) * (0.16 + Math.random() * 0.12),
            col: cCols[ci % cCols.length],
            vx: (6 + Math.random() * 9) * (Math.random() < 0.5 ? -1 : 1),
            ph: Math.random() * 6.28,
            a: 0.09 + Math.random() * 0.07
          });
        }
      }
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      for (var c = 0; c < this.clouds.length; c++) {
        var cl = this.clouds[c];
        var cx = cl.x + now * cl.vx;
        var span = this.w + cl.s * 2;
        cx = ((cx + cl.s) % span + span) % span - cl.s;
        var cy = cl.y + Math.sin(now * 0.3 + cl.ph) * 10;
        var cs = cl.s * (1 + 0.10 * Math.sin(now * 0.5 + cl.ph));
        this._drawCloudPuff(ctx, cx, cy, cs, cl.col, cl.a, cl.ph);
      }
      ctx.restore();
    }

    _drawCloudPuff(ctx, x, y, s, colRGB, alpha, seed) {
      var puffs = [
        [-0.30, 0.06, 0.42], [0.02, -0.12, 0.52], [0.32, 0.08, 0.38],
        [-0.05, 0.18, 0.40], [0.12, 0.02, 0.46]
      ];
      for (var p = 0; p < puffs.length; p++) {
        var px = x + puffs[p][0] * s;
        var py = y + puffs[p][1] * s;
        var pr = puffs[p][2] * s * (1 + 0.06 * Math.sin(seed + p));
        var g = ctx.createRadialGradient(px, py, 0, px, py, pr);
        g.addColorStop(0, 'rgba(' + colRGB + ',' + alpha.toFixed(3) + ')');
        g.addColorStop(1, 'rgba(' + colRGB + ',0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    /* 常驻漂浮小爱心：MV 里散落在脸侧的蓝/粉/紫心，慢漂、自转、拉伸摆动、荧光，并分裂出小芽 */
    _drawAmbientHearts(now) {
      var ctx = this.ctx;
      var opH = 0.15;
      if (now >= 128 && now <= 142) opH = 1.0;
      else if (now >= 142 && now <= 172) opH = 0.9;
      else if (now >= 40 && now <= 128) opH = 0.35;
      var heartDim = 1 - 0.55 * opH;
      if (!this.hearts.length) {
        var hCols = ['255,92,158', '58,107,232', '180,92,255', '201,239,207'];
        for (var hi = 0; hi < 14; hi++) {
          this.hearts.push({
            x: Math.random() * this.w,
            y: this.h * (0.10 + Math.random() * 0.55),
            s: 8 + Math.random() * 10,
            col: hCols[hi % 4],
            vx: (4 + Math.random() * 7) * (Math.random() < 0.5 ? -1 : 1),
            ph: Math.random() * 6.28,
            rot: Math.random() * 6.28,
            rotSp: (Math.random() - 0.5) * 0.9,
            a: 0.22 + Math.random() * 0.18
          });
        }
      }
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      for (var h2 = 0; h2 < this.hearts.length; h2++) {
        var ht = this.hearts[h2];
        var hx = ht.x + now * ht.vx;
        var span = this.w + ht.s * 2;
        hx = ((hx + ht.s) % span + span) % span - ht.s;
        var hy = ht.y + Math.sin(now * 0.5 + ht.ph) * 12;
        var tw = 0.7 + 0.3 * Math.sin(now * 1.3 + ht.ph);
        var rot = ht.rot + ht.rotSp * now + 0.25 * Math.sin(now * 0.8 + ht.ph);
        /* 拉伸：纵向拉长又收回，像被水流拽着蠕动 */
        var stretch = 1 + 0.28 * Math.sin(now * 1.6 + ht.ph);
        ctx.save();
        ctx.globalAlpha = ht.a * tw * heartDim;
        ctx.translate(hx, hy);
        ctx.rotate(rot);
        ctx.scale(1 / Math.sqrt(stretch), stretch);
        ctx.shadowColor = 'rgb(' + ht.col + ')';
        ctx.shadowBlur = 12;
        this.heartPath(ctx, 0, 0, ht.s);
        ctx.fillStyle = 'rgb(' + ht.col + ')';
        ctx.fill();
        /* 分裂出芽：母体旁侧长出一颗缩小的姊妹心，随相位一伸一缩 */
        var budP = 0.5 + 0.5 * Math.sin(now * 1.1 + ht.ph * 2);
        if (budP > 0.55) {
          var bx = Math.cos(ht.ph) * ht.s * 1.9;
          var by = Math.sin(ht.ph) * ht.s * 1.6;
          ctx.globalAlpha = ht.a * tw * heartDim * (budP - 0.55) * 2.2;
          this.heartPath(ctx, bx, by, ht.s * 0.45 * budP);
          ctx.fill();
        }
        ctx.restore();
      }
      ctx.restore();
    }

    /* 常驻彩色光点：MV 里散落在画面的小粉/橙/蓝圆点，随拍闪烁 */
    _drawAmbientDots(now) {
      var ctx = this.ctx;
      if (!this.dots.length) {
        var dCols = flowPalette(this.stage);
        for (var di = 0; di < 8; di++) {
          this.dots.push({
            x: Math.random() * this.w,
            y: this.h * (0.06 + Math.random() * 0.7),
            r: 1.6 + Math.random() * 2.4,
            col: dCols[di % dCols.length],
            ph: Math.random() * 6.28,
            sp: 0.8 + Math.random() * 1.6
          });
        }
      }
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      for (var d2 = 0; d2 < this.dots.length; d2++) {
        var dt = this.dots[d2];
        var dx = dt.x + Math.sin(now * 0.2 + dt.ph) * 14;
        var dy = dt.y + Math.cos(now * 0.17 + dt.ph) * 10;
        var da = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(now * dt.sp * 2.0 + dt.ph));
        var dg = ctx.createRadialGradient(dx, dy, 0, dx, dy, dt.r * 2.2);
        dg.addColorStop(0, 'rgba(' + dt.col + ',' + da.toFixed(3) + ')');
        dg.addColorStop(1, 'rgba(' + dt.col + ',0)');
        ctx.fillStyle = dg;
        ctx.beginPath();
        ctx.arc(dx, dy, dt.r * 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    /* 环境层：漂浮飞眼 + 两侧粉色黏液缎带 + 水彩云团 + 高潮段头侧四角星 */
    drawEyeballs(now) {
      var ctx = this.ctx;

      this._drawAmbientClouds(now);
      this._drawAmbientHearts(now);
      this._drawAmbientDots(now);
      this.drawBuds(now);

      /* 左右两侧黏液缎带：蛇形摆动，沿竖向铺当前轨道四色，两边顺序反过来 */
      var ribbonCols = [this.laneColor(0), this.laneColor(1), this.laneColor(2), this.laneColor(3)];
      this._drawRibbon(ctx, 0.06, now, ribbonCols);
      this._drawRibbon(ctx, 0.94, now, [ribbonCols[3], ribbonCols[2], ribbonCols[1], ribbonCols[0]]);

      /* 高潮段：居中眼睛左上方的四角星（MV 特写里 Miku 头侧白星），随拍闪烁；强度与轨道同源 */
      var clim = clamp((this.stage.oil - 0.08) / (0.55 - 0.08), 0, 1);
      if (clim > 0.6) {
        var beatP = ((now - CFG.OFFSET) / CFG.BEAT) % 1;
        if (beatP < 0) beatP += 1;
        var tw = 0.6 + 0.4 * Math.sin(beatP * Math.PI);
        var cx = this.trackX + this.trackW / 2;
        var cy = this.judgeY - this.h * 0.21;
        for (var k = 0; k < 2; k++) {
          var sx = cx - this.trackW * (0.20 + k * 0.08);
          var sy = cy - this.h * (0.10 + k * 0.05);
          var sr = (10 + k * 5) * tw * clim;
          ctx.save();
          ctx.globalAlpha = 0.7 * clim * tw;
          ctx.translate(sx, sy);
          this._drawStickerStar(ctx, sr * 2.3, {});
          ctx.restore();
        }
      }
    }

    _drawRibbon(ctx, fx, now, cols) {
      /* 两侧缎带：一团一团不规则彩色油彩软块沿竖向慢飘，不用矩形贴图 */
      var x0 = this.w * fx;
      var blobs = 5;
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      for (var b = 0; b < blobs; b++) {
        var ph = b * 1.7 + fx * 3.0;
        var yy = this.h * (0.08 + 0.84 * b / (blobs - 1))
          + Math.sin(now * 0.9 + ph) * this.h * 0.045;
        var xx = x0 + Math.sin(now * 1.1 + ph) * this.w * 0.035;
        var rr = Math.min(this.w, this.h) * (0.075 + 0.02 * Math.sin(ph + now * 0.6));
        var g = ctx.createRadialGradient(xx, yy, 0, xx, yy, rr);
        g.addColorStop(0, 'rgba(' + this.laneTint(b) + ',0.20)');
        g.addColorStop(1, 'rgba(' + this.laneTint(b) + ',0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(xx, yy, rr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    /* Rough.js（MIT，4.6.6）草图笔触：开场/桥段两侧画青绿色 X 形粉笔涂鸦，带排线毛边 */
    drawBrushMarks(now) {
      if (!this.rough || this.fxLevel === 0) return;
      var opening = now >= 0 && now < 14;
      var bridge = now >= 124 && now < 144;
      if (!opening && !bridge) return;
      var amp = opening ? Math.min(1, now / 1.5) : 0.82;
      var alpha = 0.72 * amp * (0.78 + 0.22 * Math.sin(now * 2.1));
      if (alpha <= 0.01) return;

      var ctx = this.ctx;
      var s = Math.min(this.w, this.h) * 0.26;
      var marks = [
        { x: this.w * 0.16, y: this.h * 0.28, s: s, rot: -0.22, seed: 11 },
        { x: this.w * 0.84, y: this.h * 0.28, s: s * 0.92, rot: 0.26, seed: 29 },
        { x: this.w * 0.16, y: this.h * 0.68, s: s * 0.78, rot: 0.18, seed: 43 },
        { x: this.w * 0.84, y: this.h * 0.68, s: s * 0.72, rot: -0.20, seed: 57 }
      ];

      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      marks.forEach(function (m) {
        ctx.save();
        ctx.translate(m.x, m.y);
        ctx.rotate(m.rot);
        ctx.translate(-m.x, -m.y);

        var col = 'rgba(52,199,190,' + alpha.toFixed(3) + ')';
        var opt = { stroke: col, strokeWidth: 12, roughness: 1.6, bowing: 1.2, seed: m.seed };
        this.rough.line(m.x - m.s, m.y - m.s, m.x + m.s, m.y + m.s, opt);
        this.rough.line(m.x + m.s, m.y - m.s, m.x - m.s, m.y + m.s, opt);

        for (var h = -2; h <= 2; h++) {
          var yy = m.y + h * m.s * 0.22;
          this.rough.line(m.x - m.s * 0.7, yy, m.x + m.s * 0.7, yy, {
            stroke: 'rgba(180,255,238,' + (alpha * 0.62).toFixed(3) + ')',
            strokeWidth: 1.8,
            roughness: 1.2,
            bowing: 0.8,
            seed: m.seed + h
          });
        }
        ctx.restore();
      }, this);
      ctx.restore();
    }

    /* 居中眼位：给字幕 3D 环绕层复用同一圆心与半径 */
    eyePose() {
      return {
        x: this.trackX + this.trackW / 2,
        y: this.judgeY - this.h * 0.21,
        R: Math.min(this.trackW * 0.34, this.h * 0.20)
      };
    }

    drawMonitorEye(now) {
      var ctx = this.ctx;
      var cx = this.trackX + this.trackW / 2;
      var cy = this.judgeY - this.h * 0.21;
      var R = Math.min(this.trackW * 0.34, this.h * 0.20);
      if (R < 24) return;

      var beatP = ((now - CFG.OFFSET) / CFG.BEAT) % 1;
      if (beatP < 0) beatP += 1;

      /* 段落强度：与轨道配色同源（stage.oil 归一化），眼睛和轨道共同亮、共同暗，对齐歌曲高潮 */
      var clim = clamp((this.stage.oil - 0.08) / (0.55 - 0.08), 0, 1);
      /* 压迫/恐怖系数：桥段最空洞压抑，终段高潮紧随其后，主歌最低 */
      var op = 0.15;
      if (now >= 128 && now <= 142) op = 1.0;
      else if (now >= 142 && now <= 172) op = 0.9;
      else if (now >= 40 && now <= 128) op = 0.35;
      var energy = this.readEnergy(now);

      var k1 = Math.max(0, 1 - beatP * 3.6);
      var k2 = Math.max(0, 1 - Math.abs(beatP - 0.42) * 6.5);
      var pump = (k1 * k1 + 0.45 * k2 * k2) * (0.65 + 0.55 * clim);
      var breathe = Math.sin(now * 1.9) * 0.006;
      var wanderX = Math.cos(now * 1.35) * R * 0.028 * (0.5 + 0.5 * clim);
      var wanderY = Math.sin(now * 1.72) * R * 0.024 * (0.5 + 0.5 * clim);
      var beatPulse = Math.min(1.2, pump);

      var zx = 1 + (0.05 + 0.035 * clim) * pump + breathe;
      var zy = 1 + (0.03 + 0.02 * clim) * pump + breathe * 0.6;

      /* 蛇形蠕动：整只眼随时间持续扭转 + 两轴不对称拉伸，像在水里软塌塌扭 */
      var wrinkle = Math.sin(now * 1.7) * 0.075 * (0.5 + clim) + Math.sin(now * 0.9) * 0.035;
      var wrX = 1 + 0.05 * Math.sin(now * 1.3 + 0.6);
      var wrY = 1 - 0.05 * Math.sin(now * 1.3 + 0.6);

      ctx.save();
      ctx.translate(cx + wanderX, cy + wanderY);
      ctx.scale(zx * wrX, zy * wrY);
      ctx.rotate(wrinkle);
      ctx.translate(-cx - wanderX, -cy - wanderY);

      /* 眼周颜料入水晕开：几团不规则墨彩沿眼眶慢慢洇散、漂移，不用柔光正圆 */
      if (this.fxLevel > 0) {
        var eyeInk = flowPalette(this.stage);
        var washR = R * (1.7 + 0.25 * pump);
        /* 底层一大团淡水彩包裹整只眼 */
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.12 * beatPulse * clim;
        var wg = ctx.createRadialGradient(cx, cy, R * 0.4, cx, cy, washR);
        wg.addColorStop(0, 'rgba(180, 92, 255, 0.55)');
        wg.addColorStop(0.6, 'rgba(58, 107, 232, 0.30)');
        wg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = wg;
        this._inkBlob(ctx, cx, cy, washR, 3.7, 0.18);
        ctx.fill();
        ctx.restore();

        for (var ri = 0; ri < 5; ri++) {
          var ang = now * 0.35 + ri * 1.256;
          var ox = Math.cos(ang) * R * 1.15;
          var oy = Math.sin(ang) * R * 0.9;
          var br = R * (0.55 + 0.12 * Math.sin(now * 0.8 + ri * 1.7));
          ctx.save();
          ctx.globalCompositeOperation = 'screen';
          ctx.globalAlpha = 0.14 * beatPulse * (1 - ri * 0.08);
          var og = ctx.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, br);
          og.addColorStop(0, cssRgb(eyeInk[ri % eyeInk.length]));
          og.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = og;
          this._inkBlob(ctx, cx + ox, cy + oy, br, ri * 2.1, 0.24);
          ctx.fill();
          ctx.restore();
        }
      }

      /* 品红 / 青色差残影：每跳一下左右错开，挂在 pump 上，高潮劈得更开 */
      var gx = (5.0 + 20.0 * pump + 6.0 * this.glitch) * (1 + 0.6 * clim);
      var gy = 2.0 * pump * (1 + 0.6 * clim);
      if (this.fxLevel > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.18 * beatPulse;
        ctx.lineWidth = 2.0;
        ctx.strokeStyle = 'rgba(' + this.palB + ',0.85)';
        ctx.beginPath(); ctx.arc(cx - gx, cy - gy, R, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(' + this.palA + ',0.85)';
        ctx.beginPath(); ctx.arc(cx + gx, cy + gy, R, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }

      /* 镜底暗晕，保证眼睛在任何 MV 画面上都跳得出来 */
      ctx.save();
      var bg = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.25);
      bg.addColorStop(0, 'rgba(18,11,38,0.72)');
      bg.addColorStop(1, 'rgba(18,11,38,0)');
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.25, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      /* 誓见外框：紫霓虹 bezel 双圈 */
      ctx.save();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(180,92,255,0.55)';
      ctx.shadowColor = 'rgba(180,92,255,0.7)';
      ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(58,107,232,0.6)';
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.92, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();

      /* 眼白：比例对齐 11-12 22:20 版本；颜色保持当前中性白，不掺粉紫 */
      var sclera = ctx.createRadialGradient(cx - R * 0.20, cy - R * 0.25, R * 0.10, cx, cy, R * 0.86);
      sclera.addColorStop(0, '#FFFFFF');
      sclera.addColorStop(0.55, '#F0EEF2');
      sclera.addColorStop(1, '#C9C7D0');
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(cx, cy, R * 0.82, R * 0.72, 0, 0, Math.PI * 2);
      ctx.fillStyle = sclera;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(20,10,30,0.85)';
      ctx.stroke();
      ctx.restore();

      /* 眼白本体轻微色差：偏移量比外圈 gx 小一档，只随泵跳/出错微微裂开，不重影成两层眼 */
      var gxEye = 1.2 + 1.6 * pump + 1.2 * this.glitch;
      var gyEye = 0.8 * pump;
      if (this.fxLevel > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.10 * beatPulse;
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = 'rgba(' + this.palB + ',0.8)';
        ctx.beginPath(); ctx.ellipse(cx - gxEye, cy - gyEye, R * 0.82, R * 0.72, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(' + this.palA + ',0.8)';
        ctx.beginPath(); ctx.ellipse(cx + gxEye, cy + gyEye, R * 0.82, R * 0.72, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }

      /* 虹膜：金橙外环 + 蓝环 + 深瞳；压迫段褪成冷灰蓝、瞳孔空洞，眼球小幅游移 */
      /* 只恢复旧版眼珠/眼白比例；配色、明暗和爱心逻辑保持当前版本 */
      var iR = R * 0.46 * (0.92 + 0.16 * energy) * (1 - 0.10 * op);
      var dartX = Math.sin(now * 2.3) * iR * (0.10 + 0.08 * op);
      var dartY = Math.cos(now * 1.7) * iR * (0.08 + 0.08 * op);
      var ix = cx + dartX, iy = cy + dartY;
      var isClimax = clim > 0.75;
      ctx.save();
      /* 外环：平常是粉紫描边，高潮才切成 MV 的橙环 + 细绿环 */
      ctx.beginPath(); ctx.arc(ix, iy, iR + R * 0.06, 0, Math.PI * 2);
      ctx.fillStyle = isClimax ? '#E8A24A' : (op > 0.45 ? '#6E5636' : '#B86A9E');
      ctx.fill();
      if (isClimax) {
        ctx.beginPath(); ctx.arc(ix, iy, iR + R * 0.032, 0, Math.PI * 2);
        ctx.fillStyle = '#8FE06A';
        ctx.fill();
      }
      ctx.beginPath(); ctx.arc(ix, iy, iR, 0, Math.PI * 2);
      var iris = ctx.createRadialGradient(ix, iy, iR * 0.10, ix, iy, iR);
      if (op > 0.45) {
        iris.addColorStop(0, '#05040D');
        iris.addColorStop(0.58, '#15182E');
        iris.addColorStop(1, '#262B46');
      } else if (isClimax) {
        iris.addColorStop(0, '#2B5BD8');
        iris.addColorStop(0.62, '#3A6BE8');
        iris.addColorStop(1, '#3A5AA8');
      } else {
        iris.addColorStop(0, '#0B1030');
        iris.addColorStop(0.62, '#2B3F86');
        iris.addColorStop(1, '#3A5AA8');
      }
      ctx.fillStyle = iris;
      ctx.fill();
      /* 虹膜轻色差：比眼白再小一档的左右偏移环，避免本体糊成重影 */
      if (this.fxLevel > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.08 * beatPulse;
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = 'rgba(' + this.palB + ',0.7)';
        ctx.beginPath(); ctx.arc(ix - gxEye * 0.7, iy, iR, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(' + this.palA + ',0.7)';
        ctx.beginPath(); ctx.arc(ix + gxEye * 0.7, iy, iR, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
      if (!isClimax) {
        ctx.beginPath(); ctx.arc(ix, iy, iR * 0.62, 0, Math.PI * 2);
        ctx.fillStyle = op > 0.45 ? '#070512' : '#0B0E22';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(10,8,24,0.8)';
        ctx.stroke();
      }

      /* 压迫段：瞳孔深处一只向外抓挠、挣扎的手影，在空洞里缓缓扭动 */
      if (op > 0.4) {
        ctx.save();
        ctx.beginPath(); ctx.arc(ix, iy, iR * 0.62, 0, Math.PI * 2); ctx.clip();
        ctx.fillStyle = 'rgba(10,5,16,0.85)';
        ctx.beginPath(); ctx.ellipse(ix, iy + iR * 0.36, iR * 0.42, iR * 0.30, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(10,5,16,0.92)';
        ctx.lineWidth = iR * 0.10;
        ctx.lineCap = 'round';
        for (var fi = 0; fi < 3; fi++) {
          var fx = ix + (fi - 1) * iR * 0.22;
          var reach = iR * (0.30 + 0.12 * Math.sin(now * 3 + fi * 1.3));
          ctx.beginPath();
          ctx.moveTo(fx, iy + iR * 0.30);
          ctx.quadraticCurveTo(fx + Math.sin(now * 2 + fi) * iR * 0.08, iy + iR * 0.05, fx, iy - reach);
          ctx.stroke();
        }
        /* 手缝里漏出一点冷紫反光，像井底反光 */
        ctx.globalAlpha = 0.25 * op;
        ctx.fillStyle = '#B45CFF';
        ctx.beginPath(); ctx.ellipse(ix, iy - iR * 0.1, iR * 0.16, iR * 0.30, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }

      /* 只有高潮瞳孔里才出现薄荷爱心；平常保留深黑空洞瞳孔 */
      if (isClimax && op <= 0.4) {
        var heartS = iR * 0.62;
        this.heartPath(ctx, ix, iy, heartS);
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = '#D7F6D9';
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      /* 白色四角星放在眼球左上方，像 MV 特写里的镜头反光，不压在瞳孔中心 */
      var starX = cx - R * 0.52, starY = cy - R * 0.34;
      var starS = R * (0.16 + 0.04 * pump);
      ctx.globalAlpha = 0.82 - 0.35 * op;
      ctx.beginPath();
      ctx.moveTo(starX, starY - starS);
      ctx.lineTo(starX - starS * 0.18, starY - starS * 0.18);
      ctx.lineTo(starX - starS, starY);
      ctx.lineTo(starX - starS * 0.18, starY + starS * 0.06);
      ctx.lineTo(starX, starY + starS * 0.32);
      ctx.lineTo(starX + starS * 0.18, starY + starS * 0.06);
      ctx.lineTo(starX + starS, starY);
      ctx.lineTo(starX + starS * 0.18, starY - starS * 0.18);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,252,235,0.92)';
      ctx.fill();
      ctx.restore();

      /* 下方粗黑睫毛线，贴 MV 特写的眼线；上方眉毛状半圆已去掉 */
      ctx.save();
      ctx.strokeStyle = 'rgba(18,10,28,0.9)';
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.82, Math.PI * -0.15, Math.PI * 0.15); ctx.stroke();
      ctx.restore();

      ctx.restore();
    }


    _spawnRipple(x, y, baseR, clim) {
      var cols = flowPalette(this.stage);
      var life = 1.4 + 0.6 * clim;
      this.ripples.push({
        x: x, y: y,
        r0: baseR * 0.85, r1: baseR * (1.9 + 1.0 * clim),
        life: life, maxLife: life,
        seed: Math.random() * 6.283,
        color: cols[Math.floor(Math.random() * cols.length)],
        width: 2.2 + 2.2 * clim,
        wob: 0.07 + 0.06 * clim,
        clim: clim
      });
      if (this.ripples.length > 14) this.ripples.splice(0, this.ripples.length - 14);
    }

    /* ---- 垂落彩色柔光细流 ---- */
    _makeDrip(top) {
      var w = this.w, h = this.h;
      var len = h * (0.16 + Math.random() * 0.26);
      return {
        x: Math.random() * w,
        y: top ? -len - Math.random() * h * 0.3 : Math.random() * h,
        len: len,
        speed: h * (0.05 + Math.random() * 0.09),
        wid: 1.5 + Math.random() * 2.5,
        ci: Math.random() * DRIP_RGB.length,
        phase: Math.random() * 6.283,
        wob: 8 + Math.random() * 16
      };
    }
    _seedDrips() {
      var n = this.lowQuality ? 36 : 60;
      for (var i = 0; i < n; i++) this.drips.push(this._makeDrip(false));
    }
    drawDrips(now) {
      var ctx = this.ctx, h = this.h;
      var pulse = this.edgePulse;
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      for (var i = 0; i < this.drips.length; i++) {
        var d = this.drips[i];
        var ci = Math.floor(d.ci) % DRIP_RGB.length;
        var col = DRIP_RGB[ci];
        var a = 0.07 + 0.05 * pulse;
        var x = d.x + Math.sin(d.phase * 1.4) * d.wob * 0.3;
        var g = ctx.createLinearGradient(0, d.y - d.len, 0, d.y);
        g.addColorStop(0, 'rgba(' + col + ',0)');
        g.addColorStop(0.7, 'rgba(' + col + ',' + (a * 0.5) + ')');
        g.addColorStop(1, 'rgba(' + col + ',' + a + ')');
        ctx.strokeStyle = g;
        ctx.lineWidth = d.wid;
        ctx.shadowColor = 'rgba(' + col + ',0.5)';
        ctx.shadowBlur = 5;
        ctx.beginPath();
        ctx.moveTo(x, d.y - d.len);
        ctx.quadraticCurveTo(x + Math.sin(d.phase) * d.wob * 0.5, d.y - d.len * 0.5, x, d.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    /* ---- ref_b walker 思路：随机转向游走的发光墨团，带短拖尾 ---- */
    _seedWalkers() {
      /* 流光（游走光球）压到原来的 2/3，给流星、墨水、眼睛/爱心等特效留空间 */
      var n = this.lowQuality ? 19 : 29;
      for (var i = 0; i < n; i++) {
        var sx = Math.random() * this.w, sy = Math.random() * this.h;
        this.walkers.push({
          x: sx, y: sy, px: sx, py: sy,
          dir: Math.random() * 6.283,
          turn: 0.35 + Math.random() * 0.3,
          sign: 0,
          spd: 34 + Math.random() * 28,
          r: 8 + Math.random() * 6,
          hueOff: i * 60,
          pupil: i % AMBIENT_RGB.length,
          col: i % WALKER_FLOW.length,
          eye: false
        });
      }
      /* 高潮段额外浮出的圆形眼珠；非高潮不绘制，平时仍是彩色流光球 */
      for (var e = 0; e < 4; e++) {
        var ex = Math.random() * this.w, ey = Math.random() * this.h;
        this.walkers.push({
          x: ex, y: ey, px: ex, py: ey,
          dir: Math.random() * 6.283,
          turn: 0.25 + Math.random() * 0.25,
          sign: 0,
          spd: 22 + Math.random() * 18,
          r: 9 + Math.random() * 5,
          hueOff: e * 60,
          pupil: e % AMBIENT_RGB.length,
          eye: true
        });
      }
    }
    drawWalkers(now) {
      if (!this.wctx) return;
      if (!this.flags.walker) return;
      var wctx = this.wctx;
      var pulse = this.edgePulse;

      /* 拖尾褪色：每帧擦 0.12 透明度，轨迹快速淡出，不在光球流走后留下长印子 */
      wctx.globalCompositeOperation = 'destination-out';
      wctx.fillStyle = 'rgba(0,0,0,0.12)';
      wctx.fillRect(0, 0, this.w, this.h);

      wctx.globalCompositeOperation = 'source-over';
      wctx.lineCap = 'round';
      var climax = this.stage.oil >= 0.5;
      for (var i = 0; i < this.walkers.length; i++) {
        var wk = this.walkers[i];
        var rad = wk.r * (1 + pulse * 0.4);

        /* 高潮额外眼珠：正圆眼白 + 彩色虹膜 + 深瞳，不做椭圆拉伸 */
        if (wk.eye) {
          if (!this.flags.eye || !climax) continue;
          var pupil = AMBIENT_RGB[wk.pupil];
          wctx.shadowColor = 'rgba(' + pupil + ',0.55)';
          wctx.shadowBlur = 5;
          wctx.fillStyle = 'rgba(246,233,242,0.82)';
          wctx.beginPath();
          wctx.arc(wk.x, wk.y, rad, 0, 6.283);
          wctx.fill();
          wctx.fillStyle = 'rgba(' + pupil + ',0.95)';
          wctx.beginPath();
          wctx.arc(wk.x, wk.y, rad * 0.55, 0, 6.283);
          wctx.fill();
          wctx.fillStyle = 'rgba(18,11,38,0.92)';
          wctx.beginPath();
          wctx.arc(wk.x, wk.y, rad * 0.25, 0, 6.283);
          wctx.fill();
          wctx.shadowBlur = 0;
          continue;
        }

        var flowPal = flowPalette(this.stage);
        var colRgb = flowPal[wk.col % flowPal.length];
        var col = 'rgb(' + colRgb + ')';
        wctx.shadowColor = col;
        wctx.shadowBlur = 5;
        wctx.strokeStyle = col;
        wctx.lineWidth = rad * 1.7;
        wctx.beginPath();
        wctx.moveTo(wk.px, wk.py);
        wctx.lineTo(wk.x, wk.y);
        wctx.stroke();
        wctx.fillStyle = col;
        wctx.beginPath();
        wctx.arc(wk.x, wk.y, rad, 0, 6.283);
        wctx.fill();
      }
      wctx.shadowBlur = 0;

      /* 拖尾层 screen 贴回主画布 */
      var ctx = this.ctx;
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = 0.9;
      ctx.drawImage(this.walkCanvas, 0, 0, this.w, this.h);
      ctx.restore();
    }

    /* 不规则水波涟漪：半径按角度被噪声扭动，向外荡开并带荧光，不用标准正圆。
       环峰用 gaussian 波前 + 内圈尾波（参照 summer-engine water-ripple 配方：
       exp(-(dist-front)/w) 波前、cos 波长波、fade=1-smoothstep(age/lifetime)） */
    drawRipples(now) {
      var ctx = this.ctx;
      for (var i = 0; i < this.ripples.length; i++) {
        var rp = this.ripples[i];
        var a = clamp(rp.life / rp.maxLife, 0, 1);
        var fade = 1 - a;
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.strokeStyle = cssRgb(rp.color);
        ctx.shadowColor = cssRgb(rp.color);
        ctx.shadowBlur = 12;
        var crests = [
          { r: rp.r, alpha: a * a * 0.8, w: rp.width },
          { r: rp.r * 0.82, alpha: a * a * 0.4, w: rp.width * 0.6 }
        ];
        for (var ci = 0; ci < crests.length; ci++) {
          var cr = crests[ci];
          ctx.globalAlpha = cr.alpha;
          ctx.lineWidth = cr.w * (0.5 + fade * 0.7);
          ctx.beginPath();
          var steps = 40;
          for (var k = 0; k <= steps; k++) {
            var ang = k / steps * Math.PI * 2;
            var wr = cr.r * (1 + rp.wob * Math.sin(ang * 3 + rp.seed + now * 2.2)
                   + rp.wob * 0.6 * Math.sin(ang * 5 - rp.seed));
            var px = rp.x + Math.cos(ang) * wr;
            var py = rp.y + Math.sin(ang) * wr * 0.92;
            if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    /* 细胞分裂：从母体爱心/墨团出芽的小爱心，向外漂开、缩放自转后消散 */
    drawBuds(now) {
      var ctx = this.ctx;
      for (var i = 0; i < this.buds.length; i++) {
        var b = this.buds[i];
        var a = clamp(b.life / b.maxLife, 0, 1);
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = a * 0.7;
        ctx.translate(b.x, b.y);
        ctx.rotate(b.rot);
        var sx = b.scale * (1 + 0.15 * Math.sin(now * 3 + b.seed));
        ctx.scale(sx, sx * (1 - 0.15 * Math.sin(now * 3 + b.seed)));
        ctx.shadowColor = b.color;
        ctx.shadowBlur = 10;
        this.heartPath(ctx, 0, 0, b.size);
        ctx.fillStyle = b.color;
        ctx.fill();
        ctx.restore();
      }
    }

    drawParticles() {
      var ctx = this.ctx;
      for (var i = 0; i < this.particles.length; i++) {
        var p = this.particles[i];
        var a = clamp(p.life / p.maxLife, 0, 1);
        ctx.save();
        ctx.globalAlpha = a * a * 0.95;

        if (p.kind === 'shard') {
          /* 玻璃碎片：小多边形带着自转，落下来时有重量 */
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot + (p.spin || 0) * (1 - a));
          ctx.fillStyle = p.color;
          var sw = p.size, sh = p.size * 0.62;
          ctx.beginPath();
          ctx.moveTo(-sw / 2, -sh / 2);
          ctx.lineTo(sw / 2, -sh * 0.3);
          ctx.lineTo(sw * 0.3, sh / 2);
          ctx.lineTo(-sw / 2, sh * 0.2);
          ctx.closePath();
          ctx.fill();
        } else {
          /* 墨滴小点：不规则小滩涂，不用方块 */
          this._inkBlob(ctx, p.x, p.y, p.size * 0.6, p.rot, 0.25);
          ctx.fillStyle = p.color;
          ctx.fill();
        }
        ctx.restore();
      }

      /* 命中墨渍：不规则墨滴/油彩滩涂，随寿命铺开再化开，不用同心圆/椭圆环 */
      for (var r = 0; r < this.rings.length; r++) {
        var rg = this.rings[r];
        var ra = clamp(rg.life / rg.maxLife, 0, 1);
        var rr = rg.r0 + (rg.r1 - rg.r0) * (1 - ra);
        ctx.save();
        ctx.globalAlpha = ra * ra * (rg.fill ? 0.26 : 0.85);
        this._inkBlob(ctx, rg.x, rg.y, rr, rg.seed || 0, rg.fill ? 0.22 : 0.16);
        ctx.fillStyle = rg.color;
        if (rg.fill) ctx.fill();
        else {
          ctx.strokeStyle = rg.color;
          ctx.lineWidth = rg.width * (0.4 + ra * 0.9);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    /* 睁眼特写：到指定时间点，背景突然变成 MV 里那双蓝眼睛，半透明压在视频上 */
    /* 每条轨底部的按键提示小框：S D J K，按下时跳一下并发光 */
    drawKeyHints(now) {
      var ctx = this.ctx;
      var keys = this.keyLabels || ['S', 'D', 'J', 'K'];
      var boxW = Math.min(this.laneW * 0.55, 46);
      var boxH = boxW * 0.72;
      var y = this.h * 0.78;
      for (var i = 0; i < CFG.LANES; i++) {
        var cx = this.laneCenter(i);
        var f = this.keyFlash[i] || 0;
        var pressed = this.held[i] || f > 0.4;
        var bump = pressed ? -4 : 0;
        ctx.save();
        ctx.translate(cx, y + bump - f * 3);
        /* 框 */
        ctx.globalAlpha = 0.55 + 0.4 * f;
        ctx.fillStyle = pressed ? 'rgba(255,255,255,0.92)' : 'rgba(20,22,30,0.78)';
        ctx.strokeStyle = this.laneColor(i);
        ctx.lineWidth = 1.5;
        roundRect(ctx, -boxW/2, -boxH/2, boxW, boxH, 6);
        ctx.fill();
        ctx.stroke();
        /* 字母 */
        ctx.fillStyle = pressed ? '#120B26' : this.laneColor(i);
        ctx.font = '800 ' + Math.round(boxW * 0.42) + 'px "Helvetica Neue", Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(keys[i], 0, 1);
        ctx.restore();
      }
    }

    /* 大连击数：传统音游那种"x123"，居中偏上，命中瞬间弹一下，带青紫错位 */
    drawCombo(now) {
      if (this.combo < 5) return;
      var ctx = this.ctx;
      var cx = this.w / 2;
      var cy = this.h * (this.isPortrait ? 0.52 : 0.55);
      var pop = this.comboPop;
      /* 弹性回弹：pop 从 1 衰减到 0，用 ease-out-back 让数字先冲过头再落回 */
      var t = 1 - pop;                 // 0..1
      var overshoot = 1 + 0.35 * pop * Math.sin(t * Math.PI);
      var beat = Math.exp(-((now - CFG.OFFSET) / CFG.BEAT % 1) * 6.5);
      var breathe = 1 + 0.04 * beat;
      var scale = overshoot * breathe;
      var fs = Math.round(Math.min(this.w * 0.13, 88) * scale);
      var txt = 'x' + this.combo;

      /* 里程碑：10/20/50/100 倍的时候闪一下、转一下 */
      var milestone = (this.combo === 10 || this.combo === 20 || this.combo === 50 || this.combo === 100);
      var rot = (milestone ? 0.18 : 0) * pop + Math.sin(now * 3.1) * 0.02;
      var rgbShift = (4 + 14 * pop) + (milestone ? 10 * pop : 0);

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '900 ' + fs + 'px "Dela Gothic One", "ZCOOL KuaiLe", "Rubik Glitch", "Helvetica Neue", Arial, sans-serif';
      /* 与字幕同款深黑描边：先描边后填色，转角圆接避免缺口 */
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(10,7,22,0.95)';
      ctx.lineWidth = Math.max(2, Math.round(fs * 0.05));

      /* 发光：跟随字幕粉端 */
      ctx.shadowColor = 'rgba(255,92,158,0.6)';
      ctx.shadowBlur = 18 + 22 * pop;

      /* 拖影：命中瞬间往三个方向甩残影，粉/蓝交替（字幕双色） */
      for (var g = 3; g >= 1; g--) {
        var ga = pop * 0.18 * (1 - g / 4);
        ctx.globalAlpha = ga;
        ctx.fillStyle = g % 2 ? 'rgb(255,92,158)' : 'rgb(58,107,232)';
        ctx.fillText(txt, -rgbShift * g * 0.6, g * 2);
      }

      /* 四色标 3D 错位：两层偏开，主数字逐字红→粉→蓝→紫缓变 */
      ctx.globalAlpha = 0.9;
      ctx.strokeText(txt, -rgbShift, 0);
      ctx.fillStyle = 'rgb(58,107,232)';
      ctx.fillText(txt, -rgbShift, 0);
      ctx.strokeText(txt, rgbShift, 0);
      ctx.fillStyle = 'rgb(255,92,158)';
      ctx.fillText(txt, rgbShift, 0);
      ctx.shadowBlur = 8;
      var cChars = txt.split('');
      var cn = cChars.length;
      var cw = cChars.map(function (ch) { return ctx.measureText(ch).width; });
      var cTotal = cw.reduce(function (a, b) { return a + b; }, 0);
      var cx0 = -cTotal / 2;
      for (var ci = 0; ci < cn; ci++) {
        var gt = cn === 1 ? 0.5 : ci / (cn - 1) + 0.12 * Math.sin(now * 2.6 + ci * 0.35);
        gt = clamp(gt, 0, 1);
        var chX = cx0 + cw[ci] / 2;
        ctx.strokeText(cChars[ci], chX, 0);
        ctx.fillStyle = this._comboLerp(gt, now);
        ctx.fillText(cChars[ci], chX, 0);
        cx0 += cw[ci];
      }

      /* CHAIN 小字：细黑描边衬底 */
      ctx.shadowBlur = 0;
      ctx.font = '800 ' + Math.round(fs * 0.26) + 'px "Dela Gothic One", "ZCOOL KuaiLe", "Rubik Glitch", "Helvetica Neue", Arial, sans-serif';
      ctx.lineWidth = Math.max(1, Math.round(fs * 0.025));
      ctx.globalAlpha = 0.75;
      ctx.strokeText('C H A I N', 0, fs * 0.78);
      ctx.fillStyle = 'rgba(242, 236, 255,0.85)';
      ctx.fillText('C H A I N', 0, fs * 0.78);

      /* 里程碑外圈光环 */
      if (milestone) {
        ctx.globalAlpha = pop * 0.7;
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, fs * (1.1 + (1 - pop) * 0.6), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawPopups() {
      var ctx = this.ctx;
      for (var i = 0; i < this.popups.length; i++) {
        var p = this.popups[i];
        var a = clamp(p.life / p.maxLife, 0, 1);

        /* 命中爆点：没有文字，只是一团很快消失的白色扁光 */
        if (p.flash) {
          ctx.save();
          ctx.globalAlpha = a * a * 0.55;
          var fg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.flash);
          fg.addColorStop(0, 'rgba(255,255,255,0.95)');
          fg.addColorStop(0.5, 'rgba(255,255,255,0.30)');
          fg.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = fg;
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, p.flash * (1 + (1 - a) * 0.5), p.flash * 0.62 * (1 + (1 - a) * 0.5), 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          continue;
        }

        var scale = 1 + (1 - a) * 0.25;
        ctx.save();
        ctx.globalAlpha = a;
        ctx.translate(p.x, p.y);
        ctx.scale(scale, scale);
        ctx.font = '700 ' + p.size + 'px ui-monospace, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(8,8,10,0.9)';
        ctx.strokeText(p.text, 0, 0);
        /* 判定字也带一层蓝粉错位，和整屏的电子错误风统一 */
        ctx.globalAlpha = a * 0.55;
        ctx.fillStyle = 'rgba(58, 107, 232, 1)';
        ctx.fillText(p.text, -1.4, 0);
        ctx.fillStyle = 'rgba(255, 92, 158, 1)';
        ctx.fillText(p.text, 1.4, 0);
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, 0, 0);
        ctx.restore();
      }
    }

    /* 屏幕外那一圈红蓝晕：不闪整屏，只让光从画面四边往里渗，随每一拍扩张一次。
       这是"闪屏收敛"之后撑住整场爆感的主力 */
    drawEdgeHalo(now) {
      var p = this.edgePulse;
      if (this.fxLevel === 0) p *= 0.35;
      if (p <= 0.001) return;

      var ctx = this.ctx;
      var w = this.w, h = this.h;
      var k = p * p;
      var grow = (1 - p) * Math.min(w, h) * 0.06;
      var pal = [this.palA, this.palB, '242,236,255'];

      ctx.save();
      ctx.globalCompositeOperation = 'screen';

      /* 油膜式混光：一圈位置不断漂移的不规则软团块，相邻团块颜色互相交融，
         不做竖向分段色带，也不画轮廓线。 */
      var blobs = 12;
      for (var b = 0; b < blobs; b++) {
        var seed = b * 12.9898;
        var side = b % 4;
        var tt = ((b * 0.37 + now * 0.05) % 1);
        var x, y;
        if (side === 0) { x = w * tt; y = -grow + Math.sin(now * 0.8 + seed) * h * 0.03; }
        else if (side === 1) { x = w + grow; y = h * tt; }
        else if (side === 2) { x = w * (1 - tt); y = h + grow; }
        else { x = -grow; y = h * (1 - tt); }
        x += Math.sin(now * 0.6 + seed) * w * 0.03;
        y += Math.cos(now * 0.5 + seed * 1.3) * h * 0.03;

        var r = Math.min(w, h) * (0.16 + 0.05 * Math.sin(seed + now * 0.7));
        var ca = pal[b % pal.length];
        var cb = pal[(b + 2) % pal.length];
        var g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(' + ca + ',' + (0.10 * k).toFixed(3) + ')');
        g.addColorStop(0.55, 'rgba(' + cb + ',' + (0.06 * k).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(' + cb + ',0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }

      /* 压迫段：四周压暗成深紫暗红 vignette，像被誓见困在中间，氛围往下沉 */
      var op2 = 0.15;
      if (now >= 128 && now <= 142) op2 = 1.0;
      else if (now >= 142 && now <= 172) op2 = 0.9;
      else if (now >= 40 && now <= 128) op2 = 0.35;
      if (op2 > 0.3) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        var vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.72);
        vg.addColorStop(0, 'rgba(10,5,18,0)');
        vg.addColorStop(1, 'rgba(26,6,22,' + (0.5 * op2).toFixed(3) + ')');
        ctx.fillStyle = vg;
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'screen';
        var rg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.7);
        rg.addColorStop(0, 'rgba(0,0,0,0)');
        rg.addColorStop(1, 'rgba(120,20,60,' + (0.18 * op2).toFixed(3) + ')');
        ctx.fillStyle = rg;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }

      ctx.restore();
    }

    destroy() {
      window.removeEventListener('resize', this._boundResize);
      window.removeEventListener('orientationchange', this._boundResize);
    }
  }

  global.RhythmGame = RhythmGame;
  global.GAME_CFG = CFG;
})(window);
