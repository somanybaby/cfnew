import { sha224 } from '@noble/hashes/sha2.js';
import { Fault, concat, encoder, decoder, same, host, ipBytes, isIP } from './common.mjs';

export const trojanDigest = password => encoder.encode(Array.from(sha224(encoder.encode(password)), n => n.toString(16).padStart(2, '0')).join(''));
export const uuidBytes = uuid => Uint8Array.from(uuid.replaceAll('-', '').match(/../g), byte => parseInt(byte, 16));
function target(bytes, at, type, domainType, ipv6Type) {
  if (type === 1) { if (bytes.length < at + 4) return null; return { host: [...bytes.subarray(at, at + 4)].join('.'), end: at + 4 }; }
  if (type === domainType) {
    if (bytes.length < at + 1) return null; const length = bytes[at++];
    if (!length) throw new Fault('empty_destination'); if (bytes.length < at + length) return null;
    return { host: host(decoder.decode(bytes.subarray(at, at + length))), end: at + length };
  }
  if (type === ipv6Type) {
    if (bytes.length < at + 16) return null; const words = [];
    for (let i = 0; i < 16; i += 2) words.push(((bytes[at + i] << 8) | bytes[at + i + 1]).toString(16));
    return { host: host(words.join(':')), end: at + 16 };
  }
  throw new Fault('unsupported_address_type');
}
export class Handshake {
  constructor(uuid, config, xhttp = false) {
    this.identity = uuidBytes(uuid); this.password = trojanDigest(config.tp || uuid); this.config = config;
    this.xhttp = xhttp; this.buffer = new Uint8Array(); this.done = false;
  }
  feed(bytes) {
    if (this.done) throw new Fault('handshake_already_complete');
    // The caller passes chunks; at most the small protocol prefix is copied here.
    const prefixRoom = 1024 - this.buffer.length;
    const prefix = concat(this.buffer, bytes.subarray(0, Math.max(0, prefixRoom)));
    const result = this.parse(prefix);
    if (!result) {
      if (prefix.length >= 1024 || bytes.length > prefixRoom) throw new Fault('header_too_large');
      this.buffer = prefix; return null;
    }
    this.done = true;
    result.payload = concat(prefix.subarray(result.end), bytes.subarray(Math.max(0, prefixRoom)));
    this.buffer = new Uint8Array(); return result;
  }
  parse(b) {
    if (!b.length) return null;
    if (b[0] === 0) {
      if (this.xhttp ? this.config.ex !== 'yes' : this.config.ev !== 'yes') throw new Fault('protocol_disabled');
      if (b.length < 18) return null;
      if (!same(b.subarray(1, 17), this.identity)) throw new Fault('authentication_failed', 403);
      const at = 18 + b[17]; if (b.length < at + 4) return null;
      const command = b[at], p = (b[at + 1] << 8) | b[at + 2];
      if ((command !== 1 && command !== 2) || !p) throw new Fault('unsupported_command');
      if (command === 2 && p !== 53) throw new Fault('dns_udp_only');
      const destination = target(b, at + 4, b[at + 3], 2, 3); if (!destination) return null;
      return { ...destination, port: p, udp: command === 2, reply: new Uint8Array([0, 0]), protocol: 'vless' };
    }
    if (this.xhttp || this.config.et !== 'yes') throw new Fault('protocol_disabled');
    if (b.length < 58) return null;
    if (!same(b.subarray(0, 56), this.password) || b[56] !== 13 || b[57] !== 10) throw new Fault('authentication_failed', 403);
    if (b.length < 60) return null; if (b[58] !== 1) throw new Fault('unsupported_command');
    const destination = target(b, 60, b[59], 3, 4); if (!destination || b.length < destination.end + 4) return null;
    const p = (b[destination.end] << 8) | b[destination.end + 1];
    if (!p || b[destination.end + 2] !== 13 || b[destination.end + 3] !== 10) throw new Fault('invalid_trojan_header');
    return { ...destination, end: destination.end + 4, port: p, udp: false, reply: new Uint8Array(), protocol: 'trojan' };
  }
}
export function socksAddress(name, p) {
  const family = isIP(name); const data = family ? ipBytes(name) : encoder.encode(name);
  if (data.length > 255) throw new Fault('destination_too_long');
  return concat(new Uint8Array(family === 4 ? [1] : family === 6 ? [4] : [3, data.length]), data, new Uint8Array([p >> 8, p & 255]));
}
