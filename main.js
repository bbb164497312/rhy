/* 主控：装配音频 / 谱面 / 游戏循环 / 输入 / 界面 */

(function () {
  'use strict';

  var canvas = document.getElementById('game');
  var videoEl = document.getElementById('bg-video');
  var overlay = document.getElementById('overlay');
  var hud = document.getElementById('hud');
  var controls = document.getElementById('controls');
  var bootHint = document.getElementById('boot-hint');

  var elScore = document.getElementById('hud-score');
  var elAcc = document.getElementById('hud-acc');
  var elCombo = document.getElementById('hud-combo');
  var elProgress = document.getElementById('hud-progress');

  var elChroma = document.getElementById('chroma');
  var elOil = document.getElementById('oil');
  var elFluid = document.getElementById('fluid');
  var stageEl = document.getElementById('stage');
  var elLyric = document.getElementById('lyric');
  var elLyricText = document.getElementById('lyric-text');

  /* 每帧样式写入缓存：值没变化就不碰 DOM / 合成层，避免重复触发样式重算 */
  var _ca = '', _lx = '', _oilOp = '', _fluidOp = '';
  var _stageFilter = '', _stageTransform = '';
  var _chromaGlitch = null, _lyricGlitch = null;
  var _layersActive = null;
  var _palA = '', _palB = '', _palArgb = '', _palBrgb = '';
  var lastAuto = false;
  var autoMode = false; /* 开始页"自动打"开关；true 时中央播放键/空格进入纯享演示 */
  var settings = {
    diff: 0,   /* 0 简单 1 普通 2 困难：默认简单档，谱面密度系数 */
    keyScheme: 'sdjk', /* 键位方案：sdjk=S D J K，asdf=A S D F */
    mv: true,       /* MV 背景视频显隐 */
    walker: true,   /* 流光：游走光球 */
    meteor: true,   /* 流星：强拍放射短线 */
    ink: true,      /* 墨水：油膜混彩 + 流体墨水两层 */
    eye: true       /* 眼珠：游走眼睛贴纸 */
  };
  var lyricIdx = -1;
  var lyricLines = [];
  var LYRIC_SWAP = 0.38; /* 换句离场/入场时长（秒） */

  function buildLyricLine(text, t) {
    var line = document.createElement('div');
    line.className = 'lyric-line';
    var chars = [];
    var arr = String(text).split('');
    for (var ci = 0; ci < arr.length; ci++) {
      var ch = document.createElement('span');
      ch.className = 'lyric-char';
      ch.textContent = arr[ci];
      line.appendChild(ch);
      chars.push(ch);
    }
    elLyricText.appendChild(line);
    return { el: line, chars: chars, leaving: false, born: t, leaveStart: 0 };
  }

  function markLyricLeaving(t) {
    for (var i = 0; i < lyricLines.length; i++) {
      if (!lyricLines[i].leaving) { lyricLines[i].leaving = true; lyricLines[i].leaveStart = t; }
    }
  }

  function pruneLyricLines(t) {
    for (var i = lyricLines.length - 1; i >= 0; i--) {
      var ln = lyricLines[i];
      if (ln.leaving && t - ln.leaveStart >= LYRIC_SWAP) {
        if (ln.el.parentNode) ln.el.parentNode.removeChild(ln.el);
        lyricLines.splice(i, 1);
      }
    }
  }

  /* 按时间找当前该显示的那句中文字幕（来自 MV 官方歌词分段对齐） */
  function updateLyric(t) {
    var L = window.LYRIC || [];
    var idx = -1;
    for (var i = 0; i < L.length; i++) {
      if (t >= L[i].t) idx = i; else break;
    }
    if (idx < 0) {
      markLyricLeaving(t);
      lyricIdx = -1;
      pruneLyricLines(t);
      if (!lyricLines.length) elLyric.classList.add('is-hidden');
      return;
    }
    /* 两条字幕之间有空白段（MV 那一段本来就没字幕），别一直挂着上一句 */
    if (t - L[idx].t > 7.2) {
      markLyricLeaving(t);
      lyricIdx = idx;
      pruneLyricLines(t);
      if (!lyricLines.length) elLyric.classList.add('is-hidden');
      return;
    }
    if (idx !== lyricIdx) {
      lyricIdx = idx;
      markLyricLeaving(t);
      lyricLines.push(buildLyricLine(L[idx].x, t));
      elLyric.classList.remove('is-hidden');
    }
  }

  function parseRGB(s) {
    return s.split(',').map(function (v) { return Number(v); });
  }
  function lerpRGB(a, b, t) {
    var A = parseRGB(a), B = parseRGB(b);
    var r = Math.round(A[0] + (B[0] - A[0]) * t);
    var g = Math.round(A[1] + (B[1] - A[1]) * t);
    var bl = Math.round(A[2] + (B[2] - A[2]) * t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }

  /* 字幕绕居中眼做土星环式 3D 字环：首字锚在左前侧，沿前半圈读到右侧，后半圈绕到眼后并被眼球遮住 */
  function updateLyricOrbit(stage) {
    if (!elLyricText || !game || !game.eyePose) return;
    if (!lyricLines.length) return;
    var pose = game.eyePose();
    elLyric.style.left = pose.x + 'px';
    elLyric.style.top = pose.y + 'px';
    var rx = Math.max(52, pose.R * 1.65);
    var ry = Math.max(20, pose.R * 0.52);
    var sway = Math.sin(game.time * 0.8) * 0.04;
    var rot = game.time * 0.10;

    for (var li = 0; li < lyricLines.length; li++) {
      var ln = lyricLines[li];
      var n = ln.chars.length;
      var longScale = n > 18 ? 0.84 : 1;

      /* 入场：新句从环侧顺时针滑入；离场：旧句顺时针加速滑出并淡出 */
      var pIn = ln.leaving ? 1 : Math.min(1, (game.time - ln.born) / LYRIC_SWAP);
      var pOut = ln.leaving ? Math.min(1, (game.time - ln.leaveStart) / LYRIC_SWAP) : 0;
      var enterAng = (1 - pIn) * -0.9;
      var leaveAng = pOut * 1.7;
      var fade = ln.leaving ? (1 - pOut) : pIn;

      for (var i = 0; i < n; i++) {
        var ch = ln.chars[i];
        var baseAng = n === 1 ? 0 : -Math.PI / 2 + (i / n) * Math.PI * 2;
        var ang = baseAng + rot + sway + enterAng + leaveAng;
        var sx = Math.sin(ang);
        var cz = Math.cos(ang);
        var front = cz >= 0;
        var depth = (cz + 1) / 2;
        var x = sx * rx;
        /* 逐字独立轻微浮动：相位错开、幅度小，不整体同步 */
        var bobY = 2.5 * Math.sin(game.time * 2.2 + i * 1.3);
        var y = cz * ry + bobY;
        var dist = Math.sqrt(x * x + y * y);
        var hiddenByEye = !front && dist < pose.R * 0.95;
        /* 逐字独立轻微伸缩脉动，各字相位不同 */
        var pulse = 1 + 0.05 * Math.sin(game.time * 3.0 + i * 1.7);
        var scale = (front ? (0.78 + 0.22 * depth) : 0.62) * longScale * pulse * (1 - 0.18 * pOut);
        var alpha = (hiddenByEye ? 0 : (front ? (0.58 + 0.42 * depth) : 0.32)) * fade;
        var tiltX = front ? 26 * depth : 12;
        var tiltY = sx * 34;
        ch.style.transform = 'translate(-50%,-50%) translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) rotateX(' + tiltX.toFixed(1) + 'deg) rotateY(' + tiltY.toFixed(1) + 'deg) scale(' + scale.toFixed(3) + ')';
        ch.style.opacity = alpha.toFixed(3);
        ch.style.zIndex = front ? String(100 + Math.round(depth * 100)) : String(Math.round(depth * 10));
        var gradT = n === 1 ? 0.5 : i / (n - 1) + 0.12 * Math.sin(game.time * 2.6 + i * 0.35);
        gradT = Math.max(0, Math.min(1, gradT));
        ch.style.color = lerpRGB(stage.pal[0], stage.pal[1], gradT);
      }
    }
    pruneLyricLines(game.time);
  }

  function stageFor(t) {
    return (window.stageInfo ? window.stageInfo(t) : { pal: ['58,107,232', '255,92,158'], oil: 0.3 });
  }

  var currentPal = null;

  function applyStage(t) {
    var raw = stageFor(t);
    /* 全局阶段双色先在两个 RGB 数组间快速插值，避免段落切换时硬跳；字幕仍固定红蓝 */
    var target = [parseRGB(raw.pal[0]), parseRGB(raw.pal[1])];
    if (!currentPal) currentPal = [target[0].slice(), target[1].slice()];
    var k = 0.42;
    for (var c = 0; c < 2; c++) {
      for (var ch = 0; ch < 3; ch++) {
        currentPal[c][ch] += (target[c][ch] - currentPal[c][ch]) * k;
      }
    }
    var palCss = [
      'rgb(' + Math.round(currentPal[0][0]) + ',' + Math.round(currentPal[0][1]) + ',' + Math.round(currentPal[0][2]) + ')',
      'rgb(' + Math.round(currentPal[1][0]) + ',' + Math.round(currentPal[1][1]) + ',' + Math.round(currentPal[1][2]) + ')'
    ];
    var palRgb = [
      Math.round(currentPal[0][0]) + ',' + Math.round(currentPal[0][1]) + ',' + Math.round(currentPal[0][2]),
      Math.round(currentPal[1][0]) + ',' + Math.round(currentPal[1][1]) + ',' + Math.round(currentPal[1][2])
    ];
    var root = document.documentElement.style;
    if (palCss[0] !== _palA) { root.setProperty('--pal-a', palCss[0]); _palA = palCss[0]; }
    if (palCss[1] !== _palB) { root.setProperty('--pal-b', palCss[1]); _palB = palCss[1]; }
    if (palRgb[0] !== _palArgb) { root.setProperty('--pal-a-rgb', palRgb[0]); _palArgb = palRgb[0]; }
    if (palRgb[1] !== _palBrgb) { root.setProperty('--pal-b-rgb', palRgb[1]); _palBrgb = palRgb[1]; }
    return { pal: ['255,92,158', '58,107,232'], oil: raw.oil };
  }

  var audio = new window.AudioEngine();
  var game = null;
  var rafId = 0;
  var lastTs = 0;
  var chartData = null;
  var finished = false;
  var botPlayed = false;
  var fluidLayer = null;
  var currentPanel = 'start';

  var BEST_KEY = 'monitoring.best';

  /* ---------- 界面切换 ---------- */

  function showPanel(name) {
    currentPanel = name;
    var panels = ['start', 'pause', 'result', 'settings'];
    panels.forEach(function (n) {
      var el = document.getElementById('panel-' + n);
      if (!el) return;
      el.classList.toggle('is-hidden', n !== name);
    });
    overlay.classList.toggle('is-hidden', !name);
  }

  function hudVisible(on) {
    hud.classList.toggle('is-hidden', !on);
    controls.classList.toggle('is-hidden', !on);
  }

  /* ---------- 分数显示 ---------- */

  function pad(n, len) {
    var s = String(Math.floor(n));
    while (s.length < len) s = '0' + s;
    return s;
  }

  var _lastScore = '', _lastAcc = '', _lastCombo = -1, _lastProg = '', _lastHot = null;
  function onStats(s) {
    var sc = pad(s.score, 7);
    if (sc !== _lastScore) { elScore.textContent = sc; _lastScore = sc; }
    var ac = s.accuracy.toFixed(2) + '%';
    if (ac !== _lastAcc) { elAcc.textContent = ac; _lastAcc = ac; }
    if (s.combo !== _lastCombo) { elCombo.textContent = s.combo; _lastCombo = s.combo; }
    var hot = s.combo >= 50;
    if (hot !== _lastHot) { elCombo.classList.toggle('is-hot', hot); _lastHot = hot; }
    var pw = (s.progress * 100).toFixed(1) + '%';
    if (pw !== _lastProg) { elProgress.style.width = pw; _lastProg = pw; }
  }

  /* ---------- 最高分 ---------- */

  function readBest() {
    try {
      return parseInt(window.localStorage.getItem(BEST_KEY) || '0', 10) || 0;
    } catch (e) {
      return 0;
    }
  }

  function writeBest(v) {
    try {
      window.localStorage.setItem(BEST_KEY, String(v));
    } catch (e) { /* 隐私模式忽略 */ }
  }

  /* ---------- 开始一局 ---------- */

  function resetLyric() {
    for (var i = 0; i < lyricLines.length; i++) {
      if (lyricLines[i].el.parentNode) lyricLines[i].el.parentNode.removeChild(lyricLines[i].el);
    }
    lyricLines.length = 0;
    lyricIdx = -1;
    elLyric.classList.add('is-hidden');
  }

  function startRound(from, auto) {
    finished = false;
    botPlayed = false;
    resetLyric();

    var t0 = (typeof from === 'number' && isFinite(from) && from > 0) ? from : 0;

    chartData = window.ChartBuilder.buildChart(audio.duration || 181.334, 20250319, settings.diff);

    game.prepare(chartData);
    game.auto = !!auto;

    /* 先把画面拨到起点，避免第一帧还停在上一局末尾 */
    game.time = t0;
    game.render();

    showPanel(null);
    hudVisible(true);

    try { videoEl.currentTime = t0; } catch (e) { /* 忽略 */ }
    videoEl.classList.add('is-live');
    var vp = videoEl.play();
    if (vp && vp.catch) vp.catch(function () { /* 忽略 */ });

    audio.seek(t0);
    audio.play(t0);
    game.start(t0);

    lastTs = 0;
    if (!rafId) rafId = requestAnimationFrame(loop);
  }

  /* ---------- 暂停 / 恢复 / 结束 ---------- */

  function stopLayers() {
    _layersActive = false;
    if (window.OilLayer && window.OilLayer.setActive) window.OilLayer.setActive(false);
    if (fluidLayer && fluidLayer.setActive) fluidLayer.setActive(false);
  }

  function pauseRound() {
    if (!game || !game.running || game.paused) return;
    audio.pause();
    videoEl.pause();
    game.pause();
    showPanel('pause');
  }

  function resumeRound() {
    audio.play();
    try { videoEl.currentTime = audio.time; } catch (e) { /* 忽略 */ }
    var vp = videoEl.play();
    if (vp && vp.catch) vp.catch(function () { /* 忽略 */ });
    game.resume();
    showPanel(null);
    lastTs = 0;
  }

  function quitRound() {
    audio.pause();
    audio.seek(0);
    videoEl.pause();
    videoEl.classList.remove('is-live');
    try { videoEl.currentTime = 0; } catch (e) { /* 忽略 */ }
    game.stop();
    hudVisible(false);
    chartData = null;
    stopLayers();
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    showPanel('start');
    syncAutoUI();
  }

  function endRound() {
    if (finished) return;
    finished = true;

    audio.pause();
    videoEl.pause();
    videoEl.classList.remove('is-live');
    game.stop();
    hudVisible(false);
    stopLayers();

    var acc = 0;
    var judged = game.perfect + game.good + game.miss;
    /* GOOD 也算正确，只有 MISS 才扣准确率 */
    if (judged > 0) acc = (game.perfect + game.good) / judged * 100;
    var goodRatio = judged > 0 ? game.good / judged : 0;

    var grade = 'D';
    var verdict = '再盯紧一点拍子。';
    var isGood = false;

    /* 准确率只判「有没有漏」，评级再看 GOOD 占多少，两者不冲突。
       分数线对齐主流下落式（osu!mania 口径）：S≥95 / A≥90 / B≥80 / C≥70 */
    if (acc >= 95 && goodRatio <= 0.10) { grade = 'S'; verdict = '近乎完美。几乎全是 PERFECT。'; isGood = true; }
    else if (acc >= 90 && goodRatio <= 0.35) { grade = 'A'; verdict = '没漏什么。几拍压得不够准。'; isGood = true; }
    else if (acc >= 80) { grade = 'B'; verdict = '节奏跟住了。再准一点更好。'; isGood = true; }
    else if (acc >= 70) { grade = 'C'; verdict = '漏得有点多。再盯紧拍子。'; }
    else { grade = 'D'; verdict = '错误不少。多练几局就顺手了。'; }

    var best = readBest();
    if (game.score > best) { best = game.score; writeBest(best); }

    document.getElementById('r-grade').textContent = grade;
    document.getElementById('r-grade').className = 'result-grade ' + (isGood ? 'is-good' : 'is-bad');
    document.getElementById('r-verdict').textContent = verdict;
    document.getElementById('r-score').textContent = String(game.score);
    document.getElementById('r-combo').textContent = String(game.maxCombo);
    document.getElementById('r-acc').textContent = acc.toFixed(2) + '%';
    document.getElementById('r-best').textContent = String(best);

    showPanel('result');
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }

  /* ---------- 主循环 ---------- */

  function loop(ts) {
    rafId = requestAnimationFrame(loop);

    if (!lastTs) lastTs = ts;
    var dt = (ts - lastTs) / 1000;
    lastTs = ts;
    if (dt > 0.05) dt = 0.05;
    if (dt < 0) dt = 0;

    game.update(dt);
    game.render();

    var inRound = game.running && !game.paused;

    /* 两个 WebGL 流体层只在对局中且墨水开关打开时模拟渲染；
       开始页 / 暂停 / 结算 / 关闭开关时暂停 rAF，把 GPU 让给视频解码与合成 */
    var layersOn = inRound && settings.ink;
    if (layersOn !== _layersActive) {
      _layersActive = layersOn;
      if (window.OilLayer && window.OilLayer.setActive) window.OilLayer.setActive(layersOn);
      if (fluidLayer && fluidLayer.setActive) fluidLayer.setActive(layersOn);
    }

    /* 视频闪频：由游戏状态驱动 CSS */
    if (inRound) {
      /* 对局中音频若被停滞/系统挂起暂停，自动续播，防止歌突然中断 */
      audio.recover();
      /* 视频同样兜底：若 play() 被浏览器拒绝后一直停在暗帧，就绪后自动续播 */
      if (videoEl.paused && videoEl.readyState >= 1) {
        var vp2 = videoEl.play();
        if (vp2 && vp2.catch) vp2.catch(function () { /* 忽略 */ });
      }
      /* 整屏白闪已关闭：视频不再按拍切 is-flash，色差也不因闪屏瞬间拉满 */
      var flashing = false;
      videoEl.classList.remove('is-flash');

      updateLyric(game.time);
      var stage = applyStage(game.time);
      updateLyricOrbit(stage);

      /* 高潮全局 boost：副歌段常驻提饱和/对比/亮度，节拍脉冲时再叠加轻微反色、偏色和扭曲；
         不做大面积反色，也不让整屏只在击拍瞬间才变色 */
      var pulse = game.edgePulse || 0;
      var glitch = game.glitch || 0;
      var climaxBase = stage.oil >= 0.5 ? Math.min(1, 0.42 + 0.58 * pulse) : 0;
      var climaxBoost = climaxBase > 0.02 ? Math.min(1, pulse) : 0;
      var wild = Math.max(climaxBase, glitch);
      var invertAmt = 0.045 + 0.22 * climaxBoost;
      var skewAmt = glitch * 1.8 + climaxBoost * 1.2 * Math.sin(game.time * 11);
      var scaleAmt = 1 + 0.012 * climaxBase;
      var shakeX = (Math.sin(game.time * 31) * 2.4 + Math.sin(game.time * 17) * 1.6) * climaxBoost;
      var shakeY = (Math.cos(game.time * 27) * 2.0) * climaxBoost;

      /* 红蓝残影：平时常驻一层很低的强度（就是"没戴 3D 眼镜"那种感觉），
         命中时拔高，出错时拉满，只在手势舞段落才跟整屏闪同步 */
      if (elChroma) {
        var baseCa = game.fxLevel > 0
          ? 0.10 + 0.30 * glitch + 0.10 * pulse
          : 0.04;
        var finalCa = baseCa;
        if (climaxBase > 0.02) {
          finalCa = Math.min(0.92, 0.10 + 0.18 * climaxBase + 0.12 * climaxBoost + 0.30 * glitch);
        }
        if (finalCa > 0.92) finalCa = 0.92;
        var caStr = finalCa.toFixed(3);
        if (caStr !== _ca) { elChroma.style.setProperty('--ca', caStr); _ca = caStr; }
        var cGl = glitch > 0.55 && game.fxLevel > 0;
        if (cGl !== _chromaGlitch) { elChroma.classList.toggle('is-glitch', cGl); _chromaGlitch = cGl; }
      }

      /* 字幕也吃同一套红蓝错位：错的瞬间字幕会左右撕开一下 */
      if (elLyricText) {
        var lxVal = 1.4 + 5.5 * Math.min(1, glitch + pulse * 0.35);
        var lxStr = lxVal.toFixed(2) + 'px';
        if (lxStr !== _lx) { elLyricText.style.setProperty('--lx', lxStr); _lx = lxStr; }
        var lGl = glitch > 0.5;
        if (lGl !== _lyricGlitch) { elLyric.classList.toggle('is-glitch', lGl); _lyricGlitch = lGl; }
      }

      if (stageEl) {
        /* 只保留轻量反色/饱和/对比/亮度；去掉整屏 blur 邻域采样和随时间连续变的 hue-rotate——
           两者会让父容器每帧变更 filter、强制整棵合成树软件重绘，是后段高潮掉帧的主因 */
        var fStr = wild > 0.02
          ? 'invert(' + invertAmt.toFixed(3) + ') saturate(' + (1.35 + 0.55 * climaxBase).toFixed(2) + ') contrast(' + (1.12 + 0.18 * climaxBase).toFixed(2) + ') brightness(' + (1.03 + 0.08 * climaxBase).toFixed(2) + ')'
          : '';
        if (fStr !== _stageFilter) { stageEl.style.filter = fStr; _stageFilter = fStr; }
        var tStr = 'translate(' + shakeX.toFixed(2) + 'px,' + shakeY.toFixed(2) + 'px) skewX(' + skewAmt.toFixed(2) + 'deg) scale(' + scaleAmt.toFixed(3) + ')';
        if (tStr !== _stageTransform) { stageEl.style.transform = tStr; _stageTransform = tStr; }
      }


      /* 混彩流光按段落开关：主歌/桥段压到很弱，副歌才铺开；强弱再吃节拍脉冲 */
      if (settings.ink && window.OilLayer && window.OilLayer.setEnergy) {
        var oilEnergy = Math.min(0.95, stage.oil + 0.12 * pulse + 0.10 * glitch + 0.12 * climaxBase);
        window.OilLayer.setEnergy(oilEnergy);
        var oilOp = Math.max(0.10, Math.min(0.92, stage.oil + 0.08 * climaxBase)).toFixed(3);
        if (elOil && oilOp !== _oilOp) { elOil.style.opacity = oilOp; _oilOp = oilOp; }
        var eyeNX = (game.trackX + game.trackW / 2) / game.w;
        var eyeNY = (game.judgeY - game.h * 0.21) / game.h;
        var eyeNR = Math.min(game.trackW * 0.34, game.h * 0.20) / Math.min(game.w, game.h);
        window.OilLayer.setEye(eyeNX, eyeNY, Math.max(0.12, eyeNR), 1, pulse);
      }

      /* 墨水流体层：前期马卡龙段浓、亮、多，补梦幻感；高潮段收弱，避免背景混乱 */
      if (settings.ink && fluidLayer) {
        var fluidClimax = stage.oil >= 0.5;
        if (fluidClimax) {
          fluidLayer.setStrength(0.35);
          if (elFluid) { _fluidOp = '0.12'; elFluid.style.opacity = _fluidOp; }
        } else {
          fluidLayer.setStrength(1.0);
          if (fluidLayer.setPulse) fluidLayer.setPulse(0.25 + 0.5 * pulse);
          var fluidOp = (0.40 + 0.10 * Math.min(1, stage.oil * 2)).toFixed(3);
          if (elFluid && fluidOp !== _fluidOp) { elFluid.style.opacity = fluidOp; _fluidOp = fluidOp; }
        }
      }
    } else {
      applyStage(0);
      if (elChroma) {
        elChroma.classList.remove('is-glitch'); _chromaGlitch = false;
        elChroma.style.setProperty('--ca', '0'); _ca = '0';
      }
      if (elLyric) { elLyric.classList.remove('is-glitch'); _lyricGlitch = false; }
      if (window.OilLayer && window.OilLayer.setEye) window.OilLayer.setEye(0.5, 0.5, 0.2, 0, 0);
      if (elOil) { elOil.style.opacity = '0.05'; _oilOp = '0.05'; }
      if (elFluid) { elFluid.style.opacity = '0.06'; _fluidOp = '0.06'; }
      if (stageEl) { stageEl.style.filter = ''; _stageFilter = ''; stageEl.style.transform = ''; _stageTransform = ''; }
    }
  }

  /* ---------- 输入 ---------- */

  /* 两套键位方案：sdjk 为主手位，保留备用 QWOP 与数字键；asdf 为四连排手位 */
  var KEY_SCHEMES = {
    sdjk: {
      keys: ['S', 'D', 'J', 'K'],
      map: { 's': 0, 'd': 1, 'j': 2, 'k': 3, 'q': 0, 'w': 1, 'o': 2, 'p': 3, '1': 0, '2': 1, '3': 2, '4': 3 }
    },
    asdf: {
      keys: ['A', 'S', 'D', 'F'],
      map: { 'a': 0, 's': 1, 'd': 2, 'f': 3 }
    }
  };
  var KEYMAP = KEY_SCHEMES[settings.keyScheme].map;

  function laneFromX(clientX) {
    var rect = canvas.getBoundingClientRect();
    var x = clientX - rect.left;
    var rel = (x - game.trackX) / game.laneW;
    if (!isFinite(rel)) rel = 0;
    if (rel < 0) rel = 0;
    if (rel > 3.999) rel = 3.999;
    return Math.floor(rel);
  }

  window.addEventListener('keydown', function (e) {
    if (e.repeat) return;
    var k = e.key.toLowerCase();
    var atStart = currentPanel === 'start' && (!game || !game.running);
    if (e.code === 'Space' || k === ' ') {
      e.preventDefault();
      /* 空格：开始界面按当前"自动打"开关开局；对局 / 暂停 / 结算 / 设置面板里不做任何事 */
      if (atStart) {
        lastAuto = autoMode;
        startRound(0, autoMode);
      }
      return;
    }
    if (k === 'q') {
      /* Q：开始界面直接进入自动打（纯享演示）；对局中 Q 仍按原键位映射，不切 bot */
      if (atStart) {
        e.preventDefault();
        autoMode = true;
        lastAuto = true;
        syncAutoUI();
        startRound(0, true);
      }
      return;
    }
    if (k === 'escape') {
      if (game && game.running && !game.paused) pauseRound();
      else if (game && game.paused) resumeRound();
      return;
    }
    if (!(k in KEYMAP)) return;
    e.preventDefault();
    if (!game || !game.running || game.paused) return;
    game.press(KEYMAP[k]);
  });

  window.addEventListener('keyup', function (e) {
    var k = e.key.toLowerCase();
    if (!(k in KEYMAP)) return;
    e.preventDefault();
    if (!game) return;
    game.release(KEYMAP[k]);
  });

  var touchLanes = {};

  canvas.addEventListener('touchstart', function (e) {
    if (!game || !game.running || game.paused) return;
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var lane = laneFromX(t.clientX);
      touchLanes[t.identifier] = lane;
      game.press(lane);
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', function (e) {
    if (!game || !game.running || game.paused) return;
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var prev = touchLanes[t.identifier];
      var lane = laneFromX(t.clientX);
      if (prev !== undefined && prev !== lane) {
        game.release(prev);
        touchLanes[t.identifier] = lane;
        game.press(lane);
      }
    }
  }, { passive: false });

  function endTouch(e) {
    if (!game) return;
    if (e.cancelable) e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var lane = touchLanes[t.identifier];
      if (lane !== undefined) {
        game.release(lane);
        delete touchLanes[t.identifier];
      }
    }
  }

  canvas.addEventListener('touchend', endTouch, { passive: false });
  canvas.addEventListener('touchcancel', endTouch, { passive: false });

  /* 鼠标点按（电脑上懒人操作） */
  canvas.addEventListener('mousedown', function (e) {
    if (!game || !game.running || game.paused) return;
    e.preventDefault();
    game.press(laneFromX(e.clientX));
  });

  window.addEventListener('mouseup', function (e) {
    if (!game || !game.running || game.paused) return;
    game.release(laneFromX(e.clientX));
  });

  /* ---------- 按钮 ---------- */

  function syncAutoUI() {
    var b = document.getElementById('btn-auto');
    if (b) {
      b.classList.toggle('is-active', autoMode);
      b.setAttribute('aria-pressed', String(autoMode));
    }
  }

  document.getElementById('btn-start').addEventListener('click', function () {
    lastAuto = autoMode;
    startRound(0, autoMode);
  });
  document.getElementById('btn-auto').addEventListener('click', function () {
    autoMode = !autoMode;
    lastAuto = autoMode;
    syncAutoUI();
  });
  document.getElementById('btn-pause').addEventListener('click', function () {
    if (game.paused) resumeRound();
    else pauseRound();
  });

  document.getElementById('btn-resume').addEventListener('click', resumeRound);
  document.getElementById('btn-quit').addEventListener('click', quitRound);

  document.getElementById('btn-retry').addEventListener('click', function () {
    startRound(0, lastAuto);
  });

  document.getElementById('btn-back').addEventListener('click', function () {
    quitRound();
  });

  var btnFx = document.getElementById('btn-fx');
  var btnMute = document.getElementById('btn-mute');
  var setSnd = document.getElementById('set-snd');
  var setFx = document.getElementById('set-fx');
  var setDiff = document.getElementById('set-diff');
  var setMv = document.getElementById('set-mv');
  var setWalker = document.getElementById('set-walker');
  var setMeteor = document.getElementById('set-meteor');
  var setInk = document.getElementById('set-ink');
  var setEye = document.getElementById('set-eye');
  var FX_LABELS = ['关', '标准', '全开'];
  var DIFF_LABELS = ['简单', '普通', '困难'];

  /* 分项特效开关：同步到 game.flags 并直接切背景层显隐 */
  function applyFlags() {
    if (game) game.flags = {
      mv: settings.mv, walker: settings.walker, meteor: settings.meteor,
      ink: settings.ink, eye: settings.eye
    };
    if (videoEl) videoEl.classList.toggle('is-mv-off', !settings.mv);
    if (elOil) elOil.style.display = settings.ink ? '' : 'none';
    if (elFluid) elFluid.style.display = settings.ink ? '' : 'none';
  }
  function syncFlagUI(btn, on) {
    btn.textContent = on ? '开' : '关';
    btn.classList.toggle('is-off', !on);
  }
  function syncFlagsUI() {
    syncFlagUI(setMv, settings.mv);
    syncFlagUI(setWalker, settings.walker);
    syncFlagUI(setMeteor, settings.meteor);
    syncFlagUI(setInk, settings.ink);
    syncFlagUI(setEye, settings.eye);
    applyFlags();
  }

  function syncFxUI() {
    var lv = game ? game.fxLevel : 1;
    setFx.textContent = FX_LABELS[lv];
    btnFx.textContent = ['FX1', 'FX2', 'FX3'][lv];
    btnFx.classList.toggle('is-off', lv === 0);
  }
  function syncSndUI() {
    var m = audio.muted;
    setSnd.textContent = m ? '关' : '开';
    btnMute.textContent = m ? 'MUT' : 'SND';
    btnMute.classList.toggle('is-off', m);
  }
  function syncDiffUI() {
    setDiff.textContent = DIFF_LABELS[settings.diff];
    var seg = document.getElementById('diff-seg');
    if (seg) {
      var btns = seg.querySelectorAll('.diff-btn');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('is-active', Number(btns[i].getAttribute('data-diff')) === settings.diff);
      }
    }
  }

  function syncKeyUI() {
    var seg = document.getElementById('key-seg');
    if (seg) {
      var btns = seg.querySelectorAll('.diff-btn');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('is-active', btns[i].getAttribute('data-scheme') === settings.keyScheme);
      }
    }
  }

  function applyKeyScheme() {
    KEYMAP = KEY_SCHEMES[settings.keyScheme].map;
    if (game) game.keyLabels = KEY_SCHEMES[settings.keyScheme].keys;
    syncKeyUI();
  }

  btnFx.addEventListener('click', function () {
    if (!game) return;
    game.fxLevel = (game.fxLevel + 1) % 3;
    syncFxUI();
  });

  btnMute.addEventListener('click', function () {
    audio.setMuted(!audio.muted);
    syncSndUI();
  });

  /* ---------- 设置面板 ---------- */
  document.getElementById('btn-open-settings').addEventListener('click', function () { showPanel('settings'); });
  document.getElementById('btn-settings-back').addEventListener('click', function () { showPanel('start'); });

  setFx.addEventListener('click', function () {
    if (!game) return;
    game.fxLevel = (game.fxLevel + 1) % 3;
    syncFxUI();
  });
  setSnd.addEventListener('click', function () {
    audio.setMuted(!audio.muted);
    syncSndUI();
  });
  setDiff.addEventListener('click', function () {
    settings.diff = (settings.diff + 1) % 3;
    syncDiffUI();
  });

  var diffSeg = document.getElementById('diff-seg');
  if (diffSeg) {
    diffSeg.addEventListener('click', function (e) {
      var btn = e.target.closest('.diff-btn');
      if (!btn) return;
      settings.diff = Number(btn.getAttribute('data-diff')) || 0;
      syncDiffUI();
    });
  }

  var keySeg = document.getElementById('key-seg');
  if (keySeg) {
    keySeg.addEventListener('click', function (e) {
      var btn = e.target.closest('.diff-btn');
      if (!btn) return;
      var scheme = btn.getAttribute('data-scheme');
      if (!KEY_SCHEMES[scheme]) return;
      settings.keyScheme = scheme;
      applyKeyScheme();
    });
  }

  function bindFlag(btn, key) {
    btn.addEventListener('click', function () {
      settings[key] = !settings[key];
      syncFlagsUI();
    });
  }
  bindFlag(setMv, 'mv');
  bindFlag(setWalker, 'walker');
  bindFlag(setMeteor, 'meteor');
  bindFlag(setInk, 'ink');
  bindFlag(setEye, 'eye');

  /* 切走窗口自动暂停，回来不自动续（避免用户切回来时已经漏了一串） */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && game && game.running && !game.paused) pauseRound();
  });

  window.addEventListener('blur', function () {
    if (game && game.running && !game.paused) pauseRound();
  });

  /* ---------- 启动 ---------- */

  function boot() {
    /* 墨水流体层：WebGL 不可用或编译失败时静默降级，不影响游戏 */
    try {
      if (elFluid && window.FluidLayer) {
        fluidLayer = new window.FluidLayer(elFluid);
        if (!fluidLayer.ok) { fluidLayer = null; elFluid.style.display = 'none'; }
      }
    } catch (e) {
      fluidLayer = null;
      if (elFluid) elFluid.style.display = 'none';
    }

    /* 开始页不跑流体模拟，等开局进入循环后再按需恢复 */
    stopLayers();

    game = new window.RhythmGame({
      canvas: canvas,
      audio: audio,
      videoEl: videoEl,
      flags: {
        mv: settings.mv, walker: settings.walker, meteor: settings.meteor,
        ink: settings.ink, eye: settings.eye
      },
      keyLabels: KEY_SCHEMES[settings.keyScheme].keys,
      onStats: onStats,
      onFinish: endRound
    });

    audio.onEnded = function () {
      if (game && game.running) endRound();
    };

    syncFxUI();
    syncSndUI();
    syncDiffUI();
    syncFlagsUI();
    syncKeyUI();
    syncAutoUI();

    bootHint.textContent = '正在载入音源';

    audio.load().then(function (dur) {
      bootHint.textContent = '音源已就绪 · ' + Math.floor(dur / 60) + ':' + pad(dur % 60, 2);
      chartData = window.ChartBuilder.buildChart(dur, 20250319, settings.diff);
      game.prepare(chartData);
      game.render();
      applyStage(0);

      /* 仅用于开发期截图核对渲染，正常游玩不会命中 */
      if (window.location.search.indexOf('demo=1') >= 0) {
        game.demoClock = true;
        var dm = window.location.search.match(/[?&]t=(\d+)/);
        var dauto = window.location.search.indexOf('auto=1') >= 0;
        startRound(dm ? parseInt(dm[1], 10) : 0, dauto);
      }

      setTimeout(function () {
        bootHint.style.opacity = '0';
      }, 1600);
    }).catch(function (err) {
      bootHint.textContent = '载入失败：' + err.message;
      bootHint.style.color = '#FF3A3A';
    });
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    boot();
  } else {
    document.addEventListener('DOMContentLoaded', boot);
  }
})();
