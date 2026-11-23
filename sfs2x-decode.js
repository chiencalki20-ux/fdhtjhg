/**
 * SmartFoxServer 2X 二进制帧 → 普通 JSON
 * 对齐官网 sfs2x-api 的 onPacketRead / SFSDataSerializer
 */

const zlib = require('zlib');

const TYPE = {
  NULL: 0,
  BOOL: 1,
  BYTE: 2,
  SHORT: 3,
  INT: 4,
  LONG: 5,
  FLOAT: 6,
  DOUBLE: 7,
  UTF_STRING: 8,
  BOOL_ARRAY: 9,
  BYTE_ARRAY: 10,
  SHORT_ARRAY: 11,
  INT_ARRAY: 12,
  LONG_ARRAY: 13,
  FLOAT_ARRAY: 14,
  DOUBLE_ARRAY: 15,
  UTF_STRING_ARRAY: 16,
  SFS_ARRAY: 17,
  SFS_OBJECT: 18,
  TEXT: 20
};

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }

  remain() {
    return this.buf.length - this.pos;
  }

  need(n) {
    if (this.remain() < n) throw new Error('SFS truncated: need ' + n);
  }

  u8() {
    this.need(1);
    return this.buf[this.pos++];
  }

  u16() {
    this.need(2);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }

  i16() {
    this.need(2);
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }

  i32() {
    this.need(4);
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  u32() {
    this.need(4);
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  f32() {
    this.need(4);
    const v = this.buf.readFloatBE(this.pos);
    this.pos += 4;
    return v;
  }

  f64() {
    this.need(8);
    const v = this.buf.readDoubleBE(this.pos);
    this.pos += 8;
    return v;
  }

  bytes(n) {
    this.need(n);
    const s = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  back(n) {
    this.pos -= n;
  }
}

function readLong(r) {
  const hi = r.i32();
  const lo = r.u32();
  const n = hi * 4294967296 + lo;
  return Number.isSafeInteger(n) ? n : String(n);
}

function decodeObject(r) {
  const t = r.u8();
  if (t === TYPE.NULL) return null;
  if (t === TYPE.BOOL) {
    const v = r.u8();
    if (v === 0) return false;
    if (v === 1) return true;
    throw new Error('bad bool ' + v);
  }
  if (t === TYPE.BYTE) return r.u8();
  if (t === TYPE.SHORT) return r.i16();
  if (t === TYPE.INT) return r.i32();
  if (t === TYPE.LONG) return readLong(r);
  if (t === TYPE.FLOAT) return r.f32();
  if (t === TYPE.DOUBLE) return r.f64();
  if (t === TYPE.UTF_STRING) {
    const n = r.i16();
    if (n < 0) throw new Error('bad utf size');
    return r.bytes(n).toString('utf8');
  }
  if (t === TYPE.TEXT) {
    const n = r.i32();
    if (n < 0) throw new Error('bad text size');
    return r.bytes(n).toString('utf8');
  }
  if (t === TYPE.BOOL_ARRAY) {
    const n = r.u16();
    const out = [];
    for (let i = 0; i < n; i++) {
      const v = r.u8();
      out.push(v === 1);
    }
    return out;
  }
  if (t === TYPE.BYTE_ARRAY) {
    const n = r.i32();
    if (n < 0) throw new Error('bad byte[]');
    return Array.from(r.bytes(n));
  }
  if (t === TYPE.SHORT_ARRAY) {
    const n = r.u16();
    const out = [];
    for (let i = 0; i < n; i++) out.push(r.i16());
    return out;
  }
  if (t === TYPE.INT_ARRAY) {
    const n = r.u16();
    const out = [];
    for (let i = 0; i < n; i++) out.push(r.i32());
    return out;
  }
  if (t === TYPE.LONG_ARRAY) {
    const n = r.u16();
    const out = [];
    for (let i = 0; i < n; i++) out.push(readLong(r));
    return out;
  }
  if (t === TYPE.FLOAT_ARRAY) {
    const n = r.u16();
    const out = [];
    for (let i = 0; i < n; i++) out.push(r.f32());
    return out;
  }
  if (t === TYPE.DOUBLE_ARRAY) {
    const n = r.u16();
    const out = [];
    for (let i = 0; i < n; i++) out.push(r.f64());
    return out;
  }
  if (t === TYPE.UTF_STRING_ARRAY) {
    const n = r.u16();
    const out = [];
    for (let i = 0; i < n; i++) {
      const len = r.i16();
      if (len < 0) throw new Error('bad utf[]');
      out.push(r.bytes(len).toString('utf8'));
    }
    return out;
  }
  if (t === TYPE.SFS_ARRAY) {
    r.back(1);
    return decodeSfsArray(r);
  }
  if (t === TYPE.SFS_OBJECT) {
    r.back(1);
    return decodeSfsObject(r);
  }
  throw new Error('unknown SFS type ' + t);
}

function decodeSfsObject(r) {
  const t = r.u8();
  if (t !== TYPE.SFS_OBJECT) throw new Error('expected SFS_OBJECT, got ' + t);
  const count = r.u16();
  const obj = {};
  for (let i = 0; i < count; i++) {
    const kn = r.u16();
    if (kn < 0 || kn > 255) throw new Error('bad key len ' + kn);
    const key = r.bytes(kn).toString('latin1');
    obj[key] = decodeObject(r);
  }
  return obj;
}

function decodeSfsArray(r) {
  const t = r.u8();
  if (t !== TYPE.SFS_ARRAY) throw new Error('expected SFS_ARRAY, got ' + t);
  const count = r.i16();
  if (count < 0) throw new Error('bad array size');
  const arr = [];
  for (let i = 0; i < count; i++) arr.push(decodeObject(r));
  return arr;
}

function inflatePayload(buf) {
  try {
    return zlib.inflateSync(buf);
  } catch (e) {
    return zlib.inflateRawSync(buf);
  }
}

function decodeOnePacket(buf, offset) {
  if (offset >= buf.length) return null;
  const view = buf.subarray(offset);
  if (view.length < 3) return null;
  const header = view[0];
  const compressed = (header & 32) !== 0;
  const encrypted = (header & 64) !== 0;
  const big = (header & 8) !== 0;
  let pos = 1;
  let size;
  if (big) {
    if (view.length < 5) return null;
    size = view.readUInt32BE(1);
    pos = 5;
  } else {
    size = view.readUInt16BE(1);
    pos = 3;
  }
  if (view.length < pos + size) return null;
  let payload = view.subarray(pos, pos + size);
  const next = offset + pos + size;
  if (encrypted) {
    return { next, msg: null, encrypted: true };
  }
  if (compressed) payload = inflatePayload(payload);
  const obj = decodeSfsObject(new Reader(payload));
  return { next, msg: obj };
}

function decodeSfsPackets(buf) {
  if (!buf || !buf.length) return [];
  const out = [];
  let offset = 0;
  while (offset < buf.length) {
    const one = decodeOnePacket(buf, offset);
    if (!one) break;
    if (one.msg) out.push(one.msg);
    if (one.next <= offset) break;
    offset = one.next;
  }
  return out;
}

function vaMessageName(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const p = msg.p;
  if (p && typeof p === 'object') {
    if (typeof p.c === 'string' && p.c.trim()) return p.c.trim();
    if (typeof p.cmd === 'string' && p.cmd.trim()) return p.cmd.trim();
  }
  if (msg.c != null && msg.a != null) return 'va_c' + msg.c + '_a' + msg.a;
  return null;
}

module.exports = {
  decodeSfsPackets,
  decodeSfsObject,
  vaMessageName,
  TYPE
};
