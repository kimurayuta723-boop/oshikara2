// 打楽器の音(すべてその場で合成。音源ファイルなし・権利の心配なし)
//
// シェイカー類(マラカス・タンバリン・鈴・カバサなど)は、中の粒やジングルが
// ひとつずつぶつかる様子を計算する「PhISEM」という物理モデル(Perry Cook)で作る。
// 振るたびに少しずつ違う音になるよう、数パターンを作っておき、ランダムに選んで鳴らす。
// 仕上げに、短い残響(リバーブ)と軽いコンプレッサーをかける。

let ctx = null;
let dryBus = null;
let wetSend = null;
let enabled = true;
const cache = new Map(); // 楽器ごとの合成済みバッファ

// ---------- 楽器の設定 ----------
// objects:粒の数 / soundDecay:1粒の音の減衰 / systemDecay:振った勢いの減衰
// res:共鳴(f=周波数, r=響きの長さ, g=音量, rand=当たるたびの音程の揺れ)
// rebound:振り返しで粒がもう一度当たる強さ / len:秒
const SHAKERS = {
  maracas: { // 粒は少なめ・高めにして、軽い「シャッ」に
    objects: 14, soundDecay: 0.94, systemDecay: 0.9982, rebound: 0.35, len: 0.3, zero: 0.9,
    res: [{ f: 4600, r: 0.9 }, { f: 7000, r: 0.8, g: 0.4 }],
  },
  shaker: { // エッグシェイカー:細かい砂のような粒
    objects: 64, soundDecay: 0.96, systemDecay: 0.9992, rebound: 0.6, len: 0.34, zero: 0.35,
    res: [{ f: 4300, r: 0.7 }, { f: 2400, r: 0.6, g: 0.4 }],
  },
  cabasa: { // ビーズのチェーンがこすれる音
    objects: 400, soundDecay: 0.96, systemDecay: 0.9985, rebound: 0.35, len: 0.32, zero: 0.6,
    res: [{ f: 3000, r: 0.75 }],
  },
  tambourine: {
    objects: 32, soundDecay: 0.95, systemDecay: 0.9993, rebound: 0.35, len: 0.7, zero: 0.7,
    res: [
      { f: 2300, r: 0.97, g: 0.25 },               // 枠の鳴り
      { f: 5600, r: 0.9996, g: 1, rand: 0.03 },    // ジングル
      { f: 8100, r: 0.9996, g: 0.8, rand: 0.03 },
      { f: 6900, r: 0.9994, g: 0.5, rand: 0.04 },
      { f: 4400, r: 0.9993, g: 0.35, rand: 0.04 },
    ],
  },
  sleighbells: { // 鈴
    objects: 32, soundDecay: 0.97, systemDecay: 0.9995, rebound: 0.4, len: 1.0, zero: 0.5,
    res: [
      { f: 2500, r: 0.9997, g: 0.6, rand: 0.02 },
      { f: 5300, r: 0.9997, g: 1, rand: 0.02 },
      { f: 6500, r: 0.9997, g: 0.8, rand: 0.02 },
      { f: 8300, r: 0.9996, g: 0.5, rand: 0.02 },
      { f: 9800, r: 0.9995, g: 0.3, rand: 0.02 },
    ],
  },
};

export const INSTRUMENT_NAMES = {
  tambourine: 'タンバリン', maracas: 'マラカス', shaker: 'シェイカー', sleighbells: '鈴',
  cabasa: 'カバサ', clap: 'クラップ', chimes: 'チャイム', triangle: 'トライアングル',
};

// ---------- 初期化 ----------
export function unlockAudio() {
  try {
    // iOS 17以降:マナーモードでも鳴らす
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch (e) { /* noop */ }
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC({ latencyHint: 'interactive' });

    // 仕上げ:軽いコンプレッサー → 出力
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 3;
    comp.attack.value = 0.004; comp.release.value = 0.15;
    const out = ctx.createGain(); out.gain.value = 0.95;
    comp.connect(out); out.connect(ctx.destination);

    // 原音
    dryBus = ctx.createGain(); dryBus.gain.value = 1;
    dryBus.connect(comp);

    // 残響(小さめの部屋くらい)。高音を少し落として耳に痛くならないように
    const verb = ctx.createConvolver();
    verb.buffer = makeImpulse(1.4, 2.6);
    const verbTone = ctx.createBiquadFilter(); verbTone.type = 'lowpass'; verbTone.frequency.value = 7000;
    const wet = ctx.createGain(); wet.gain.value = 0.32;
    wetSend = ctx.createGain(); wetSend.gain.value = 1;
    wetSend.connect(verb); verb.connect(verbTone); verbTone.connect(wet); wet.connect(comp);
  }
  if (ctx.state === 'suspended') ctx.resume();
  // 無音を1回鳴らしてiOSのオーディオを起こす
  const s = ctx.createBufferSource();
  s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
  s.connect(ctx.destination); s.start();
}

export function setSoundEnabled(v) { enabled = v; }
export function isSoundEnabled() { return enabled; }

// 残響のインパルス応答:最初の反射音+だんだん暗くなる余韻(左右で少し違う)
function makeImpulse(seconds, decay) {
  const sr = ctx.sampleRate, n = Math.floor(seconds * sr);
  const buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const k = 0.15 + 0.8 * t;                  // 後ろほど高音を削る
      lp += (Math.random() * 2 - 1 - lp) * (1 - k);
      d[i] = lp * Math.pow(1 - t, decay) * (i < sr * 0.012 ? i / (sr * 0.012) : 1);
    }
    [0.007, 0.013, 0.019, 0.027, 0.034].forEach((tt, j) => { // 初期反射
      const i = Math.floor((tt + ch * 0.0017) * sr);
      if (i < n) d[i] += (j % 2 ? -0.5 : 0.6) * (1 - j * 0.12);
    });
  }
  return buf;
}

// ---------- PhISEMでシェイカー類を合成 ----------
export function renderShaker(p, sr, events, len = p.len) {
  const N = Math.floor(len * sr);
  const out = new Float32Array(N);
  const res = p.res.map((o) => ({ f: o.f, r: o.r, g: o.g ?? 1, rand: o.rand || 0, a1: 0, a2: o.r * o.r, y1: 0, y2: 0 }));
  const setF = (o, f) => { o.a1 = -2 * o.r * Math.cos((2 * Math.PI * f) / sr); };
  res.forEach((o) => setF(o, o.f));
  // 物理モデルの減衰は44.1kHz基準なので、サンプリング周波数に合わせて補正
  const k = 44100 / sr;
  const sysDecay = Math.pow(p.systemDecay, k);
  const sndDecay = Math.pow(p.soundDecay, k);
  const prob = (p.objects / 1024) * k;
  const zero = p.zero ?? 1;
  let energy = 0, level = 0, prev = 0, ei = 0;
  for (let i = 0; i < N; i++) {
    while (ei < events.length && events[ei].t * sr <= i) energy += events[ei++].e;
    energy *= sysDecay;
    if (Math.random() < prob) {               // 粒がひとつぶつかった
      level += energy;
      for (const o of res) if (o.rand) setF(o, o.f * (1 + (Math.random() * 2 - 1) * o.rand));
    }
    const input = level * (Math.random() * 2 - 1);
    level *= sndDecay;
    let sum = 0;
    for (const o of res) {
      const y = input - o.a1 * o.y1 - o.a2 * o.y2;
      o.y2 = o.y1; o.y1 = y;
      sum += y * o.g;
    }
    out[i] = sum - zero * prev;                // こもりを取る(zeroが大きいほど明るい)
    prev = sum;
  }
  fadeOut(out, sr, 0.03);
  return out;
}

function fadeOut(d, sr, sec) {
  const n = Math.min(d.length, Math.floor(sec * sr));
  for (let i = 0; i < n; i++) d[d.length - 1 - i] *= i / n;
}
// 聞こえ方の大きさ(ラウドネス)の目安:低音を削り高音を少し強調したうえで、
// 50ミリ秒ごとの音の強さ(RMS)のいちばん大きいところ
export function loudness(d, sr) {
  const w = Math.max(1, Math.floor(sr * 0.05));
  const a = Math.exp((-2 * Math.PI * 150) / sr);
  let hp = 0, px = 0, pw = 0, acc = 0, best = 0;
  const sq = new Float32Array(d.length);
  for (let i = 0; i < d.length; i++) {
    hp = a * (hp + d[i] - px); px = d[i];          // 150Hz以下を削る
    const v = hp + 0.5 * (hp - pw); pw = hp;        // 高音を少し強調(人の耳とスマホのスピーカー寄り)
    sq[i] = v * v;
    acc += sq[i];
    if (i >= w) acc -= sq[i - w];
    if (i >= w - 1) best = Math.max(best, acc / w);
  }
  if (d.length < w) best = acc / w;
  return Math.sqrt(best);
}
// すべての楽器をこの大きさにそろえる
const TARGET = 0.16;
function normalize(d, level) {
  const l = loudness(d, ctx.sampleRate);
  let k = l > 0 ? (TARGET * level) / l : 1;
  let m = 0;
  for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
  if (m * k > 2.5) k = 2.5 / m;                    // 極端な瞬間だけ抑える(最後はコンプレッサーで整える)
  for (let i = 0; i < d.length; i++) d[i] *= k;
  return d;
}
function toBuffer(d) {
  const b = ctx.createBuffer(1, d.length, ctx.sampleRate);
  b.getChannelData(0).set(d);
  return b;
}

// 楽器ごとに「ふつう」4パターン、「強く」2パターン、「ロール」1パターンを用意
function shakerSet(name) {
  if (cache.has(name)) return cache.get(name);
  const p = SHAKERS[name], sr = ctx.sampleRate;
  const make = (strong) => {
    const e = strong ? 2.2 : 0.85 + Math.random() * 0.3;
    const reb = 0.035 + Math.random() * 0.035;
    const ev = [{ t: 0, e }, { t: reb, e: e * p.rebound }];
    if (strong) ev.push({ t: reb + 0.05, e: e * 0.25 });
    return toBuffer(normalize(renderShaker(p, sr, ev, strong ? p.len * 1.3 : p.len), strong ? 1.5 : 1));
  };
  const rollEv = [0, 0.03, 0.06, 0.09, 0.12, 0.15].map((t, i) => ({ t, e: 0.5 + (i % 2) * 0.25 }));
  const set = {
    normal: [make(false), make(false), make(false), make(false)],
    strong: [make(true), make(true)],
    roll: toBuffer(normalize(renderShaker(p, sr, rollEv, 0.45), 0.9)),
  };
  cache.set(name, set);
  return set;
}

// ---------- 鳴らすための部品 ----------
// 原音と残響の両方へ送る。左右に少し散らして広がりを出す
function voice(gain = 1, pan = 0, wet = 1) {
  const g = ctx.createGain(); g.gain.value = gain;
  let node = g;
  if (ctx.createStereoPanner) {
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    g.connect(p); node = p;
  }
  node.connect(dryBus);
  const s = ctx.createGain(); s.gain.value = wet;
  node.connect(s); s.connect(wetSend);
  return g;
}
const rnd = (a, b) => a + Math.random() * (b - a);

function playBuffer(buf, t, out, rate = 1) {
  const s = ctx.createBufferSource();
  s.buffer = buf; s.playbackRate.value = rate;
  s.connect(out); s.start(t);
}

// 減衰するサイン波(金属や太鼓の「モード」)
function mode(t, out, freq, peak, decay, { type = 'sine', drop = 0 } = {}) {
  const o = ctx.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (drop) o.frequency.exponentialRampToValueAtTime(freq * (1 - drop), t + decay * 0.6);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  o.connect(g); g.connect(out); o.start(t); o.stop(t + decay + 0.05);
}

let noiseBuf = null;
function noise(t, out, { type = 'bandpass', freq = 1200, q = 1, peak = 0.5, attack = 0.001, decay = 0.05 }) {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  s.connect(f); f.connect(g); g.connect(out);
  s.start(t, Math.random() * 0.5); s.stop(t + attack + decay + 0.05);
}

// 手拍子:3回の細かい破裂+短い余韻。残響で部屋っぽく
function clap(t, out, strength = 1) {
  const f = rnd(1000, 1400);
  [0, 0.008, 0.017].forEach((d, i) => noise(t + d, out, { freq: f, q: 1.4, peak: 0.55 * strength, decay: i === 2 ? 0.11 : 0.012 }));
  noise(t, out, { type: 'highpass', freq: 3000, q: 0.5, peak: 0.12 * strength, decay: 0.03 });
}
// 何人かの手拍子(ばらけたタイミング)
function crowdClap(t, out, n = 3) {
  for (let i = 0; i < n; i++) clap(t + rnd(0, 0.022), out, rnd(0.5, 0.8));
}

// フレームドラムの「ドン」(低い胴鳴り+皮の当たり)
function frameDrum(t, out, strength = 1) {
  mode(t, out, 92, 0.9 * strength, 0.32, { drop: 0.18 });
  mode(t, out, 148, 0.35 * strength, 0.18, { drop: 0.1 });
  mode(t, out, 231, 0.18 * strength, 0.12);
  noise(t, out, { type: 'lowpass', freq: 1800, q: 0.7, peak: 0.35 * strength, decay: 0.025 });
}

// チャイム:高めのペンタトニックで、きらっと鳴る
const CHIME_NOTES = [1568, 1760, 2093, 2349, 2637, 3136, 3520, 4186];
function chime(t, out, freq, peak = 0.22) {
  mode(t, out, freq, peak, 1.6);
  mode(t, out, freq * 2.76, peak * 0.35, 0.9);
  mode(t, out, freq * 5.4, peak * 0.12, 0.4);
  mode(t, out, freq * 1.003, peak * 0.5, 1.4); // わずかなうなりで揺らぎ
}
// ベルツリー(上から下へ流れるチャイム)
function bellTree(t, out, peak = 0.16) {
  [...CHIME_NOTES].reverse().forEach((f, i) => chime(t + i * 0.045, out, f, peak * (1 - i * 0.05)));
}

// トライアングル:倍音が多く、長く響く金属音
function triangle(t, out, strength = 1) {
  const f0 = 1180;
  [[1, 0.25, 2.2], [1.505, 0.14, 1.8], [2.51, 0.12, 1.5], [3.39, 0.09, 1.2], [4.42, 0.07, 1.0], [5.63, 0.05, 0.8], [6.97, 0.04, 0.6]]
    .forEach(([r, a, d]) => { mode(t, out, f0 * r, a * strength, d); mode(t, out, f0 * r * 1.0015, a * 0.4 * strength, d * 0.9); });
  noise(t, out, { type: 'highpass', freq: 6000, q: 0.7, peak: 0.15 * strength, decay: 0.012 });
}

// 波形を直接組み立てる楽器の音量補正(シェイカー類と同じ大きさに聞こえるよう測って決めた値)
const TRIM = { clap: 4.4, chimes: 0.79, triangle: 0.5 };

function hit(name, t, out, strong) {
  const rate = rnd(0.97, 1.03);
  if (TRIM[name]) { const g = ctx.createGain(); g.gain.value = TRIM[name]; g.connect(out); out = g; }
  switch (name) {
    case 'clap':
      clap(t, out, strong ? 1.2 : 0.9);
      if (strong) clap(t + 0.012, out, 0.6);
      break;
    case 'chimes': {
      const n = strong ? 3 : 1;
      for (let i = 0; i < n; i++) chime(t + i * 0.06, out, CHIME_NOTES[Math.floor(Math.random() * CHIME_NOTES.length)], strong ? 0.23 : 0.22);
      break;
    }
    case 'triangle':
      triangle(t, out, strong ? 1.55 : 1);
      break;
    default: {
      const set = shakerSet(SHAKERS[name] ? name : 'tambourine');
      const list = strong ? set.strong : set.normal;
      playBuffer(list[Math.floor(Math.random() * list.length)], t, out, rate);
    }
  }
}

// ---------- 外から呼ぶ関数 ----------
// 最初の一振りが遅れないよう、使う楽器の音を先に作っておく
export function prepare(instrument) {
  if (!ctx) return;
  const names = [instrument, 'tambourine', 'sleighbells', 'shaker'].filter((n, i, a) => SHAKERS[n] && a.indexOf(n) === i);
  names.forEach((n, i) => setTimeout(() => shakerSet(n), i * 60));
}
let lastTree = 0;

// n = 0.6秒以内に一緒に振った人数(自分を含む), full = 全員そろったとみなす人数
// accent = 強く振ったとき(大きめの一発+フレームドラムの「ドン」)
export function playShake(instrument, n = 1, full = 99, { accent = false } = {}) {
  if (!enabled || !ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  const t = ctx.currentTime + 0.004;
  const base = Math.min(1, 0.5 + 0.13 * (n - 1)); // シンクロで大きく
  const out = voice(accent ? Math.min(1.3, base * 1.35) : base, rnd(-0.25, 0.25));
  hit(instrument, t, out, accent);
  if (accent) frameDrum(t, voice(0.8, 0, 0.6), 0.9);
  if (n >= 3) crowdClap(t, voice(0.55, rnd(-0.4, 0.4)), Math.min(5, n - 1)); // 3人以上で手拍子
  if (n >= 2 && n >= full && t - lastTree > 1.5) {  // 全員そろったらベルツリー
    lastTree = t;
    bellTree(t + 0.02, voice(0.9, 0, 1.3));
  }
}

// 手首をひねったとき:シャカシャカ(シェイカーのロール)
export function playRoll(instrument) {
  if (!enabled || !ctx) return;
  const t = ctx.currentTime + 0.004;
  const name = SHAKERS[instrument] ? instrument : 'shaker';
  playBuffer(shakerSet(name).roll, t, voice(0.75, rnd(-0.2, 0.2)), rnd(0.97, 1.03));
}

// 振り続けて止めたとき:締めの「ジャン!」
export function playFinale(instrument) {
  if (!enabled || !ctx) return;
  const t = ctx.currentTime + 0.004;
  frameDrum(t, voice(1, 0, 0.7), 1.1);
  hit(instrument, t, voice(1.1, 0), true);
  if (instrument !== 'tambourine') playBuffer(shakerSet('tambourine').strong[0], t + 0.005, voice(0.7, -0.2));
  playBuffer(shakerSet('sleighbells').strong[1], t + 0.01, voice(0.55, 0.25));
  bellTree(t + 0.06, voice(0.8, 0, 1.4), 0.13);
}

// 開発用:楽器1音をオフラインで録音して返す(音量合わせの測定に使う。アプリからは呼ばない)
export async function __renderOffline(name, strong = false) {
  const saved = [ctx, dryBus, wetSend];
  const sr = 48000;
  const off = new OfflineAudioContext(1, sr * 2, sr);
  ctx = off; dryBus = off.destination; wetSend = off.createGain(); // 残響なしで測る
  const savedCache = new Map(cache); cache.clear();
  try {
    hit(name, 0.01, off.destination, strong);
    const buf = await off.startRendering();
    const d = buf.getChannelData(0);
    return loudness(d, sr);
  } finally {
    [ctx, dryBus, wetSend] = saved;
    cache.clear(); savedCache.forEach((v, k) => cache.set(k, v));
  }
}
