/* 玻璃窗露珠层：Canvas2D 轻量实现。
   参考 SardineFish/raindrop-fx（MIT，WebGL2 玻璃折射）与 Codrops RainEffect 的水珠/轨迹思路，
   本工程只取凝珠高光、下滑轨迹和弱透镜感，不引入 Three.js / WebGL2 重依赖。 */

(function (global) {
  'use strict';

  function DewLayer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(2, global.devicePixelRatio || 1);
    this.beads = [];
    this.runners = [];
    this.time = 0;
    this._resize();
    this._seed();
    var self = this;
    global.addEventListener('resize', function () { self._resize(); });
  }

  DewLayer.prototype._resize = function () {
    var w = this.canvas.clientWidth || global.innerWidth;
    var h = this.canvas.clientHeight || global.innerHeight;
    this.canvas.width = Math.max(1, Math.round(w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(h * this.dpr));
    this.w = w;
    this.h = h;
  };

  DewLayer.prototype._seed = function () {
    this.beads = [];
    this.runners = [];
    var beadCount = Math.round((this.w * this.h) / 2800);
    for (var i = 0; i < beadCount; i++) {
      this.beads.push(this._makeBead(true));
    }
    for (var r = 0; r < 34; r++) {
      this.runners.push(this._makeRunner(Math.random() * this.h));
    }
  };

  DewLayer.prototype._makeBead = function (anyY) {
    var big = Math.random() < 0.16;
    return {
      x: Math.random() * this.w,
      y: anyY ? Math.random() * this.h : -8 - Math.random() * this.h * 0.2,
      r: big ? 7.0 + Math.random() * 5.0 : 2.6 + Math.random() * 3.8,
      alpha: 0.50 + Math.random() * 0.28,
      phase: Math.random() * Math.PI * 2,
      big: big
    };
  };

  DewLayer.prototype._makeRunner = function (y) {
    return {
      x: this.w * (0.08 + Math.random() * 0.84),
      y: y == null ? -10 : y,
      r: 1.6 + Math.random() * 2.2,
      speed: 18 + Math.random() * 30,
      phase: Math.random() * Math.PI * 2,
      sway: 6 + Math.random() * 10,
      trail: []
    };
  };

  DewLayer.prototype.frame = function (dt, time, oil, pulse) {
    var ctx = this.ctx;
    if (!ctx) return;
    this.time = time || 0;
    var intensity = Math.min(1, 0.72 + 0.35 * (oil || 0) + 0.15 * (pulse || 0));
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    var i, b, rr;
    for (i = 0; i < this.beads.length; i++) {
      b = this.beads[i];
      this._drawBead(b, intensity);
    }

    for (i = 0; i < this.runners.length; i++) {
      rr = this.runners[i];
      rr.y += rr.speed * dt * (1 + 0.35 * (pulse || 0));
      rr.x += Math.sin(this.time * 1.4 + rr.phase) * rr.sway * dt;
      rr.trail.push({ x: rr.x, y: rr.y, r: rr.r });
      if (rr.trail.length > 20) rr.trail.shift();
      if (rr.y > this.h + 12) {
        this.runners[i] = this._makeRunner();
        continue;
      }
      this._drawRunner(rr, intensity);
    }

    ctx.restore();
  };

  DewLayer.prototype._drawBead = function (b, intensity) {
    var ctx = this.ctx;
    var breathe = 1 + 0.06 * Math.sin(this.time * 1.1 + b.phase);
    var r = b.r * breathe;
    var a = b.alpha * intensity;
    var g = ctx.createRadialGradient(
      b.x - r * 0.35, b.y - r * 0.35, r * 0.1,
      b.x, b.y, r
    );
    g.addColorStop(0, 'rgba(242,250,255,' + (0.55 * a).toFixed(3) + ')');
    g.addColorStop(0.55, 'rgba(170,210,225,' + (0.18 * a).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(20,30,46,' + (0.20 * a).toFixed(3) + ')');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,' + (0.22 * a).toFixed(3) + ')';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(b.x - r * 0.12, b.y - r * 0.12, r * 0.72, Math.PI * 1.1, Math.PI * 1.8);
    ctx.stroke();
  };

  DewLayer.prototype._drawRunner = function (rr, intensity) {
    var ctx = this.ctx;
    var a = 0.26 * intensity;
    ctx.lineCap = 'round';
    for (var t = 0; t < rr.trail.length; t++) {
      var p = rr.trail[t];
      var ta = a * (t / rr.trail.length) * 0.5;
      ctx.strokeStyle = 'rgba(210,235,245,' + ta.toFixed(3) + ')';
      ctx.lineWidth = p.r * 0.7;
      if (t > 0) {
        var q = rr.trail[t - 1];
        ctx.beginPath();
        ctx.moveTo(q.x, q.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
    }
    var g = ctx.createRadialGradient(
      rr.x - rr.r * 0.3, rr.y - rr.r * 0.3, rr.r * 0.1,
      rr.x, rr.y, rr.r
    );
    g.addColorStop(0, 'rgba(248,253,255,' + (0.60 * a).toFixed(3) + ')');
    g.addColorStop(0.6, 'rgba(180,215,228,' + (0.20 * a).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(18,28,42,' + (0.22 * a).toFixed(3) + ')');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(rr.x, rr.y, rr.r, 0, Math.PI * 2);
    ctx.fill();
  };

  if (global.document) {
    var cv = document.getElementById('dew');
    if (cv) global.DewLayer = new DewLayer(cv);
    else global.DewLayer = null;
  }
})(window);
