(() => {
  const W = 1920, H = 1080;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  const font = (px, w = 700) => `${w} ${px}px Archivo, system-ui, sans-serif`;
  const rnd = (s) => { let x = s; return () => (x = (x * 16807) % 2147483647) / 2147483647; };

  const scenes = {
    racer(t) {
      const sky = g.createLinearGradient(0, 0, 0, H * 0.55);
      sky.addColorStop(0, "#1b1036"); sky.addColorStop(0.6, "#7a2a6b"); sky.addColorStop(1, "#f08a4b");
      g.fillStyle = sky; g.fillRect(0, 0, W, H * 0.55);
      g.fillStyle = "#ffd27a"; g.beginPath(); g.arc(W / 2, H * 0.55, 220, Math.PI, 0); g.fill();
      g.fillStyle = "#2a1640";
      for (let i = 0; i < 9; i++) { const x = i * 260 - 80; g.beginPath(); g.moveTo(x, H * 0.55); g.lineTo(x + 140, H * 0.38 + (i % 3) * 30); g.lineTo(x + 300, H * 0.55); g.fill(); }
      g.fillStyle = "#120a22"; g.fillRect(0, H * 0.55, W, H * 0.45);
      g.strokeStyle = "#ff4fa3"; g.lineWidth = 2;
      for (let i = -12; i <= 12; i++) { g.beginPath(); g.moveTo(W / 2 + i * 30, H * 0.55); g.lineTo(W / 2 + i * 260, H); g.stroke(); }
      for (let i = 0; i < 14; i++) { const p = ((i + (t * 2) % 1) / 14) ** 2; const y = H * 0.55 + p * H * 0.45; g.globalAlpha = p; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
      g.globalAlpha = 1;
      const cx = W / 2 + Math.sin(t * 0.8) * 120;
      g.fillStyle = "#0c0c14"; g.beginPath(); g.moveTo(cx - 190, H - 90); g.lineTo(cx - 120, H - 210); g.lineTo(cx + 120, H - 210); g.lineTo(cx + 190, H - 90); g.fill();
      g.fillStyle = "#ff3b5c"; g.fillRect(cx - 170, H - 130, 70, 18); g.fillRect(cx + 100, H - 130, 70, 18);
      g.fillStyle = "#fff"; g.font = font(96, 800); g.textAlign = "right"; g.fillText(`${Math.round(208 + Math.sin(t) * 6)}`, W - 80, H - 90);
      g.font = font(32, 600); g.fillText("km/h", W - 80, H - 50);
      g.textAlign = "left"; g.font = font(40, 800); g.fillText("LAP 2 / 3", 70, 90);
      g.font = font(30, 600); g.fillText(`1:${String(24 + Math.floor(t) % 30).padStart(2, "0")}.${String(Math.floor(t * 100) % 100).padStart(2, "0")}`, 70, 135);
      g.fillText("POS 3 / 12", 70, 175);
    },
    strategy(t) {
      const r = rnd(7); const s = 64;
      for (let y = 0; y < H / s + 1; y++) for (let x = 0; x < W / s + 1; x++) {
        const n = Math.sin(x * 0.35) + Math.cos(y * 0.42) + Math.sin((x + y) * 0.17) + r() * 0.6;
        g.fillStyle = n < -0.6 ? "#1d4f7a" : n < -0.2 ? "#2f6f8f" : n < 0.9 ? "#4f7d3a" : n < 1.6 ? "#3b6330" : "#7a7262";
        g.fillRect(x * s, y * s, s, s);
        g.strokeStyle = "rgba(0,0,0,0.15)"; g.strokeRect(x * s, y * s, s, s);
      }
      const units = [[620, 520, "#e2b25a"], [700, 560, "#e2b25a"], [660, 610, "#e2b25a"], [1240, 380, "#d0566b"], [1300, 420, "#d0566b"]];
      for (const [x, y, col] of units) { const b = Math.sin(t * 3 + x) * 4; g.fillStyle = "rgba(0,0,0,.35)"; g.beginPath(); g.ellipse(x, y + 18, 20, 8, 0, 0, 7); g.fill(); g.fillStyle = col; g.beginPath(); g.arc(x, y + b, 16, 0, 7); g.fill(); }
      g.strokeStyle = "#ffe9a8"; g.lineWidth = 3; g.setLineDash([12, 10]); g.lineDashOffset = -t * 40;
      g.beginPath(); g.moveTo(700, 560); g.lineTo(1000, 470); g.lineTo(1240, 380); g.stroke(); g.setLineDash([]);
      g.fillStyle = "rgba(14,16,20,.85)"; g.fillRect(0, 0, W, 64);
      g.fillStyle = "#e9e4d8"; g.font = font(28, 700); g.textAlign = "left";
      g.fillText(`Gold ${1240 + Math.floor(t * 3)}    Wood 860    Stone 412    Pop 38 / 60`, 32, 42);
      g.textAlign = "right"; g.fillText("Year 214", W - 32, 42);
      g.fillStyle = "rgba(14,16,20,.85)"; g.fillRect(W - 340, H - 340, 310, 310);
      g.fillStyle = "#4f7d3a"; g.fillRect(W - 325, H - 325, 280, 280);
      g.fillStyle = "#1d4f7a"; g.fillRect(W - 325, H - 200, 120, 155);
      g.strokeStyle = "#fff"; g.lineWidth = 2; g.strokeRect(W - 250, H - 260, 90, 60);
    },
    shooter(t) {
      const vx = W / 2 + Math.sin(t * 0.7) * 40, vy = H / 2 + Math.cos(t * 0.9) * 14;
      g.fillStyle = "#1a1d22"; g.fillRect(0, 0, W, H);
      g.fillStyle = "#2b3038"; g.beginPath(); g.moveTo(0, 0); g.lineTo(vx - 160, vy - 110); g.lineTo(vx - 160, vy + 110); g.lineTo(0, H); g.fill();
      g.fillStyle = "#252a31"; g.beginPath(); g.moveTo(W, 0); g.lineTo(vx + 160, vy - 110); g.lineTo(vx + 160, vy + 110); g.lineTo(W, H); g.fill();
      g.fillStyle = "#3a3f47"; g.beginPath(); g.moveTo(0, H); g.lineTo(vx - 160, vy + 110); g.lineTo(vx + 160, vy + 110); g.lineTo(W, H); g.fill();
      g.fillStyle = "#14171b"; g.beginPath(); g.moveTo(0, 0); g.lineTo(vx - 160, vy - 110); g.lineTo(vx + 160, vy - 110); g.lineTo(W, 0); g.fill();
      const glow = g.createRadialGradient(vx, vy, 10, vx, vy, 200); glow.addColorStop(0, "#9fe3ff"); glow.addColorStop(1, "rgba(80,160,255,0)");
      g.fillStyle = glow; g.fillRect(vx - 200, vy - 200, 400, 400);
      for (let i = 1; i < 6; i++) { const k = i / 6; g.strokeStyle = `rgba(255,190,90,${0.5 - k * 0.4})`; g.lineWidth = 6 - i; g.beginPath(); g.moveTo(vx - 160 - (vx - 160) * (1 - k), vy - 110 - (vy - 110) * (1 - k)); g.lineTo(vx + 160 + (W - vx - 160) * (1 - k), vy - 110 - (vy - 110) * (1 - k)); g.stroke(); }
      g.strokeStyle = "#7dfc9a"; g.lineWidth = 3;
      g.beginPath(); g.moveTo(W / 2 - 22, H / 2); g.lineTo(W / 2 - 8, H / 2); g.moveTo(W / 2 + 8, H / 2); g.lineTo(W / 2 + 22, H / 2);
      g.moveTo(W / 2, H / 2 - 22); g.lineTo(W / 2, H / 2 - 8); g.moveTo(W / 2, H / 2 + 8); g.lineTo(W / 2, H / 2 + 22); g.stroke();
      g.fillStyle = "#2c2f36"; g.beginPath(); g.moveTo(W - 620, H); g.lineTo(W - 420, H - 300 + Math.sin(t * 6) * 6); g.lineTo(W - 300, H - 280 + Math.sin(t * 6) * 6); g.lineTo(W - 260, H); g.fill();
      g.fillStyle = "#fff"; g.font = font(84, 800); g.textAlign = "right"; g.fillText("24", W - 150, H - 70);
      g.font = font(40, 600); g.fillText("/ 90", W - 60, H - 70);
      g.textAlign = "left"; g.font = font(84, 800); g.fillText("100", 70, H - 70);
      g.fillStyle = "#7dfc9a"; g.fillRect(250, H - 120, 300, 18);
      g.fillStyle = "#fff"; g.font = font(30, 700); g.fillText("ROUND 7   8 : 6", W / 2 - 130, 70);
    },
    space(t) {
      g.fillStyle = "#05060c"; g.fillRect(0, 0, W, H);
      const r = rnd(3);
      for (let i = 0; i < 400; i++) { const x = (r() * W - t * 30 * (0.3 + r())) % W; g.fillStyle = `rgba(255,255,255,${r()})`; g.fillRect((x + W) % W, r() * H, 2, 2); }
      const p = g.createRadialGradient(1350, 700, 40, 1400, 760, 520); p.addColorStop(0, "#c8668f"); p.addColorStop(0.6, "#5b3a9e"); p.addColorStop(1, "#140c2a");
      g.fillStyle = p; g.beginPath(); g.arc(1400, 760, 460, 0, 7); g.fill();
      g.strokeStyle = "rgba(226,178,90,.6)"; g.lineWidth = 10; g.beginPath(); g.ellipse(1400, 760, 720, 120, -0.25, 0, 7); g.stroke();
      const sx = 600 + Math.sin(t * 0.6) * 60, sy = 420 + Math.cos(t * 0.8) * 30;
      g.fillStyle = "#cfd6e2"; g.beginPath(); g.moveTo(sx + 120, sy); g.lineTo(sx - 70, sy - 55); g.lineTo(sx - 40, sy); g.lineTo(sx - 70, sy + 55); g.fill();
      g.fillStyle = "#8a6cf2"; g.beginPath(); g.ellipse(sx - 60, sy, 30 + Math.sin(t * 20) * 6, 12, 0, 0, 7); g.fill();
      g.fillStyle = "#fff"; g.font = font(30, 600); g.textAlign = "left";
      g.fillText("Shields 82%", 60, 80); g.fillText("Hull 64%", 60, 122); g.fillText(`Range ${(12.4 - (t % 10) / 10).toFixed(1)} km`, 60, 164);
    },
  };

  window.__fake = (kind) => {
    const draw = scenes[kind];
    const start = performance.now();
    const loop = () => { draw((performance.now() - start) / 1000); requestAnimationFrame(loop); };
    loop();
    setInterval(() => draw((performance.now() - start) / 1000), 33);
    const stream = c.captureStream(30);
    const ac = new AudioContext(); const dst = ac.createMediaStreamDestination(); const o = ac.createOscillator(); const gn = ac.createGain(); gn.gain.value = 0; o.connect(gn).connect(dst); o.start();
    stream.addTrack(dst.stream.getAudioTracks()[0]);
    navigator.mediaDevices.getDisplayMedia = async () => stream;
    return "ok";
  };
})();
