// 打楽器の音(すべてその場で合成。音源ファイルなし・権利の心配なし)
//
// 楽器ごとに「何がぶつかって、どう響くか」をまねて作る。
//  ・マラカス/シェイカー/カバサ:中の粒がひとつずつ殻に当たる様子(PhISEM:Perry Cookの物理モデル)
//  ・タンバリン/鈴:決まった数のジングルや鈴が、それぞれ固有の金属の響き(倍音の比率)で鳴る
//  ・トライアングル/チャイム:金属の棒の響き方(倍音の比率・減衰・うなり)を再現
//  ・クラップ:手のひらの間の空気の響き+何度かに分かれた破裂
// 楽器の部品(ジングルの音程など)は固定なので、毎回「同じ楽器」に聞こえる。
// 振るたびに少しずつ違う当たり方のパターンを数種類あらかじめ作り、ランダムに選んで再生する。
// 仕上げに短い残響と、上限1dB手前で止める音量処理をかける。

let ctx = null;
let dryBus = null;
let wetSend = null;
let enabled = true;
const cache = new Map(); // 合成済みの音(楽器名@サンプリング周波数 → バッファ一式)

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
    ({ dry: dryBus, wet: wetSend } = buildMaster(ctx));
  }
  if (ctx.state === 'suspended') ctx.resume();
  // 無音を1回鳴らしてiOSのオーディオを起こす
  const s = ctx.createBufferSource();
  s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
  s.connect(ctx.destination); s.start();
}

// 仕上げの音量設計(スマホのスピーカーで出せる上限まで使う)
export const MASTER = {
  drive: 2.1,      // 全体の持ち上げ
  wet: 0.22,       // 残響の量(多すぎると音の芯がぼやけて小さく聞こえる)
  lowCut: 170,     // スマホのスピーカーで鳴らない低音は削り、そのぶん音量に回す
  presence: 3,     // 耳に届きやすい3kHz付近を少し持ち上げる(dB)
  ceiling: 0.885,  // 最終的な上限(-1.06dB。1dBの余裕を残す)
};

// 原音・残響 → 低音カット・明るさ調整 → コンプレッサーで粒をそろえる
// → 持ち上げ → ソフトクリップで上限に収める → 出力
// (コンプレッサーを2段にすると遅れが増えるので、最後はゼロ遅延のソフトクリップにする)
function buildMaster(c) {
  const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = MASTER.lowCut; hp.Q.value = 0.6;
  const pres = c.createBiquadFilter(); pres.type = 'peaking'; pres.frequency.value = 3200; pres.Q.value = 0.8; pres.gain.value = MASTER.presence;
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -12; comp.knee.value = 10; comp.ratio.value = 2.5; // 強弱の差を残すよう、かけすぎない
  comp.attack.value = 0.002; comp.release.value = 0.12;
  const drive = c.createGain(); drive.gain.value = MASTER.drive;
  const clip = c.createWaveShaper();
  const n = 4096, curve = new Float32Array(n), C = MASTER.ceiling;
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = C * Math.tanh((x * 1.6) / C) / Math.tanh(1.6 / C) ; }
  clip.curve = curve; clip.oversample = 'none'; // はみ出しが出ないよう、上限を厳密に守る
  hp.connect(pres); pres.connect(comp); comp.connect(drive); drive.connect(clip); clip.connect(c.destination);

  const dry = c.createGain(); dry.connect(hp);
  const verb = c.createConvolver(); verb.buffer = makeImpulse(1.4, 2.6, c);
  const verbTone = c.createBiquadFilter(); verbTone.type = 'lowpass'; verbTone.frequency.value = 7000;
  const wetG = c.createGain(); wetG.gain.value = MASTER.wet;
  const wet = c.createGain();
  wet.connect(verb); verb.connect(verbTone); verbTone.connect(wetG); wetG.connect(hp);
  return { dry, wet };
}

export function setSoundEnabled(v) { enabled = v; }
export function isSoundEnabled() { return enabled; }

// 残響のインパルス応答:最初の反射音+だんだん暗くなる余韻(左右で少し違う)
function makeImpulse(seconds, decay, c = ctx) {
  const sr = c.sampleRate, n = Math.floor(seconds * sr);
  const buf = c.createBuffer(2, n, sr);
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

// ---------- 合成の部品 ----------
// 決まった値で始まる乱数(楽器の部品を毎回同じにするため)
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = (a, b) => a + Math.random() * (b - a);

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
// crest:粒の音のとがった山を丸める度合い(聞こえ方の大きさの何倍で丸めるか)。
// 金属の澄んだ響きは歪むので丸めない(0)
function normalize(d, sr, level, crest = 0) {
  if (crest > 0) {
    const l0 = loudness(d, sr);
    if (l0 > 0) { const knee = l0 * crest; for (let i = 0; i < d.length; i++) d[i] = knee * Math.tanh(d[i] / knee); }
  }
  const l = loudness(d, sr);
  let k = l > 0 ? (TARGET * level) / l : 1;
  let m = 0;
  for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
  if (m * k > 2.5) k = 2.5 / m;                    // 極端な瞬間だけ抑える(最後は仕上げで整える)
  for (let i = 0; i < d.length; i++) d[i] *= k;
  return d;
}

function toBuffer(d, sr) {
  let b;
  try { b = new AudioBuffer({ length: d.length, sampleRate: sr, numberOfChannels: 1 }); }
  catch (e) { b = ctx.createBuffer(1, d.length, sr); }
  b.getChannelData(0).set(d);
  return b;
}

// 振った勢い:振った瞬間と振り返しで加わり、だんだん弱まる。
// 1サンプルごとに「粒(またはジングル)が当たったか」と「その強さ」を返す
function collisions(p, sr, events, N, onHit) {
  const k = 44100 / sr; // 物理モデルの定数は44.1kHz基準
  const sysDecay = Math.pow(p.systemDecay, k);
  const prob = (p.objects / 1024) * k;
  let energy = 0, ei = 0;
  for (let i = 0; i < N; i++) {
    while (ei < events.length && events[ei].t * sr <= i) energy += events[ei++].e;
    energy *= sysDecay;
    if (energy > 1e-4 && Math.random() < prob) onHit(i, energy * (0.35 + 0.65 * Math.random()));
  }
}

// 振るたびの当たり方:振った瞬間+振り返し(+強いときはもう一度)
function shakeEvents(strong, rebound) {
  const e = strong ? 2.2 : rnd(0.85, 1.15);
  const reb = rnd(0.035, 0.07);
  const ev = [{ t: 0, e }, { t: reb, e: e * rebound }];
  if (strong) ev.push({ t: reb + rnd(0.04, 0.06), e: e * 0.3 });
  return ev;
}
const ROLL_EVENTS = [0, 0.028, 0.058, 0.085, 0.115, 0.142, 0.17].map((t, i) => ({ t, e: 0.45 + (i % 2) * 0.25 }));

// ---------- 粒の楽器(マラカス・シェイカー・カバサ) ----------
// objects:粒の数 / soundDecay:1粒の音の短さ / systemDecay:勢いの減衰 / res:殻の響き
// zero:明るさ / mod:カバサのビーズが溝を越えるときの細かい周期
const SEEDS = {
  maracas: { // 乾いた木の実の粒。軽い「シャッ」
    objects: 14, soundDecay: 0.94, systemDecay: 0.9982, rebound: 0.35, len: 0.3, zero: 0.9,
    res: [{ f: 4600, r: 0.9 }, { f: 7000, r: 0.8, g: 0.4 }],
  },
  shaker: { // エッグシェイカー:細かい砂。粒が多く、ひとつひとつは小さい
    objects: 110, soundDecay: 0.955, systemDecay: 0.9992, rebound: 0.6, len: 0.34, zero: 0.4,
    res: [{ f: 3900, r: 0.74 }, { f: 2200, r: 0.62, g: 0.35 }, { f: 7600, r: 0.5, g: 0.2 }],
  },
  cabasa: { // 金属ビーズのチェーン。ザラッとした細かい周期がある
    objects: 380, soundDecay: 0.96, systemDecay: 0.9985, rebound: 0.35, len: 0.32, zero: 0.6,
    res: [{ f: 3100, r: 0.76 }, { f: 6300, r: 0.6, g: 0.45 }], mod: { hz: 190, depth: 0.7 },
  },
};

export function renderShaker(p, sr, events, len = p.len) {
  const N = Math.floor(len * sr);
  const out = new Float32Array(N);
  const res = p.res.map((o) => ({ g: o.g ?? 1, a1: -2 * o.r * Math.cos((2 * Math.PI * o.f) / sr), a2: o.r * o.r, y1: 0, y2: 0 }));
  const k = 44100 / sr;
  const sndDecay = Math.pow(p.soundDecay, k);
  const zero = p.zero ?? 1;
  const hits = new Float32Array(N);
  const prob = p.mod ? 1 : 0;
  collisions(p, sr, events, N, (i, a) => {
    // カバサ:ビーズが溝を越える周期で、当たりやすさが波打つ
    if (prob && Math.random() > 1 - p.mod.depth * (0.5 - 0.5 * Math.cos((2 * Math.PI * p.mod.hz * i) / sr))) return;
    hits[i] += a;
  });
  let level = 0, prev = 0;
  for (let i = 0; i < N; i++) {
    level += hits[i];
    const input = level * (Math.random() * 2 - 1);
    level *= sndDecay;
    let sum = 0;
    for (const o of res) {
      const y = input - o.a1 * o.y1 - o.a2 * o.y2;
      o.y2 = o.y1; o.y1 = y;
      sum += y * o.g;
    }
    out[i] = sum - zero * prev;
    prev = sum;
  }
  fadeOut(out, sr, 0.03);
  return out;
}

// ---------- 金属の部品の響き(モード合成) ----------
// units:部品(ジングル1枚・鈴1個)ごとの響き [{f, a, t60}] のリスト。
// 当たるたびに、ランダムに選ばれた部品が鳴る。ジングルは2枚が続けて当たる「チャッ」も再現
function renderMetal(p, sr, events, len) {
  const N = Math.floor(len * sr);
  const out = new Float32Array(N);
  // 部品ごとの響きを平らな配列に(速く計算するため)
  const A1 = [], A2 = [], GIN = [], AMP = [], IDX = [], unitStart = [], unitLen = [];
  p.units.forEach((u) => {
    unitStart.push(A1.length);
    u.forEach((m, mi) => {
      if (m.f >= sr * 0.45) return;
      const w = (2 * Math.PI * m.f) / sr, r = Math.pow(10, -3 / (m.t60 * sr));
      A1.push(2 * r * Math.cos(w)); A2.push(-r * r); GIN.push(Math.sin(w)); AMP.push(m.a); IDX.push(mi);
    });
    unitLen.push(A1.length - unitStart[unitStart.length - 1]);
  });
  const M = A1.length;
  const a1 = Float64Array.from(A1), a2 = Float64Array.from(A2), gin = Float64Array.from(GIN);
  const y1 = new Float64Array(M), y2 = new Float64Array(M);
  const kicks = [];                      // [サンプル位置, 部品, 強さ, 明るさ]
  const clicks = new Float32Array(N);
  const cl = Math.max(1, Math.floor(sr * 0.0004));
  const push = (i, ui, a, bright) => {
    if (i >= N) return;
    kicks.push([i, ui, a, bright]);
    for (let j = 0; j < cl && i + j < N; j++) clicks[i + j] += a * p.click * (Math.random() * 2 - 1) * (1 - j / cl); // 当たった瞬間の「カチッ」
  };
  collisions(p, sr, events, N, (i, a) => {
    const ui = Math.floor(Math.random() * p.units.length);
    const bright = rnd(0.7, 1);
    push(i, ui, a, bright);
    if (p.chatter && Math.random() < 0.7) push(i + Math.floor(sr * rnd(0.0008, 0.003)), ui, a * p.chatter, bright * 0.9);
  });
  kicks.sort((x, y) => x[0] - y[0]);
  let ki = 0, pc = 0, quiet = 0;
  for (let i = 0; i < N; i++) {
    while (ki < kicks.length && kicks[ki][0] === i) {
      const [, ui, a, bright] = kicks[ki++];
      for (let m = unitStart[ui], e = m + unitLen[ui]; m < e; m++) y1[m] += a * AMP[m] * Math.pow(bright, IDX[m]) * gin[m];
    }
    let sum = 0;
    for (let m = 0; m < M; m++) { const y = a1[m] * y1[m] + a2[m] * y2[m]; y2[m] = y1[m]; y1[m] = y; sum += y; }
    const c = clicks[i] - pc; pc = clicks[i];         // カチッは高い音だけ
    out[i] = sum + c;
    // 当たりが終わって十分小さくなったら打ち切る
    if (ki >= kicks.length) { if (Math.abs(sum) < 1e-6) { if (++quiet > sr * 0.02) break; } else quiet = 0; }
  }
  fadeOut(out, sr, 0.05);
  return out;
}

// タンバリン:10枚のジングル。円板の金属の響き(倍音比 1 : 1.53 : 2.12 : 2.72 : 3.4)
function tambourineSpec() {
  const r = seeded(7);
  const units = [];
  for (let j = 0; j < 10; j++) {
    const f = 3700 + r() * 2600;
    const d = 0.85 + r() * 0.3;
    units.push([[1, 1, 0.3], [1.53, 0.8, 0.23], [2.12, 0.6, 0.17], [2.72, 0.42, 0.12], [3.4, 0.26, 0.085]]
      .map(([k, a, t]) => ({ f: f * k * (1 + (r() - 0.5) * 0.02), a, t60: t * d })));
  }
  return { units, objects: 28, systemDecay: 0.9992, rebound: 0.35, len: 0.75, click: 0.22, chatter: 0.55 };
}
// 鈴:12個の小さな鈴。中の玉が当たり、澄んだ音が長めに残る(倍音比 1 : 2.12 : 3.47 : 4.9)
function sleighSpec() {
  const r = seeded(11);
  const units = [];
  for (let j = 0; j < 12; j++) {
    const f = 2600 + r() * 2100;
    units.push([[1, 1, 0.85], [2.12, 0.45, 0.5], [3.47, 0.25, 0.3], [4.9, 0.12, 0.18]]
      .map(([k, a, t]) => ({ f: f * k * (1 + (r() - 0.5) * 0.012), a, t60: t * (0.9 + r() * 0.2) })));
  }
  return { units, objects: 36, systemDecay: 0.9995, rebound: 0.4, len: 1.1, click: 0.06, chatter: 0.35 };
}

// ---------- 減衰する正弦波の重ね合わせ(棒の金属・太鼓の皮) ----------
// partials: [{f, a, t60, beat}] beat:わずかにずれた2つ目の成分(うなり)
function renderPartials(partials, sr, len, { glide = 0, glideT = 0.03 } = {}) {
  const N = Math.floor(len * sr);
  const out = new Float32Array(N);
  for (const p of partials) {
    if (p.f >= sr * 0.45) continue;
    const comps = [[p.f, p.a]];
    if (p.beat) comps.push([p.f + p.beat, p.a * 0.55]);
    for (const [f, a] of comps) {
      const r = Math.pow(10, -3 / (p.t60 * sr));
      const end = Math.min(N, Math.ceil(Math.log(1e-5 / Math.max(a, 1e-9)) / Math.log(r))); // 聞こえなくなったら打ち切る
      if (glide) {
        let g = a, ph = Math.random() * 0.2;
        for (let i = 0; i < end; i++) {
          ph += (2 * Math.PI * f * (1 + glide * Math.exp(-i / (glideT * sr)))) / sr;
          out[i] += g * Math.sin(ph); g *= r;
        }
      } else {
        // 減衰する正弦波を漸化式で作る(sinを毎回計算しないので速い)
        const w = (2 * Math.PI * f) / sr, ph = Math.random() * 0.2;
        const c1 = 2 * r * Math.cos(w), c2 = -r * r;
        let y2 = a * Math.sin(ph - w) / r, y1 = a * Math.sin(ph);
        out[0] += y1;
        for (let i = 1; i < end; i++) { const y = c1 * y1 + c2 * y2; y2 = y1; y1 = y; out[i] += y; }
      }
    }
  }
  return out;
}
function addNoiseBurst(out, sr, at, dur, amp, { hp = false, lpHz = 0 } = {}) {
  const n = Math.floor(dur * sr), s = Math.floor(at * sr);
  const a = lpHz ? Math.exp((-2 * Math.PI * lpHz) / sr) : 0;
  let y = 0, px = 0;
  for (let j = 0; j < n && s + j < out.length; j++) {
    let x = Math.random() * 2 - 1;
    if (lpHz) { y = (1 - a) * x + a * y; x = y * 2; }
    if (hp) { const t = x - px; px = x; x = t; }
    out[s + j] += amp * x * Math.pow(1 - j / n, 2);
  }
}

// トライアングル:曲げた鋼の棒。整数倍から不ぞろいにずれた倍音がたくさん並び、
// 基音は弱く、高い倍音が長く残る。たたく位置で倍音の出方が変わる。わずかなうなりで揺らぐ
function renderTriangle(sr, strong, variant) {
  const r = seeded(23);
  const f0 = 760, pos = 0.13 + variant * 0.015;
  const partials = [];
  for (let n = 1; n <= 22; n++) {
    let a = 1 / Math.pow(n, 0.45) * (0.6 + 0.4 * r());
    if (n === 1) a *= 0.25; else if (n === 2) a *= 0.5;
    a *= 0.35 + 0.65 * Math.abs(Math.sin(Math.PI * n * pos));
    if (strong) a *= Math.pow(n / 6, 0.25);
    // 曲げた部分の影響で倍音の並びは不ぞろい(だから音程がはっきりしない、トライアングルらしい音になる)
    partials.push({ f: f0 * (n + (r() - 0.5) * 0.4) * (1 + 0.0011 * n), a, t60: 3.6 / (1 + 0.09 * n), beat: 0.5 + 0.12 * n * r() });
  }
  const d = renderPartials(partials, sr, 3.0);
  addNoiseBurst(d, sr, 0, 0.0007, strong ? 0.9 : 0.6, { hp: true }); // 金属のビーターが当たる「チン」
  fadeOut(d, sr, 0.2);
  return d;
}

// チャイム:アルミの棒(自由振動の棒の倍音比 1 : 2.756 : 5.404 : 8.933)。木の打ち子が当たる音つき
const CHIME_NOTES = [1568, 1760, 2093, 2349, 2637, 3136, 3520, 4186];
function renderChime(sr, f) {
  const r = seeded(Math.round(f));
  const pos = 0.18 + r() * 0.1;
  const partials = [[1, 1, 3.2], [2.756, 0.55, 1.6], [5.404, 0.3, 0.8], [8.933, 0.14, 0.45]]
    .map(([k, a, t], i) => ({ f: f * k, a: a * (0.5 + 0.5 * Math.abs(Math.sin(Math.PI * (i + 1) * pos))), t60: t, beat: 0.25 + r() * 0.4 }));
  const d = renderPartials(partials, sr, 3.2);
  addNoiseBurst(d, sr, 0, 0.002, 0.12, { lpHz: 2500 }); // 木の打ち子
  fadeOut(d, sr, 0.2);
  return d;
}

// クラップ:手のひらの間の空気が共鳴して「パン」。実際は何度かに分かれて当たる
function renderClap(sr, strong) {
  const N = Math.floor(0.3 * sr);
  const ex = new Float32Array(N);
  const times = [0, rnd(0.006, 0.01), rnd(0.013, 0.019)];
  if (strong) times.push(rnd(0.021, 0.026));
  times.forEach((t, i) => {
    const last = i === times.length - 1;
    const tau = (last ? rnd(0.01, 0.016) : 0.0012) * sr;
    const s = Math.floor(t * sr), amp = last ? 1 : rnd(0.55, 0.85);
    for (let j = 0; s + j < N && j < tau * 7; j++) ex[s + j] += amp * (Math.random() * 2 - 1) * Math.exp(-j / tau);
  });
  // 手の形で決まる共鳴(手のひらを平らに=明るい、くぼませる=こもる)
  const f = strong ? rnd(1300, 1800) : rnd(950, 1500);
  const bw = rnd(280, 480), rr = Math.exp((-Math.PI * bw) / sr), w = (2 * Math.PI * f) / sr;
  const a1 = 2 * rr * Math.cos(w), a2 = -rr * rr;
  const out = new Float32Array(N);
  let y1 = 0, y2 = 0, px = 0;
  for (let i = 0; i < N; i++) {
    const y = a1 * y1 + a2 * y2 + ex[i] * (1 - rr);
    y2 = y1; y1 = y;
    const snap = ex[i] - px; px = ex[i];        // 皮膚がぶつかる高い成分
    out[i] = y * 6 + snap * 0.18;
  }
  fadeOut(out, sr, 0.05);
  return out;
}

// フレームドラムの「ドン」:張った皮の響き(円い膜の倍音比 1 : 1.59 : 2.14 : 2.30 : 2.65 : 2.92)。
// たたいた直後は皮が張って音程がわずかに高く、すぐ落ち着く。スマホでも聞こえるよう基音はやや高め
function renderDrum(sr) {
  const f1 = 165;
  const partials = [[1, 1, 0.38], [1.594, 0.55, 0.24], [2.136, 0.4, 0.18], [2.296, 0.3, 0.15], [2.653, 0.22, 0.12], [2.918, 0.15, 0.1]]
    .map(([k, a, t]) => ({ f: f1 * k * rnd(0.99, 1.01), a, t60: t }));
  const d = renderPartials(partials, sr, 0.5, { glide: 0.07, glideT: 0.03 });
  addNoiseBurst(d, sr, 0, 0.008, 0.5, { lpHz: 2500 }); // 手が皮に当たる音
  fadeOut(d, sr, 0.05);
  return d;
}

// ---------- 楽器ごとの音一式(初めて使うときに作って保存) ----------
// level:ふつう=1 / 強く=1.5 / ロール=0.9 をそれぞれ同じ基準でそろえる
function getSet(name) {
  const sr = ctx.sampleRate, key = name + '@' + sr;
  if (cache.has(key)) return cache.get(key);
  const B = (d, level, crest) => toBuffer(normalize(d, sr, level, crest), sr);
  let set;
  if (SEEDS[name]) {
    const p = SEEDS[name];
    const mk = (strong) => B(renderShaker(p, sr, shakeEvents(strong, p.rebound), strong ? p.len * 1.3 : p.len), strong ? 1.5 : 1, 2.0);
    set = { normal: [mk(false), mk(false), mk(false), mk(false)], strong: [mk(true), mk(true)], roll: B(renderShaker(p, sr, ROLL_EVENTS, 0.45), 0.9, 2.0) };
  } else if (name === 'tambourine' || name === 'sleighbells') {
    const p = name === 'tambourine' ? tambourineSpec() : sleighSpec();
    const crest = name === 'tambourine' ? 3.0 : 0;
    const mk = (strong) => B(renderMetal(p, sr, shakeEvents(strong, p.rebound), strong ? p.len * 1.2 : p.len), strong ? 1.5 : 1, crest);
    set = { normal: [mk(false), mk(false), mk(false), mk(false)], strong: [mk(true), mk(true)], roll: B(renderMetal(p, sr, ROLL_EVENTS, p.len), 0.9, crest) };
  } else if (name === 'clap') {
    const mk = (strong) => B(renderClap(sr, strong), strong ? 1.5 : 1, 2.2);
    set = { normal: [mk(false), mk(false), mk(false), mk(false), mk(false), mk(false)], strong: [mk(true), mk(true), mk(true)] };
  } else if (name === 'triangle') {
    set = { normal: [B(renderTriangle(sr, false, 0), 1), B(renderTriangle(sr, false, 1), 1)], strong: [B(renderTriangle(sr, true, 0), 1.5)] };
  } else if (name === 'chimes') {
    set = { notes: new Map() }; // 音ごとに、必要になったときに作る
  } else if (name === 'drum') {
    set = { normal: [B(renderDrum(sr), 1), B(renderDrum(sr), 1)] };
  }
  cache.set(key, set);
  return set;
}
function chimeBuf(f) {
  const set = getSet('chimes');
  if (!set.notes.has(f)) set.notes.set(f, toBuffer(normalize(renderChime(ctx.sampleRate, f), ctx.sampleRate, 1), ctx.sampleRate));
  return set.notes.get(f);
}
const pick = (a) => a[Math.floor(Math.random() * a.length)];

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

function playBuffer(buf, t, out, rate = 1, gain = 1) {
  const s = ctx.createBufferSource();
  s.buffer = buf; s.playbackRate.value = rate;
  if (gain !== 1) { const g = ctx.createGain(); g.gain.value = gain; s.connect(g); g.connect(out); }
  else s.connect(out);
  s.start(t);
  return s;
}

// 同じ楽器が重なりすぎないよう、古い音から静かに消す(響きの長い楽器ほど少なく)
const VOICE_CAP = { triangle: 3, chimes: 6, sleighbells: 6, tambourine: 8 };
const active = new Map();
function track(name, g, t, dur) {
  const list = (active.get(name) || []).filter((x) => x.end > t);
  const cap = VOICE_CAP[name] || 12;
  while (list.length >= cap) {
    const old = list.shift();
    old.g.gain.cancelScheduledValues(t);
    old.g.gain.setTargetAtTime(0, t, 0.025);
  }
  list.push({ g, end: t + dur });
  active.set(name, list);
}

// 何人かの手拍子(ばらけたタイミング)
function crowdClap(t, out, n = 3) {
  const set = getSet('clap');
  for (let i = 0; i < n; i++) playBuffer(pick(set.normal), t + rnd(0, 0.022), out, rnd(0.96, 1.04), rnd(0.5, 0.8));
}
function frameDrum(t, out, strength = 1) { playBuffer(pick(getSet('drum').normal), t, out, rnd(0.98, 1.02), strength); }
// ベルツリー(上から下へ流れるチャイム)
function bellTree(t, out, peak = 1) {
  [...CHIME_NOTES].reverse().forEach((f, i) => playBuffer(chimeBuf(f), t + i * 0.045, out, 1, peak * 0.55 * (1 - i * 0.05)));
}

// 最終出力で、聞こえ方の大きさがそろうよう測って決めた補正(dB)
const LEVEL_DB = { tambourine: 1.0, maracas: 6.0, shaker: 0.7, sleighbells: -2.6, cabasa: 5.4, clap: 3.6, chimes: -1.0, triangle: -0.4 };

// dir:振り切った向き(+1/-1)。粒の楽器は行きと帰りで少し音が違う(シャッ・カッ)
let lastChime = 0;
function hit(name, t, out, strong, dir = 1) {
  const lv = Math.pow(10, (LEVEL_DB[name] || 0) / 20);
  if (lv !== 1) { const g = ctx.createGain(); g.gain.value = lv; g.connect(out); out = g; }
  if (name === 'chimes') {
    const n = strong ? 3 : 1;
    for (let i = 0; i < n; i++) {
      let f; do { f = pick(CHIME_NOTES); } while (f === lastChime);
      lastChime = f;
      playBuffer(chimeBuf(f), t + i * rnd(0.05, 0.07), out, 1, strong ? 0.75 : 1);
    }
    return 3.2;
  }
  const set = getSet(SEEDS[name] || name === 'tambourine' || name === 'sleighbells' || name === 'clap' || name === 'triangle' ? name : 'tambourine');
  let list = strong ? set.strong : set.normal;
  if (!strong && list.length >= 4) list = dir < 0 ? list.slice(2) : list.slice(0, 2); // 行きは0・1、帰りは2・3
  const rate = name === 'triangle' ? 1 : rnd(0.985, 1.015) * (dir < 0 ? 1.03 : 1);
  const b = pick(list);
  playBuffer(b, t, out, rate);
  return b.duration;
}

// ---------- 外から呼ぶ関数 ----------
// 最初の一振りが遅れないよう、使う楽器の音を先に作っておく
export function prepare(instrument) {
  if (!ctx) return;
  const names = [instrument, 'drum', 'clap', 'tambourine', 'sleighbells'].filter((n, i, a) => a.indexOf(n) === i);
  names.forEach((n, i) => setTimeout(() => { if (n === 'chimes') CHIME_NOTES.forEach((f, j) => setTimeout(() => chimeBuf(f), j * 40)); else getSet(n); }, i * 80));
  setTimeout(() => CHIME_NOTES.forEach((f, j) => setTimeout(() => chimeBuf(f), j * 40)), names.length * 80 + 200); // ベルツリー用
}
let lastTree = 0;

// n = 0.6秒以内に一緒に振った人数(自分を含む), full = 全員そろったとみなす人数
// v = 振りの強さ(0〜1)。音量と音の明るさが連続的に変わる
// accent = 強く振ったとき(大きめの一発+フレームドラムの「ドン」) / dir = 振り切った向き
export function playShake(instrument, n = 1, full = 99, { accent = false, v = 0.5, dir = 1 } = {}) {
  if (!enabled || !ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  const t = ctx.currentTime; // すぐ鳴らす
  const sync = Math.min(1, 0.5 + 0.13 * (n - 1)) / 0.5;    // シンクロで大きく(1人=1倍)
  const dyn = 0.24 + 0.92 * Math.pow(v, 1.15);             // 弱い振り≈-12dB 〜 強い振り≈+1.3dB(差をしっかり残す)
  const out = voice(Math.min(1.5, 0.5 * sync * dyn), rnd(-0.25, 0.25));
  // 弱く振ると柔らかく、強く振るとシャープに(本物の楽器と同じ)
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass'; tone.Q.value = 0.5;
  tone.frequency.value = 5000 * Math.pow(20000 / 5000, Math.min(1, v * 1.4)); // 弱い振りだけ少しこもらせる
  tone.connect(out);
  const dur = hit(instrument, t, tone, accent, dir);
  track(instrument, out, t, dur);
  if (accent) frameDrum(t, voice(0.8, 0, 0.6), 0.9);
  if (n >= 3) crowdClap(t, voice(0.55, rnd(-0.4, 0.4)), Math.min(5, n - 1)); // 3人以上で手拍子
  if (n >= 2 && n >= full && t - lastTree > 1.5) {  // 全員そろったらベルツリー
    lastTree = t;
    bellTree(t + 0.02, voice(0.9, 0, 1.3), 1);
  }
}

// 手首をひねったとき:シャカシャカ(シェイカーのロール)
export function playRoll(instrument) {
  if (!enabled || !ctx) return;
  const t = ctx.currentTime;
  const name = SEEDS[instrument] || instrument === 'tambourine' || instrument === 'sleighbells' ? instrument : 'shaker';
  playBuffer(getSet(name).roll, t, voice(0.75, rnd(-0.2, 0.2)), rnd(0.97, 1.03));
}

// 振り続けて止めたとき:締めの「ジャン!」
export function playFinale(instrument) {
  if (!enabled || !ctx) return;
  const t = ctx.currentTime;
  frameDrum(t, voice(1, 0, 0.7), 1.1);
  hit(instrument, t, voice(1.1, 0), true);
  if (instrument !== 'tambourine') playBuffer(getSet('tambourine').strong[0], t + 0.005, voice(0.7, -0.2));
  if (instrument !== 'sleighbells') playBuffer(getSet('sleighbells').strong[1], t + 0.01, voice(0.55, 0.25));
  bellTree(t + 0.06, voice(0.8, 0, 1.4), 0.8);
}

// 開発用:楽器1音をオフラインで録音して返す(音量合わせの測定に使う。アプリからは呼ばない)
export async function __renderOffline(name, strong = false) {
  const saved = [ctx, dryBus, wetSend];
  const sr = 48000;
  const off = new OfflineAudioContext(1, sr * 2, sr);
  ctx = off; dryBus = off.destination; wetSend = off.createGain(); // 残響なしで測る
  try {
    hit(name, 0.01, off.destination, strong);
    const buf = await off.startRendering();
    const d = buf.getChannelData(0);
    return loudness(d, sr);
  } finally {
    [ctx, dryBus, wetSend] = saved;
  }
}

// 開発用:仕上げまで通した最終出力を録音して、最大音量と聞こえ方の大きさを返す
export async function __measureFull(name, opts = {}) {
  const saved = [ctx, dryBus, wetSend];
  const sr = 48000;
  const off = new OfflineAudioContext(2, sr * 2, sr);
  ctx = off; ({ dry: dryBus, wet: wetSend } = buildMaster(off));
  try {
    if (opts.finale) playFinale(name); else playShake(name, opts.n || 1, opts.full || 99, opts);
    const buf = await off.startRendering();
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    let peak = 0; for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    return { peakDb: 20 * Math.log10(peak), loudDb: 20 * Math.log10(loudness(L, sr)) };
  } finally {
    [ctx, dryBus, wetSend] = saved;
  }
}

// 開発用:ふつう→強く→ふつうの3打を残響なしで録音して返す(音色の確認用)
export async function __renderSeq(name, off) {
  const saved = [ctx, dryBus, wetSend];
  ctx = off; dryBus = off.destination; wetSend = off.createGain();
  try {
    [[0.05, false], [0.5, true], [1.0, false]].forEach(([t, s], i) => hit(name, t, off.destination, s, i % 2 ? -1 : 1));
    const buf = await off.startRendering();
    return Array.from(buf.getChannelData(0).filter((_, i) => i % 1 === 0));
  } finally { [ctx, dryBus, wetSend] = saved; }
}
