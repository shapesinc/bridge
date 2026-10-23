"use strict";

// Many TCP streams over the one WebSocket this computer holds open to the shapes.inc relay.
// Binary frames: type (1 byte), stream id (4 bytes, big-endian), payload. Only the relay opens
// streams; each direction of each stream has its own credit window, so one slow site can't
// stall the others or grow the socket's buffer without bound.
// A port of the relay's own mux (app repo, workers/device-relay/src/mux.mjs): the frame types,
// ids and window must stay the same on both ends.
const { Duplex } = require("node:stream");

const OPEN = 1; // relay -> device: {"host", "port"} as JSON
const OPENED = 2; // device -> relay: the device's TCP connection is up
const REFUSED = 3; // device -> relay: a reason code, nothing opened
const DATA = 4;
const END = 5; // half-close: no more data this way
const RESET = 6; // abort both ways
const CREDIT = 7; // u32: bytes the receiver consumed, which the sender may send again

const WINDOW = 256 * 1024;
const MAX_FRAME = 64 * 1024;
const EMPTY = Buffer.alloc(0);

function frame(type, id, payload = EMPTY) {
  const bytes = Buffer.allocUnsafe(5 + payload.length);
  bytes[0] = type;
  bytes.writeUInt32BE(id, 1);
  payload.copy(bytes, 5);
  return bytes;
}

class MuxStream extends Duplex {
  constructor(mux, id) {
    super({ allowHalfOpen: true });
    this.mux = mux;
    this.id = id;
    this.window = WINDOW;
    this.unacked = 0;
    this.waiting = undefined;
    this.localEnded = false;
    this.remoteEnded = false;
    this.remoteGone = false;
    this.bytesIn = 0;
    this.bytesOut = 0;
  }

  _write(chunk, _encoding, callback) {
    this.sendData(chunk, callback);
  }

  sendData(chunk, callback) {
    while (chunk.length) {
      if (this.window <= 0) {
        this.waiting = () => this.sendData(chunk, callback);
        return;
      }
      const size = Math.min(this.window, MAX_FRAME, chunk.length);
      this.mux.send(frame(DATA, this.id, chunk.subarray(0, size)));
      this.window -= size;
      this.bytesOut += size;
      chunk = chunk.subarray(size);
    }
    callback();
  }

  credit(bytes) {
    this.window += bytes;
    const waiting = this.waiting;
    if (waiting && this.window > 0) {
      this.waiting = undefined;
      waiting();
    }
  }

  // Credit goes back as the consumer takes data: at once while it keeps up, else when it asks again.
  deliver(chunk) {
    this.bytesIn += chunk.length;
    this.unacked += chunk.length;
    if (this.push(chunk)) this.grant();
  }

  grant() {
    if (this.unacked > 0 && !this.destroyed) {
      const payload = Buffer.allocUnsafe(4);
      payload.writeUInt32BE(this.unacked, 0);
      this.unacked = 0;
      this.mux.send(frame(CREDIT, this.id, payload));
    }
  }

  _read() {
    this.grant();
  }

  _final(callback) {
    this.localEnded = true;
    this.mux.send(frame(END, this.id));
    callback();
  }

  _destroy(error, callback) {
    if (!this.remoteGone && !(this.localEnded && this.remoteEnded)) this.mux.send(frame(RESET, this.id));
    this.mux.streams.delete(this.id);
    callback(error);
  }

  remoteEnd() {
    this.remoteEnded = true;
    this.push(null);
  }

  remoteReset() {
    this.remoteGone = true;
    this.destroy(new Error("reset"));
  }
}

class Mux {
  /**
   * `send` writes one binary frame to the WebSocket. `onOpen(id, host, port)` (device side only)
   * answers an OPEN with `accept(id)` or `refuse(id, reason)`.
   */
  constructor(send, { onOpen } = {}) {
    this.rawSend = send;
    this.onOpen = onOpen;
    this.streams = new Map();
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
  }

  send(bytes) {
    if (!this.closed) this.rawSend(bytes);
  }

  /** Relay side. With `fastOpen`, the stream is usable at once (data queues behind the OPEN). */
  open(host, port, { fastOpen = false, timeoutMs = 15_000 } = {}) {
    if (this.closed) return Promise.reject(new Error("device_offline"));
    const id = this.nextId++;
    const stream = new MuxStream(this, id);
    this.streams.set(id, stream);
    this.send(frame(OPEN, id, Buffer.from(JSON.stringify({ host, port }))));
    if (fastOpen) return Promise.resolve(stream);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        stream.destroy();
        reject(new Error("timeout"));
      }, timeoutMs);
      this.pending.set(id, {
        stream,
        resolve: () => { clearTimeout(timer); resolve(stream); },
        reject: (reason) => { clearTimeout(timer); reject(new Error(reason)); },
      });
    });
  }

  /** Device side: the stream for an OPEN this device takes. */
  accept(id) {
    const stream = new MuxStream(this, id);
    this.streams.set(id, stream);
    return stream;
  }

  opened(id) {
    this.send(frame(OPENED, id));
  }

  refuse(id, reason) {
    this.send(frame(REFUSED, id, Buffer.from(String(reason).slice(0, 40))));
    const stream = this.streams.get(id);
    if (stream) {
      stream.remoteGone = true;
      stream.destroy(new Error(reason));
    }
  }

  receive(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 5) return;
    const type = bytes[0];
    const id = bytes.readUInt32BE(1);
    const payload = bytes.subarray(5);
    if (type === OPEN) {
      // Only the relay opens streams: an OPEN from the device side is ignored.
      if (!this.onOpen || this.streams.has(id)) return;
      let target;
      try { target = JSON.parse(payload.toString("utf8")); } catch { return this.refuse(id, "bad_request"); }
      this.onOpen(id, String(target?.host ?? ""), Number(target?.port));
      return;
    }
    if (type === OPENED || type === REFUSED) {
      const waiter = this.pending.get(id);
      if (!waiter) {
        if (type === REFUSED) this.streams.get(id)?.remoteReset();
        return;
      }
      this.pending.delete(id);
      if (type === OPENED) waiter.resolve();
      else {
        waiter.stream.remoteGone = true;
        waiter.stream.destroy();
        waiter.reject(payload.toString("utf8").replace(/[^a-z_]/g, "") || "refused");
      }
      return;
    }
    const stream = this.streams.get(id);
    if (!stream) return;
    if (type === DATA) stream.deliver(Buffer.from(payload));
    else if (type === END) stream.remoteEnd();
    else if (type === RESET) stream.remoteReset();
    else if (type === CREDIT && payload.length >= 4) stream.credit(payload.readUInt32BE(0));
  }

  /** The WebSocket went away: every stream on it fails now. */
  close() {
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject("device_offline");
    this.pending.clear();
    for (const stream of this.streams.values()) {
      stream.remoteGone = true;
      stream.destroy(new Error("device_offline"));
    }
    this.streams.clear();
  }
}

module.exports = { OPEN, OPENED, REFUSED, DATA, END, RESET, CREDIT, WINDOW, MAX_FRAME, frame, MuxStream, Mux };
