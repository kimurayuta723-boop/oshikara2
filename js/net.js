// PeerJS(WebRTC)で、ルームを作った人のスマホを中継役にしてつなぐ
// サーバーを用意しなくてもGitHub Pagesだけで動く
const PREFIX = 'oshikara-v1-';
const OPTS = { debug: 1 };

function makeCode() { return String(Math.floor(1000 + Math.random() * 9000)); }

function waitPeerLib(timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function check() {
      if (window.Peer) return resolve(window.Peer);
      if (Date.now() - t0 > timeout) return reject(new Error('通信ライブラリを読み込めませんでした'));
      setTimeout(check, 100);
    })();
  });
}

export class HostNet {
  constructor({ onMessage, onLeave }) {
    this.onMessage = onMessage;
    this.onLeave = onLeave;
    this.conns = new Map();
  }

  async start(attempt = 0) {
    const Peer = await waitPeerLib();
    return new Promise((resolve, reject) => {
      const code = makeCode();
      const peer = new Peer(PREFIX + code, OPTS);
      let opened = false;
      peer.on('open', () => { opened = true; this.peer = peer; this.code = code; resolve(code); });
      peer.on('error', (e) => {
        if (!opened && e.type === 'unavailable-id' && attempt < 5) {
          peer.destroy();
          this.start(attempt + 1).then(resolve, reject);
        } else if (!opened) {
          reject(e);
        } else {
          console.warn('[host]', e);
        }
      });
      peer.on('connection', (conn) => {
        conn.on('open', () => this.conns.set(conn.peer, conn));
        conn.on('data', (d) => {
          // openの通知より先にデータが届いても、返事を取りこぼさないように登録しておく
          if (!this.conns.has(conn.peer)) this.conns.set(conn.peer, conn);
          this.onMessage(conn.peer, d);
        });
        conn.on('close', () => { this.conns.delete(conn.peer); this.onLeave(conn.peer); });
        conn.on('error', () => { this.conns.delete(conn.peer); this.onLeave(conn.peer); });
      });
      peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) { /* noop */ } });
    });
  }

  broadcast(msg) { for (const c of this.conns.values()) if (c.open) c.send(msg); }
  sendTo(peerId, msg) { const c = this.conns.get(peerId); if (c && c.open) c.send(msg); }
}

export class ClientNet {
  constructor({ onMessage, onClose }) {
    this.onMessage = onMessage;
    this.onClose = onClose;
  }

  async join(code) {
    const Peer = await waitPeerLib();
    return new Promise((resolve, reject) => {
      const peer = new Peer(OPTS);
      this.peer = peer;
      let done = false;
      const fail = (e) => { if (!done) { done = true; reject(e); } };
      const timer = setTimeout(() => fail(new Error('timeout')), 12000);
      peer.on('open', () => {
        const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
        this.conn = conn;
        conn.on('open', () => { done = true; clearTimeout(timer); resolve(); });
        conn.on('data', (d) => this.onMessage(d));
        conn.on('close', () => this.onClose?.());
        conn.on('error', fail);
      });
      peer.on('error', (e) => { clearTimeout(timer); fail(e); if (done) this.onClose?.(); });
    });
  }

  send(msg) { if (this.conn && this.conn.open) this.conn.send(msg); }
}
