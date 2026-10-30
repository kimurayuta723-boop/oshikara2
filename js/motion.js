// 振る・掲げる(横向き)・下ろす(縦向き/寝かせる)の判定
// 実機で調整しやすいよう、しきい値はここにまとめる
export const TUNING = {
  shakeThreshold: 13,   // m/s^2(重力を除いた加速度の大きさ)
  shakeCooldown: 140,   // ms
  strongShake: 26,      // m/s^2 これを超えたら「強く振った」(アクセント)
  twistThreshold: 320,  // deg/s 手首をひねったとみなす回転の速さ
  twistCooldown: 130,   // ms
  landscapeG: 6.0,      // 横向きとみなす重力のx成分
  portraitG: 6.5,       // 縦向きとみなす重力のy成分
  flatG: 7.0,           // 寝かせたとみなす重力のz成分
  smoothing: 0.85,      // 姿勢判定のローパス
};

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

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

export class Motion {
  constructor({ onShake, onPose, onTwist }) {
    this.onShake = onShake;
    this.onPose = onPose;
    this.onTwist = onTwist;
    this.lastTwist = 0;
    this.g = { x: 0, y: 9.8, z: 0 };
    this.pose = 'unknown';
    this.side = 1; // 横向きのとき、どちらに傾いているか
    this.lastShake = 0;
    this.hasSensor = false;
    this.handler = this.handle.bind(this);
  }

  start() { window.addEventListener('devicemotion', this.handler); }
  stop() { window.removeEventListener('devicemotion', this.handler); }

  handle(e) {
    const gi = e.accelerationIncludingGravity;
    if (!gi || gi.x == null) return;
    this.hasSensor = true;
    // iOSは重力の向きがAndroidと逆
    const s = isIOS ? -1 : 1;
    const gx = gi.x * s, gy = gi.y * s, gz = gi.z * s;
    const now = performance.now();

    // 振る
    const a = e.acceleration;
    let mag;
    if (a && a.x != null) mag = Math.hypot(a.x, a.y, a.z);
    else mag = Math.abs(Math.hypot(gx, gy, gz) - 9.8);
    if (mag > TUNING.shakeThreshold && now - this.lastShake > TUNING.shakeCooldown) {
      this.lastShake = now;
      this.onShake?.(mag, mag > TUNING.strongShake);
    } else if (mag < TUNING.shakeThreshold * 0.8 && now - this.lastShake > TUNING.shakeCooldown) {
      // 大きく振っていないのに速く回っている = 手首をひねった
      const r = e.rotationRate;
      const rot = r && r.alpha != null ? Math.hypot(r.alpha, r.beta, r.gamma) : 0;
      if (rot > TUNING.twistThreshold && now - this.lastTwist > TUNING.twistCooldown) {
        this.lastTwist = now;
        this.onTwist?.(rot);
      }
    }

    // 姿勢
    const k = TUNING.smoothing;
    this.g.x = this.g.x * k + gx * (1 - k);
    this.g.y = this.g.y * k + gy * (1 - k);
    this.g.z = this.g.z * k + gz * (1 - k);
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
