// 打楽器の音はすべてWeb Audioで合成する(音源ファイルなし・権利の心配なし)
let ctx = null;
let master = null;
let noiseBuf = null;
let enabled = true;

export function unlockAudio() {
  try {
    // iOS 17+:マナーモードでも鳴らす
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch (e) { /* noop */ }
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createDynamicsCompressor();
    master.threshold.value = -10;
    master.ratio.value = 4;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  // 無音を1回鳴らしてiOSのオーディオを起こす
  const o = ctx.createOscillator(); const g = ctx.createGain();
  g.gain.value = 0; o.connect(g); g.connect(master); o.start(); o.stop(ctx.currentTime + 0.01);
}

export function setSoundEnabled(v) { enabled = v; }
export function isSoundEnabled() { return enabled; }

function env(g, t, peak, attack, decay) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function noise(t, { type = 'highpass', freq = 6000, q = 0.8, peak = 0.5, attack = 0.002, decay = 0.08, out }) {
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain(); env(g, t, peak, attack, decay);
  s.connect(f); f.connect(g); g.connect(out);
  s.start(t, Math.random()); s.stop(t + attack + decay + 0.05);
}

function tone(t, { freq, type = 'sine', peak = 0.3, attack = 0.002, decay = 0.3, out }) {
  const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
  const g = ctx.createGain(); env(g, t, peak, attack, decay);
  o.connect(g); g.connect(out); o.start(t); o.stop(t + attack + decay + 0.05);
}

// メンバーカラーごとの楽器
const INSTRUMENTS = {
  tambourine(t, out) {
    noise(t, { freq: 7000, peak: 0.55, decay: 0.12, out });
    [5200, 6100, 7300].forEach((f, i) => tone(t + i * 0.006, { freq: f, peak: 0.06, decay: 0.16, out }));
  },
  shaker(t, out) {
    noise(t, { freq: 5000, peak: 0.45, attack: 0.015, decay: 0.07, out });
  },
  bell(t, out) {
    tone(t, { freq: 2637, peak: 0.22, decay: 0.45, out });
    tone(t, { freq: 3951, peak: 0.1, decay: 0.3, out });
    tone(t, { freq: 6100, peak: 0.05, decay: 0.15, out });
  },
  woodblock(t, out) {
    tone(t, { freq: 880, peak: 0.45, decay: 0.06, out });
    noise(t, { type: 'bandpass', freq: 1800, q: 4, peak: 0.4, decay: 0.03, out });
  },
  cowbell(t, out) {
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 1.5; bp.connect(out);
    tone(t, { freq: 540, type: 'square', peak: 0.18, decay: 0.28, out: bp });
    tone(t, { freq: 800, type: 'square', peak: 0.18, decay: 0.28, out: bp });
  },
  clave(t, out) {
    tone(t, { freq: 2500, peak: 0.4, decay: 0.05, out });
  },
  agogo(t, out) {
    tone(t, { freq: 1320, type: 'triangle', peak: 0.3, decay: 0.2, out });
    tone(t, { freq: 2640, peak: 0.08, decay: 0.12, out });
  },
  triangle(t, out) {
    tone(t, { freq: 4200, peak: 0.16, decay: 0.7, out });
    tone(t, { freq: 6900, peak: 0.06, decay: 0.5, out });
  },
};

function clap(t, out) {
  [0, 0.011, 0.022].forEach(d => noise(t + d, { type: 'bandpass', freq: 1300, q: 1.2, peak: 0.5, decay: d === 0.022 ? 0.12 : 0.02, out }));
}
function cymbal(t, out) {
  noise(t, { freq: 6500, peak: 0.4, attack: 0.003, decay: 1.1, out });
  noise(t, { type: 'bandpass', freq: 9000, q: 0.6, peak: 0.25, decay: 0.8, out });
}

let lastCymbal = 0;

// n = 0.6秒以内に一緒に振った人数(自分を含む), full = 全員そろったとみなす人数
function kick(t, out) {
  const o = ctx.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(50, t + 0.12);
  const g = ctx.createGain(); env(g, t, 0.9, 0.002, 0.18);
  o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.25);
}

// accent = 強く振ったとき(大きめの一発+低い「ドン」)
export function playShake(instrument, n = 1, full = 99, { accent = false } = {}) {
  if (!enabled || !ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  const t = ctx.currentTime + 0.005;
  const out = ctx.createGain();
  const base = Math.min(1, 0.35 + 0.15 * (n - 1)); // シンクロで大きく
  out.gain.value = accent ? Math.min(1.4, base * 1.6) : base;
  out.connect(master);
  (INSTRUMENTS[instrument] || INSTRUMENTS.tambourine)(t, out);
  if (accent) kick(t, out);
  if (n >= 3) clap(t, out); // 3人以上で手拍子が重なる
  if (n >= 2 && n >= full && t - lastCymbal > 1.2) { // 全員そろったらシンバル
    lastCymbal = t;
    cymbal(t, out);
  }
}

// 手首をひねったとき:シャカシャカ(シェイカーのロール)
export function playRoll() {
  if (!enabled || !ctx) return;
  const t = ctx.currentTime + 0.005;
  const out = ctx.createGain(); out.gain.value = 0.45; out.connect(master);
  for (let i = 0; i < 4; i++) noise(t + i * 0.035, { freq: 4500 + i * 300, peak: 0.35, attack: 0.008, decay: 0.03, out });
}

// 振り続けて止めたとき:締めの「ジャン!」
export function playFinale() {
  if (!enabled || !ctx) return;
  const t = ctx.currentTime + 0.005;
  const out = ctx.createGain(); out.gain.value = 0.9; out.connect(master);
  kick(t, out);
  cymbal(t, out);
  noise(t, { type: 'bandpass', freq: 220, q: 0.8, peak: 0.6, decay: 0.25, out });
}
