import { HostNet, ClientNet } from './net.js';
import { Motion, requestMotionPermission, SENSITIVITY } from './motion.js';
import { unlockAudio, playShake, playRoll, playFinale, setSoundEnabled, isSoundEnabled, INSTRUMENT_NAMES, prepare } from './sound.js';
import { qrSvg } from './qr.js';

// ---------- 定数 ----------
// 色ごとに鳴る打楽器が変わる
const COLORS = [
  { c: '#FF3D9A', n: 'ピンク', inst: 'tambourine' },
  { c: '#3DE0FF', n: '水色', inst: 'maracas' },
  { c: '#B6FF3D', n: '黄緑', inst: 'shaker' },
  { c: '#B07CFF', n: '紫', inst: 'chimes' },
  { c: '#FFE600', n: '黄', inst: 'sleighbells' },
  { c: '#FF8A3D', n: 'オレンジ', inst: 'cabasa' },
  { c: '#FF5A5A', n: '赤', inst: 'clap' },
  { c: '#3DFFB0', n: 'ミント', inst: 'triangle' },
];
// 掲げられるグッズ
const ITEMS = {
  uchiwa: {
    label: 'うちわ', title: 'うちわを作る', raise: 'うちわを掲げる', chipsLabel: '定番のファンサ',
    max: 10, placeholder: '例:最高!',
    phrases: ['ピースして', '指さして', 'バーンして', '投げキスして', '名前呼んで', 'こっち見て'],
  },
  horns: {
    label: 'メロイック', title: 'メロイックを出す', raise: 'メロイックを掲げる', chipsLabel: '定番の煽り',
    max: 8, placeholder: '例:もっと来い',
    phrases: ['ROCK!', '煽って', 'ヘドバンして', '叫んで', 'メロイック返して', 'マイク向けて'],
  },
  light: {
    label: 'ペンライト', title: 'ペンライト', raise: 'ペンライトを点ける', chipsLabel: '',
    max: 0, placeholder: '', phrases: [],
  },
};
const LIGHT_MODES = [{ id: 'solid', label: '自分の色' }, { id: 'rainbow', label: '虹色' }];
const ITEM_IDS = Object.keys(ITEMS);
const ITEM_ICONS = {
  uchiwa: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="9" r="7"></circle><path d="M12 16v6"></path></svg>',
  horns: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 13V4"></path><path d="M17 13V7"></path><path d="M5 12h14v4a6 6 0 0 1-6 6h-2a6 6 0 0 1-6-6z"></path></svg>',
  light: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3"></rect><path d="M12 15v7"></path></svg>',
};
// メロイックサイン(人差し指と小指を立てた手)
const HAND_SVG = '<svg viewBox="0 0 200 250" xmlns="http://www.w3.org/2000/svg"><g style="fill:var(--oshi)" stroke="#fff" stroke-width="9" stroke-linejoin="round">'
  + '<rect x="38" y="8" width="38" height="150" rx="19"></rect>'
  + '<rect x="138" y="38" width="34" height="120" rx="17"></rect>'
  + '<rect x="30" y="112" width="148" height="122" rx="44"></rect>'
  + '<rect x="74" y="92" width="36" height="58" rx="18"></rect>'
  + '<rect x="108" y="98" width="34" height="52" rx="17"></rect>'
  + '<rect x="40" y="160" width="112" height="34" rx="17" transform="rotate(-10 96 177)"></rect>'
  + '</g></svg>';
const DECOS = [{ id: 'heart', label: 'ハート' }, { id: 'star', label: '星' }, { id: 'none', label: 'なし' }];
const SYNC_WINDOW = 600;   // ms:この間に振った人を「シンクロ」とみなす
const LOWER_HOLD = 1000;   // ms:下ろした状態がこれだけ続いたら作る画面に戻る
const ARM_HOLD = 400;      // ms:横向きがこれだけ続いたら「掲げた」
const FINALE_STREAK = 6;   // 回:これだけ続けて振ってから止めると「ジャン!」
const FINALE_GAP = 450;    // ms:これだけ振らなかったら「止めた」とみなす

const HEART = 'M12 21s-7.5-4.6-9.5-9.2C1 8.3 3.2 5 6.6 5c2 0 3.6 1.1 5.4 3 1.8-1.9 3.4-3 5.4-3C20.8 5 23 8.3 21.5 11.8 19.5 16.4 12 21 12 21z';
const STAR = 'M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 20.9l1.6-7L2 9.2l7.1-.6z';

const $ = (id) => document.getElementById(id);
const colorInfo = (c) => COLORS.find((x) => x.c === c) || COLORS[0];
const store = {
  get(k, d) { try { const v = localStorage.getItem('oshikara.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('oshikara.' + k, JSON.stringify(v)); } catch (e) { /* noop */ } },
};
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);

// ---------- ローカルの状態 ----------
const me = {
  cid: store.get('cid', null) || (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)),
  color: store.get('color', COLORS[0].c),
};
store.set('cid', me.cid);

const ui = {
  role: null, code: null, net: null,
  room: null, // ホストから届く共有状態
  item: ITEMS[store.get('item', 'uchiwa')] ? store.get('item', 'uchiwa') : 'uchiwa',
  sel: Object.fromEntries(ITEM_IDS.map((id) => [id, { phrase: ITEMS[id].phrases[0] || '', custom: '' }])),
  lightMode: store.get('lightMode', 'solid'),
  sense: store.get('sense', 'normal'),
  deco: 'heart',
  flip: store.get('flip', false),
  uchiwaOpen: false, armed: false, armTimer: null, lowerTimer: null,
  syncN: 1, syncAt: 0, full: 99, shakeTimes: [],
  groove: 0, streak: 0, lastShakeAt: 0, finaleTimer: null,
  wakeLock: null,
};

// ---------- ホストの処理(ルームを作った人のスマホだけで動く) ----------
// やることは「誰がいるか」と「シンクロした人数」を配るだけ
const host = {
  room: null, peerToCid: new Map(), recent: new Map(),

  init(code) { this.room = { code, members: {}, order: [] }; },
  push() { const s = this.room; deliver({ t: 'state', s }); ui.net.broadcast({ t: 'state', s }); },

  handle(cid, m, peerId) {
    const r = this.room;
    if (!m || typeof m !== 'object') return;
    if (m.t === 'join') {
      const color = COLORS.some((x) => x.c === m.color) ? m.color : COLORS[0].c;
      if (!r.members[cid]) r.order.push(cid);
      r.members[cid] = { color, online: true };
      if (peerId) this.peerToCid.set(peerId, cid);
      this.push();
    } else if (m.t === 'leave' && r.members[cid]) {
      r.members[cid].online = false;
      this.push();
    } else if (m.t === 'shake' && r.members[cid]) {
      if (!r.members[cid].online) { r.members[cid].online = true; this.push(); } // 戻ってきた人
      const now = Date.now();
      this.recent.set(cid, now);
      let n = 0;
      for (const [, t] of this.recent) if (now - t <= SYNC_WINDOW) n += 1;
      const full = Math.max(2, r.order.filter((id) => r.members[id].online).length);
      const msg = { t: 'sync', n, full };
      deliver(msg); ui.net.broadcast(msg);
    }
  },

  leave(peerId) {
    const cid = this.peerToCid.get(peerId);
    if (!cid || !this.room.members[cid]) return;
    this.room.members[cid].online = false;
    this.push();
  },
};

// 自分の操作を送る(ホストなら自分で処理)
function send(m) {
  if (ui.role === 'host') host.handle(me.cid, m);
  else ui.net?.send(m);
}

// ---------- 届いたメッセージ ----------
function deliver(m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'state') { ui.room = m.s; render(); }
  else if (m.t === 'sync') { ui.syncN = m.n; ui.syncAt = performance.now(); ui.full = m.full; renderSync(); }
}

// ---------- ホーム ----------
function setupHome() {
  const params = new URLSearchParams(location.search);
  if (params.get('room')) {
    $('in-code').value = params.get('room').replace(/\D/g, '').slice(0, 4);
    homeMsg(`部屋 ${$('in-code').value} に招待されています。色を選んで「参加する」を押してください。`);
  }
  renderColorGrid();
  $('btn-host').addEventListener('click', () => start('host'));
  $('btn-join').addEventListener('click', () => start('client'));
  $('in-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') start('client'); });
}

function renderColorGrid(gridId = 'color-grid') {
  const grid = $(gridId);
  grid.textContent = '';
  COLORS.forEach((col) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.type = 'button';
    b.style.background = col.c;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(col.c === me.color));
    b.setAttribute('aria-label', col.n);
    const nm = document.createElement('span'); nm.className = 'sw-color'; nm.textContent = col.n;
    const ins = document.createElement('span'); ins.className = 'sw-inst' + (INSTRUMENT_NAMES[col.inst].length >= 6 ? ' long' : ''); ins.textContent = INSTRUMENT_NAMES[col.inst];
    b.append(nm, ins);
    b.addEventListener('click', () => {
      me.color = col.c; store.set('color', me.color);
      renderColorGrid(gridId); applyAccent();
      unlockAudio(); playShake(col.inst); // 選んだ色の音を試し聞き
      if (ui.role) { send({ t: 'join', cid: me.cid, color: me.color }); render(); } // 部屋にいるときはみんなに反映
    });
    grid.appendChild(b);
  });
}

async function start(role) {
  const code = $('in-code').value.replace(/\D/g, '');
  if (role === 'client' && code.length !== 4) { homeMsg('4桁の部屋コードを入力してください。'); $('in-code').focus(); return; }

  // ボタンを押したこの瞬間に、振る動きと音の許可をまとめて取る
  const motionOk = await requestMotionPermission();
  unlockAudio();
  prepare(colorInfo(me.color).inst);
  motion.start();
  if (!motionOk) toast('この端末では振る動きを使えません。掲げた画面をタップすると鳴ります。');

  setBusy(true);
  homeMsg(role === 'host' ? '部屋を作っています…' : '接続しています…');
  try {
    if (role === 'host') {
      const net = new HostNet({
        onMessage: (peerId, m) => {
          const cid = m && m.t === 'join' ? clean(m.cid, 64) : host.peerToCid.get(peerId);
          if (cid) host.handle(cid, m, peerId);
        },
        onLeave: (peerId) => host.leave(peerId),
      });
      ui.net = net; ui.role = 'host';
      const c = await net.start();
      ui.code = c;
      host.init(c);
      host.handle(me.cid, { t: 'join', color: me.color });
    } else {
      await connectClient(code);
    }
    history.replaceState(null, '', '?room=' + ui.code);
    enterRoom();
  } catch (e) {
    console.error(e);
    ui.role = null;
    const t = e && e.type;
    homeMsg(t === 'peer-unavailable' || (e && e.message === 'timeout')
      ? '部屋が見つかりません。部屋コードを確かめてください。'
      : 'つながりませんでした。電波の良い場所で、もう一度お試しください。');
  } finally {
    setBusy(false);
  }
}

async function connectClient(code) {
  const net = new ClientNet({ onMessage: deliver, onClose: () => reconnect() });
  await net.join(code);
  ui.net = net; ui.role = 'client'; ui.code = code;
  net.send({ t: 'join', cid: me.cid, color: me.color });
}

let reconnecting = false;
async function reconnect() {
  if (reconnecting || ui.role !== 'client') return;
  reconnecting = true;
  toast('接続が切れました。つなぎ直しています…');
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    try { await connectClient(ui.code); toast('つながりました'); reconnecting = false; return; } catch (e) { /* retry */ }
  }
  reconnecting = false;
  toast('つながりませんでした。部屋を作った人のスマホでアプリが開いているか確かめてください。');
}

function setBusy(b) { $('btn-host').disabled = b; $('btn-join').disabled = b; }
function homeMsg(t) { $('home-msg').textContent = t; }

function enterRoom() {
  $('room-code').textContent = ui.code;
  keepAwake();
  render();
}

// ---------- 画面の描画 ----------
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('is-active', s.id === id));
}

function sel() { return ui.sel[ui.item]; }
function currentPhrase() { const s = sel(); return s.custom || s.phrase; }

function applyAccent() {
  document.documentElement.style.setProperty('--accent', me.color);
  document.documentElement.style.setProperty('--oshi', me.color);
}

function render() {
  applyAccent();
  if (!ui.room) return;
  show('s-room');
  renderMembers();
  renderMaker();
  if (ui.uchiwaOpen) renderUchiwa();
}

function renderMembers() {
  const box = $('members');
  box.textContent = '';
  ui.room.order.forEach((cid) => {
    const m = ui.room.members[cid];
    const info = colorInfo(m.color);
    const d = document.createElement('div');
    d.className = 'member' + (m.online ? '' : ' off');
    const a = document.createElement('div'); a.className = 'avatar'; a.style.background = m.color;
    const n = document.createElement('div'); n.textContent = cid === me.cid ? '自分' : INSTRUMENT_NAMES[info.inst];
    d.append(a, n);
    box.appendChild(d);
  });
}

function decoSvg(kind, size, left, top, color, rot) {
  if (kind === 'none') return null;
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('aria-hidden', 'true');
  s.classList.add('deco-i');
  s.style.left = left; s.style.top = top; s.style.transform = `rotate(${rot}deg)`;
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', kind === 'star' ? STAR : HEART);
  p.style.fill = color;
  s.appendChild(p);
  return s;
}

function fillDeco(box, kind, big) {
  box.textContent = '';
  const k = big ? 2 : 1;
  const items = [
    [34 * k, '5%', '8%', 'var(--oshi)', -14],
    [22 * k, big ? '12%' : '17%', big ? '6%' : '7%', '#FFE600', 12],
    [28 * k, big ? '87%' : '85%', big ? '70%' : '68%', 'var(--oshi)', 10],
  ];
  items.forEach(([sz, l, t, c, r]) => { const s = decoSvg(kind, sz, l, t, c, r); if (s) box.appendChild(s); });
}

function setItemClass(el) {
  ITEM_IDS.forEach((id) => el.classList.toggle('is-' + id, ui.item === id));
}

function renderMaker() {
  const item = ITEMS[ui.item];
  const s = sel();

  const tabs = $('item-tabs');
  tabs.textContent = '';
  ITEM_IDS.forEach((id) => {
    const b = document.createElement('button');
    b.className = 'item-tab'; b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(ui.item === id));
    b.innerHTML = ITEM_ICONS[id]; // 固定のアイコンのみ
    b.append(ITEMS[id].label);
    b.addEventListener('click', () => {
      ui.item = id; store.set('item', id);
      $('in-free').value = ui.sel[id].custom;
      renderMaker();
    });
    tabs.appendChild(b);
  });

  $('chips-label').textContent = item.chipsLabel;
  $('raise-label').textContent = item.raise;
  const free = $('in-free');
  free.maxLength = item.max;
  free.placeholder = item.placeholder;

  const chips = $('chips');
  chips.textContent = '';
  item.phrases.forEach((p) => {
    const b = document.createElement('button');
    b.className = 'chip'; b.type = 'button'; b.textContent = p;
    b.setAttribute('aria-pressed', String(!s.custom && s.phrase === p));
    b.addEventListener('click', () => { s.phrase = p; s.custom = ''; free.value = ''; renderMaker(); });
    chips.appendChild(b);
  });

  const isLight = ui.item === 'light';
  $('chips-field').hidden = isLight;
  $('free-field').hidden = isLight;
  $('light-row').hidden = !isLight;
  $('light-note').hidden = !isLight;
  const modes = $('light-modes');
  modes.textContent = '';
  LIGHT_MODES.forEach((mo) => {
    const b = document.createElement('button');
    b.className = 'deco-btn'; b.type = 'button'; b.textContent = mo.label;
    b.setAttribute('aria-pressed', String(ui.lightMode === mo.id));
    b.addEventListener('click', () => { ui.lightMode = mo.id; store.set('lightMode', mo.id); renderMaker(); });
    modes.appendChild(b);
  });

  $('deco-row').hidden = ui.item !== 'uchiwa';
  const decos = $('decos');
  decos.textContent = '';
  DECOS.forEach((d) => {
    const b = document.createElement('button');
    b.className = 'deco-btn'; b.type = 'button'; b.textContent = d.label;
    b.setAttribute('aria-pressed', String(ui.deco === d.id));
    b.addEventListener('click', () => { ui.deco = d.id; renderMaker(); });
    decos.appendChild(b);
  });

  const preview = $('preview');
  setItemClass(preview);
  preview.classList.toggle('rainbow', isLight && ui.lightMode === 'rainbow');
  const text = currentPhrase();
  $('preview-text').textContent = text;
  const len = Math.max(1, [...text].length);
  const pw = Math.min(window.innerWidth, 480) - 40 - 48;
  const fs = ui.item === 'horns' ? Math.min(40, (pw * 0.5) / len) : Math.min(50, (pw - 16) / len);
  $('preview-text').style.fontSize = Math.floor(fs) + 'px';
  $('preview-text').style.setProperty('--stroke', Math.max(4, Math.round(fs * 0.2)) + 'px'); // 文字が小さいときはフチも細く
  preview.style.setProperty('--hand', '128px');
  fillDeco($('preview-deco'), ui.item === 'uchiwa' ? ui.deco : 'none', false);
}

// ---------- 掲げる ----------
const motion = new Motion({ onShake: handleShake, onPose: handlePose, onTwist: handleTwist });

function openUchiwa() {
  if (!ui.room) return;
  ui.uchiwaOpen = true; ui.armed = false; ui.shakeTimes = []; ui.groove = 0; ui.streak = 0;
  setGroove(0);
  $('v-uchiwa').hidden = false;
  renderUchiwa();
  if (isHeld(motion.pose)) armSoon();
  try { document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {}); } catch (e) { /* noop */ }
}

function closeUchiwa() {
  ui.uchiwaOpen = false;
  clearTimeout(ui.armTimer); clearTimeout(ui.lowerTimer); clearTimeout(ui.finaleTimer);
  $('v-uchiwa').hidden = true;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

function renderUchiwa() {
  const stage = $('uchiwa-stage');
  const portraitWindow = window.innerHeight > window.innerWidth;
  const side = (motion.side || 1) * (ui.flip ? -1 : 1);
  stage.classList.toggle('rot-cw', portraitWindow && side > 0);
  stage.classList.toggle('rot-ccw', portraitWindow && side < 0);
  setItemClass(stage);
  stage.classList.toggle('rainbow', ui.item === 'light' && ui.lightMode === 'rainbow');
  const text = currentPhrase() || ' ';
  $('uchiwa-big').textContent = text;
  const W = Math.max(window.innerWidth, window.innerHeight);
  const H = Math.min(window.innerWidth, window.innerHeight);
  const len = Math.max(1, [...text].length);
  let big;
  if (ui.item === 'horns') {
    stage.style.setProperty('--hand', Math.floor(H * 0.64) + 'px');
    big = Math.min(H * 0.3, (W * 0.5) / len);
  } else {
    big = Math.min(H * 0.42, (W * 0.78) / len);
  }
  big = Math.floor(big);
  fillDeco($('uchiwa-deco'), ui.item === 'uchiwa' ? ui.deco : 'none', true);
  stage.style.setProperty('--big', big + 'px');
  stage.style.setProperty('--stroke', Math.max(8, Math.round(big * 0.17)) + 'px');
  $('uchiwa-hint').textContent = !motion.hasSensor
    ? 'タップで鳴ります ・ 長押しで戻ります'
    : ui.item === 'light' ? '振ると鳴ります ・ 寝かせるか長押しで戻ります' : '振ると鳴ります ・ 下ろすか長押しで戻ります';
}

function armSoon() {
  clearTimeout(ui.armTimer);
  ui.armTimer = setTimeout(() => { ui.armed = true; }, ARM_HOLD);
}

// うちわ・メロイック:横向きで掲げ、縦に戻すか寝かせると戻る
// ペンライト:縦でも横でも持てる。寝かせると戻る
function isHeld(pose) { return ui.item === 'light' ? pose === 'portrait' || pose === 'landscape' : pose === 'landscape'; }
function isLowered(pose) { return ui.item === 'light' ? pose === 'flat' : pose === 'portrait' || pose === 'flat'; }

function handlePose(pose) {
  if (!ui.uchiwaOpen) return;
  renderUchiwa(); // 持つ向きが変わったら文字の向きを合わせる
  if (isHeld(pose)) {
    clearTimeout(ui.lowerTimer);
    armSoon();
  } else {
    clearTimeout(ui.armTimer);
    clearTimeout(ui.lowerTimer);
    if (ui.armed && isLowered(pose)) {
      ui.lowerTimer = setTimeout(closeUchiwa, LOWER_HOLD);
    }
  }
}

// hit = { v: 強さ0〜1, dir: 振り切った向き, strong: 強く振ったか }
function handleShake(hit = {}) {
  if (!ui.uchiwaOpen) return;
  const { v = 0.5, dir = 1, strong = false } = hit;
  const now = performance.now();
  const n = now - ui.syncAt < SYNC_WINDOW + 200 ? Math.max(1, ui.syncN) : 1;
  playShake(colorInfo(me.color).inst, n, ui.full, { accent: strong, v, dir }); // 音を最優先で鳴らす
  send({ t: 'shake' });
  ui.shakeTimes.push(now);
  ui.shakeTimes = ui.shakeTimes.filter((t) => now - t < 4000);
  updateGroove();

  // 振り続けてから止めたら「ジャン!」
  ui.streak = now - ui.lastShakeAt < FINALE_GAP ? ui.streak + 1 : 1;
  ui.lastShakeAt = now;
  clearTimeout(ui.finaleTimer);
  if (ui.streak >= FINALE_STREAK) ui.finaleTimer = setTimeout(finale, FINALE_GAP);

  flash(strong, false, v);
}

function handleTwist() {
  if (!ui.uchiwaOpen) return;
  playRoll(colorInfo(me.color).inst);
  flash(false, true);
}

function finale() {
  ui.streak = 0;
  if (!ui.uchiwaOpen) return;
  playFinale(colorInfo(me.color).inst);
  const stage = $('uchiwa-stage');
  stage.classList.remove('finale'); void stage.offsetWidth; stage.classList.add('finale');
  sparks(12);
}

// 一定のテンポで振り続けると光が強くなる(点数はなし)
function updateGroove() {
  const t = ui.shakeTimes.slice(-6);
  const iv = t.slice(1).map((x, i) => x - t[i]);
  let steady = false;
  if (iv.length >= 3) {
    const sorted = [...iv].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    steady = med >= 90 && med <= 1000 && iv.every((x) => Math.abs(x - med) <= med * 0.25);
  }
  ui.groove = steady ? Math.min(10, ui.groove + 1) : Math.max(0, ui.groove - 3);
  setGroove(Math.ceil(ui.groove / 2));
}

function setGroove(level) {
  const stage = $('uchiwa-stage');
  stage.style.setProperty('--groove', level);
  stage.classList.toggle('groove-max', level >= 5);
  [...$('uchiwa-meter').children].forEach((el, i) => el.classList.toggle('on', i < level));
}

let flashTimer = null;
let heatTimer = null;
function flash(strong = false, small = false, v = 0.5) {
  const stage = $('uchiwa-stage');
  stage.style.setProperty('--hit', (0.4 + 0.6 * v).toFixed(2)); // 強く振るほど強く光る
  // 速く振っても1回ずつ光るよう、毎回やり直す
  stage.classList.remove('flash'); void stage.offsetWidth;
  stage.classList.add('flash', 'hot');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => stage.classList.remove('flash'), strong ? 160 : 90);
  clearTimeout(heatTimer);
  heatTimer = setTimeout(() => { stage.classList.remove('hot'); if (performance.now() - ui.lastShakeAt > 1700) { ui.groove = 0; setGroove(0); } }, 1800);
  if (ui.item === 'light') ripple(strong);
  else if (!small) sparks(strong ? 9 : 5);
}

function ripple(strong) {
  const box = $('light-ripples');
  const r = document.createElement('div');
  r.className = 'ripple';
  if (strong) r.style.borderWidth = '3vmin';
  box.appendChild(r);
  setTimeout(() => r.remove(), 750);
}

function sparks(count = 5) {
  const box = $('uchiwa-sparks');
  const ns = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < count; i++) {
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.classList.add('spark');
    const ang = Math.random() * Math.PI * 2;
    const dist = 120 + Math.random() * 160;
    s.style.left = 'calc(50% - 15px)'; s.style.top = 'calc(50% - 15px)';
    s.style.setProperty('--dx', Math.cos(ang) * dist * 1.6 + 'px');
    s.style.setProperty('--dy', Math.sin(ang) * dist + 'px');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', i % 2 ? STAR : HEART);
    p.style.fill = i % 2 ? '#FFE600' : 'var(--oshi)';
    s.appendChild(p);
    box.appendChild(s);
    setTimeout(() => s.remove(), 650);
  }
}

function renderSync() {
  const el = $('uchiwa-sync');
  el.hidden = ui.syncN < 2;
  el.querySelector('span').textContent = ui.syncN;
  clearTimeout(renderSync.t);
  renderSync.t = setTimeout(() => { el.hidden = true; }, SYNC_WINDOW + 400);
}

// ---------- 振りの感度 ----------
function senseInfo() { return SENSITIVITY.find((x) => x.id === ui.sense) || SENSITIVITY[1]; }
function setSense(id) {
  ui.sense = id; store.set('sense', id);
  motion.setSensitivity(senseInfo().k);
  $('m-sense').textContent = '振りの感度:' + senseInfo().label;
}

// ---------- メニュー・招待 ----------
function inviteUrl() { return location.origin + location.pathname + '?room=' + ui.code; }

// QRコードと部屋コードを大きく出す
function invite() {
  $('invite-qr').innerHTML = qrSvg(inviteUrl(), 260); // 自前で生成したSVGのみ
  $('invite-code').textContent = ui.code;
  $('invite-note').hidden = ui.role !== 'host';
  $('v-invite').hidden = false;
}

function shareLink() {
  const url = inviteUrl();
  const text = `推しカラの部屋に招待します(部屋コード ${ui.code})`;
  if (navigator.share) navigator.share({ title: '推しカラ', text, url }).catch(() => {});
  else copy(url, `招待リンクをコピーしました(部屋コード ${ui.code})`);
}

function copy(text, msg) {
  (navigator.clipboard?.writeText(text) || Promise.reject()).then(() => toast(msg), () => toast(text));
}

let toastTimer = null;
function toast(t) {
  const el = $('toast');
  el.textContent = t; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

async function keepAwake() {
  try { if ('wakeLock' in navigator && !ui.wakeLock) { ui.wakeLock = await navigator.wakeLock.request('screen'); ui.wakeLock.addEventListener('release', () => { ui.wakeLock = null; }); } } catch (e) { /* noop */ }
}

function setupRoom() {
  document.querySelectorAll('.js-hand').forEach((el) => { el.innerHTML = HAND_SVG; }); // 固定のイラスト
  $('in-free').addEventListener('input', (e) => { sel().custom = clean(e.target.value, ITEMS[ui.item].max); renderMaker(); });
  $('btn-raise').addEventListener('click', openUchiwa);
  // 長押し(0.6秒)でいつでも確実に戻れるように
  let pressTimer = null;
  let swallowUntil = 0;
  $('v-uchiwa').addEventListener('pointerdown', () => {
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => { swallowUntil = performance.now() + 800; closeUchiwa(); }, 600);
  });
  // 長押しで戻った直後、指を離したときのクリックが下のボタンに当たらないようにする
  document.addEventListener('click', (e) => { if (performance.now() < swallowUntil) { e.stopPropagation(); e.preventDefault(); swallowUntil = 0; } }, true);
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#v-uchiwa')) swallowUntil = 0; }, true); // 新しく触ったら通常どおり
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => $('v-uchiwa').addEventListener(ev, () => clearTimeout(pressTimer)));
  $('v-uchiwa').addEventListener('click', () => { if (!motion.hasSensor) handleShake({ v: 0.55 }); }); // センサーがない端末はタップで鳴らす
  $('m-color').addEventListener('click', () => { $('v-menu').hidden = true; renderColorGrid('room-color-grid'); $('v-color').hidden = false; });
  $('color-close').addEventListener('click', () => { $('v-color').hidden = true; });
  $('v-color').addEventListener('click', (e) => { if (e.target.id === 'v-color') $('v-color').hidden = true; });
  $('m-leave').addEventListener('click', () => {
    if (ui.role === 'client') send({ t: 'leave' });
    setTimeout(() => { location.href = location.pathname; }, 150);
  });
  window.addEventListener('pagehide', () => { if (ui.role === 'client') send({ t: 'leave' }); });
  $('btn-invite').addEventListener('click', invite);
  $('btn-share-link').addEventListener('click', shareLink);
  $('invite-close').addEventListener('click', () => { $('v-invite').hidden = true; });
  $('v-invite').addEventListener('click', (e) => { if (e.target.id === 'v-invite') $('v-invite').hidden = true; });
  $('btn-menu').addEventListener('click', () => {
    $('m-sense').textContent = '振りの感度:' + senseInfo().label;
    $('m-sound').textContent = isSoundEnabled() ? '音を消す' : '音を出す';
    $('m-leave').textContent = ui.role === 'host' ? '部屋を閉じる(全員の接続が切れます)' : '部屋を出る';
    $('v-menu').hidden = false;
  });
  $('m-close').addEventListener('click', () => { $('v-menu').hidden = true; });
  $('v-menu').addEventListener('click', (e) => { if (e.target.id === 'v-menu') $('v-menu').hidden = true; });
  $('m-invite').addEventListener('click', () => { $('v-menu').hidden = true; invite(); });
  $('m-flip').addEventListener('click', () => { ui.flip = !ui.flip; store.set('flip', ui.flip); $('v-menu').hidden = true; toast('文字の上下を反転しました'); });
  $('m-sense').addEventListener('click', () => {
    const i = (SENSITIVITY.findIndex((x) => x.id === ui.sense) + 1) % SENSITIVITY.length;
    setSense(SENSITIVITY[i].id);
  });
  $('m-sound').addEventListener('click', () => { setSoundEnabled(!isSoundEnabled()); $('m-sound').textContent = isSoundEnabled() ? '音を消す' : '音を出す'; });
  window.addEventListener('resize', () => { if (ui.uchiwaOpen) renderUchiwa(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ui.role) { keepAwake(); unlockAudio(); } });
}

setupHome();
setupRoom();
motion.setSensitivity(senseInfo().k);
applyAccent();

// 動作確認用(実機では使わない)
window.__oshikara = { ui, host, me, handleShake, handlePose, handleTwist, motion };
