// 振る・ひねる・掲げる(横向き)・下ろす(縦向き/寝かせる)の判定
// 実機で調整しやすいよう、しきい値はここにまとめる
export const TUNING = {
  shakeThreshold: 12,   // m/s^2 これを超えた振りを「1回」と数える(重力を除いた加速度)
  rearmRatio: 0.55,     // 勢いがしきい値のこの割合まで落ちたら、次の1回を受け付ける
  minGap: 45,           // ms 同じ振りを二重に数えないための最短間隔(1秒に約20回まで追える)
  maxHold: 180,         // ms 勢いが落ちないまま振り続けても、この間隔で次を受け付ける
  fullShake: 34,        // m/s^2 このくらいで「思いきり振った」(強さ1.0)
  strongAt: 0.8,        // 強さがこれ以上なら「強く振った」(ドンが加わる)
  twistThreshold: 320,  // deg/s 手首をひねったとみなす回転の速さ
  twistCooldown: 110,   // ms
  landscapeG: 6.0,      // 横向きとみなす重力のx成分
  portraitG: 6.5,       // 縦向きとみなす重力のy成分
  flatG: 7.0,           // 寝かせたとみなす重力のz成分
  smoothing: 0.85,      // 姿勢判定のローパス
};

// 感度(メニューで切り替え)。しきい値に掛ける倍率
export const SENSITIVITY = [
  { id: 'high', label: '敏感', k: 0.75 },
  { id: 'normal', label: 'ふつう', k: 1 },
  { id: 'low', label: 'にぶめ', k: 1.35 },
];

const isIOS = typeof navigator !== 'undefined' && (/iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

export async function requestMotionPermission() {
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      return r === 'granted';
    }
    return typeof DeviceMotionEvent !== 'undefined';
  } catch (e) {
    return false;
  }
}

// 振りの検出
// 中の粒が壁に当たる「振り切った瞬間」=勢いがいちばん強くなった瞬間に1回と数える。
// その瞬間の強さ(0〜1)と、どちら向きに振り切ったか(+1/-1)も返す。
export class ShakeDetector {
  constructor(onHit) {
    this.onHit = onHit;
    this.k = 1;          // 感度の倍率
    this.armed = true;
    this.peak = 0;
    this.peakVec = null;
    this.lastHit = -1e9;
    this.prevMag = 0;
    this.lastRise = 0;
    this.dipped = false;
    this.hitAxis = null;
    this.hitDir = 0;
  }

  // a: 重力を除いた加速度 {x,y,z}, now: ms
  push(a, now) {
    const th = TUNING.shakeThreshold * this.k;
    const mag = Math.hypot(a.x, a.y, a.z);

    if (!this.armed) {
      // 一度勢いが落ちたか、逆向きに振り始めたら「次の1回」の準備
      if (mag < th * TUNING.rearmRatio) this.dipped = true;
      if (this.hitAxis && Math.sign(a[this.hitAxis]) === -this.hitDir && Math.abs(a[this.hitAxis]) > th * 0.5) this.dipped = true;
      if ((this.dipped && now - this.lastHit >= TUNING.minGap) || now - this.lastHit >= TUNING.maxHold) {
        this.armed = true; this.peak = 0; this.prevMag = 0;
      }
    }
    if (this.armed && mag > th) {
      const rise = mag - this.prevMag;
      if (this.peak > 0 && (mag < this.peak || rise < this.lastRise * 0.45)) {
        // 勢いが頭打ち、または下がり始めた = 振り切りの瞬間。
        // 頭打ちの段階で鳴らすので、山の頂点を待つより1コマ(約16ms)早い
        if (mag >= this.peak) { this.peak = mag + rise * 0.5; this.peakVec = a; } // 頂点を見込んで強さを推定
        this.fire(now);
      } else {
        if (mag >= this.peak) { this.peak = mag; this.peakVec = a; }
        this.lastRise = rise;
      }
    } else if (this.armed && this.peak > 0) {
      this.fire(now); // しきい値の上に1コマしかいなかった短い振り
    }
    this.prevMag = mag;
  }

  fire(now) {
    const th = TUNING.shakeThreshold * this.k;
    const full = TUNING.fullShake * this.k;
    const v = Math.max(0, Math.min(1, (this.peak - th * 0.8) / (full - th * 0.8)));
    const p = this.peakVec;
    const ax = Math.abs(p.x) >= Math.abs(p.y) && Math.abs(p.x) >= Math.abs(p.z) ? 'x' : Math.abs(p.y) >= Math.abs(p.z) ? 'y' : 'z';
    const dir = p[ax] >= 0 ? 1 : -1;
    this.armed = false; this.dipped = false; this.lastHit = now; this.peak = 0; this.lastRise = 0;
    this.hitAxis = ax; this.hitDir = dir;
    this.onHit({ v, dir, strong: v >= TUNING.strongAt, mag: p ? Math.hypot(p.x, p.y, p.z) : 0 });
  }
}

export class Motion {
  constructor({ onShake, onPose, onTwist }) {
    this.onShake = onShake;
    this.onPose = onPose;
    this.onTwist = onTwist;
    this.lastTwist = 0;
    this.g = { x: 0, y: 9.8, z: 0 };
    this.pose = 'unknown';
    this.side = 1; // 横向きのとき、どちらに傾いているか
    this.hasSensor = false;
    this.detector = new ShakeDetector((hit) => this.onShake?.(hit));
    this.handler = this.handle.bind(this);
  }

  setSensitivity(k) { this.detector.k = k; }
  start() { window.addEventListener('devicemotion', this.handler); }
  stop() { window.removeEventListener('devicemotion', this.handler); }

  handle(e) {
    const gi = e.accelerationIncludingGravity;
    if (!gi || gi.x == null) return;
    this.hasSensor = true;
    // iOSは重力の向きがAndroidと逆
    const s = isIOS ? -1 : 1;
    const gx = gi.x * s, gy = gi.y * s, gz = gi.z * s;
    const now = e.timeStamp || performance.now();

    // 姿勢(重力の向き。ゆっくり追う)
    const k = TUNING.smoothing;
    this.g.x = this.g.x * k + gx * (1 - k);
    this.g.y = this.g.y * k + gy * (1 - k);
    this.g.z = this.g.z * k + gz * (1 - k);

    // 振る:重力を除いた加速度。端末が出さない場合は、重力の推定を引いて求める
    const a = e.acceleration;
    const lin = a && a.x != null ? { x: a.x, y: a.y, z: a.z } : { x: gx - this.g.x, y: gy - this.g.y, z: gz - this.g.z };
    const before = this.detector.lastHit;
    this.detector.push(lin, now);

    // 大きく振っていないのに速く回っている = 手首をひねった
    if (this.detector.lastHit === before && this.detector.armed && this.detector.peak === 0) {
      const r = e.rotationRate;
      const rot = r && r.alpha != null ? Math.hypot(r.alpha, r.beta, r.gamma) : 0;
      if (rot > TUNING.twistThreshold * this.detector.k && now - this.lastTwist > TUNING.twistCooldown && now - this.detector.lastHit > 150) {
        this.lastTwist = now;
        this.onTwist?.(rot);
      }
    }

    let pose = 'mid';
    if (Math.abs(this.g.x) > TUNING.landscapeG) pose = 'landscape';
    else if (Math.abs(this.g.y) > TUNING.portraitG) pose = 'portrait';
    else if (Math.abs(this.g.z) > TUNING.flatG) pose = 'flat';
    if (pose === 'landscape') this.side = this.g.x > 0 ? 1 : -1;
    if (pose !== this.pose) {
      this.pose = pose;
      this.onPose?.(pose, this.side);
    }
  }
}
