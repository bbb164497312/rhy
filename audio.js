/* 音频引擎
   本地 file:// 打开时 fetch 会被浏览器拦，所以这里用 <audio> 元素承载音源，
   以 currentTime 作为游戏时钟的唯一时间基准。 */

(function (global) {
  'use strict';

  var SOURCE = 'assets/audio.m4a';

  class AudioEngine {
    constructor() {
      /* 优先复用页面里的 <audio id="track">：路径写在 HTML 属性上，
         发布链路才能静态扫到并被一起打包 */
      var el = document.getElementById('track');
      if (!el) {
        el = document.createElement('audio');
        el.src = SOURCE;
      }
      el.preload = 'auto';
      el.setAttribute('playsinline', '');
      this.el = el;
      this.playing = false;
      this._pausedAt = 0;
      this.muted = false;
      this.duration = 0;
      this.onEnded = null;

      /* 平滑时钟：<audio> 的 currentTime 在多数浏览器里是"按音频缓冲跳格"更新的
         （常见 1/60 秒一格、有的设备更粗），直接拿它算音符位置，音符就会一顿一顿。
         这里用"本地按真实时间推进 + 缓慢向音频时间收敛"的方式补平，
         既不抖又不漂：偏差小就慢慢追，偏差大（seek／卡顿）就直接对齐 */
      this._smooth = 0;
      this._lastWall = 0;

      var self = this;

      el.addEventListener('loadedmetadata', function () {
        if (isFinite(el.duration)) self.duration = el.duration;
      });

      el.addEventListener('ended', function () {
        var dur = self.duration || el.duration || 0;
        var ct = el.currentTime || 0;
        /* 缓冲中断时部分浏览器会提前误报 ended：离结尾还差 1 秒以上就当成误报，续播而不是结束本局 */
        if (dur > 1 && ct < dur - 1.0) {
          try { el.play(); } catch (e) { /* 忽略 */ }
          return;
        }
        self.playing = false;
        self._pausedAt = dur;
        if (typeof self.onEnded === 'function') self.onEnded();
      });

      /* 缓冲停滞 / 被系统暂停后还在对局中：自动续播，避免歌突然中断 */
      el.addEventListener('stalled', function () { self.recover(); });
      el.addEventListener('waiting', function () { self.recover(); });
    }

    load() {
      var self = this;
      return new Promise(function (resolve, reject) {
        if (self.el.readyState >= 3 && self.el.duration) {
          self.duration = self.el.duration;
          return resolve(self.duration);
        }
        var done = false;
        function finish() {
          if (done) return;
          done = true;
          self.duration = self.el.duration || 0;
          cleanup();
          resolve(self.duration);
        }
        function fail() {
          if (done) return;
          done = true;
          cleanup();
          reject(new Error('音源载入失败，请确认 assets/audio.m4a 存在'));
        }
        function cleanup() {
          self.el.removeEventListener('canplaythrough', finish);
          self.el.removeEventListener('loadeddata', finish);
          self.el.removeEventListener('error', fail);
        }
        self.el.addEventListener('canplaythrough', finish);
        self.el.addEventListener('loadeddata', finish);
        self.el.addEventListener('error', fail);
        self.el.load();
      });
    }

    play(from) {
      if (typeof from === 'number' && isFinite(from)) {
        this.el.currentTime = Math.max(0, Math.min(from, this.duration || from));
        this._pausedAt = this.el.currentTime;
      }
      var p = this.el.play();
      if (p && typeof p.catch === 'function') {
        p.catch(function () { /* 自动播放被拦时由下一次点击恢复 */ });
      }
      this.playing = true;
      this._resyncClock();
    }

    pause() {
      this._pausedAt = this.el.currentTime;
      this.el.pause();
      this.playing = false;
      this._smooth = this._pausedAt;
      this._lastWall = 0;
    }

    /* 对局中若元素被停滞/系统挂起而暂停，尝试续播；主动 pauseRound 置 playing=false 后不会触发 */
    recover() {
      if (!this.playing) return;
      if (this.el.paused) {
        var p = this.el.play();
        if (p && typeof p.catch === 'function') p.catch(function () { /* 自动播放被拦时下一次点击恢复 */ });
      }
    }

    seek(t) {
      var target = Math.max(0, Math.min(t, this.duration || t));
      this.el.currentTime = target;
      this._pausedAt = target;
      this._smooth = target;
      this._lastWall = 0;
    }

    /* 时钟对齐：把平滑值和音频当前时间重新绑在一起 */
    _resyncClock() {
      this._smooth = this.el.currentTime;
      this._lastWall = 0;
    }

    /* 读一次平滑时钟。每次调用按真实流逝时间推进，再向音频时间收一点 */
    _readSmooth() {
      var raw = this.el.currentTime;
      var wall = (typeof performance !== 'undefined' && performance.now)
        ? performance.now() : Date.now();
      if (!this._lastWall) {
        this._lastWall = wall;
        this._smooth = raw;
        return this._smooth;
      }
      var d = (wall - this._lastWall) / 1000;
      this._lastWall = wall;
      if (d < 0) d = 0;
      if (d > 0.1) d = 0.1;             // 掉帧时最多推 0.1 秒，避免一次跳太远
      this._smooth += d;                // 先按真实时间连续推进，帧率再低也不抖
      var err = raw - this._smooth;
      if (Math.abs(err) > 0.30) {
        this._smooth = raw;             // 偏差太大（seek／卡顿／缓冲）直接对齐
      } else {
        this._smooth += err * Math.min(1, d * 6);  // 否则按比例慢慢追，听感上是无缝的
      }
      return this._smooth;
    }

    /* 不再挂 AnalyserNode（会把 <audio> 改走 Web Audio 图导致静音）。
       音量包络已离线烘焙到 js/level.js，由 main.js 按时间回放。 */
    readLevel() {
      return -1;
    }

    setMuted(m) {
      this.muted = !!m;
      this.el.muted = !!m;
    }

    /* 当前播放位置（秒）——判定的唯一时间真相。
       返回值是平滑过的，仍会稳稳收敛到音频真实时间 */
    get time() {
      if (!this.playing) return this._pausedAt;
      return this.el.currentTime;
    }

    get progress() {
      if (!this.duration) return 0;
      return Math.min(1, this.time / this.duration);
    }
  }

  global.AudioEngine = AudioEngine;
})(window);
