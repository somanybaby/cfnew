/*! Bundled dependency: @noble/hashes 2.4.0
The MIT License (MIT)

Copyright (c) 2022 Paul Miller (https://paulmillr.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/
// rewrite-js/src/worker.mjs
import { connect } from "cloudflare:sockets";

// rewrite-js/src/common.mjs
var Fault = class extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
};
var encoder = new TextEncoder();
var decoder = new TextDecoder("utf-8", { fatal: true });
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
function same(a, b) {
  if (a.length !== b.length) return false;
  if (typeof crypto.subtle.timingSafeEqual === "function") return crypto.subtle.timingSafeEqual(a, b);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
function b64(bytes, url = false) {
  let text = "";
  for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192));
  const value = btoa(text);
  return url ? value.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") : value;
}
function unb64(text, limit = 8192) {
  if (text.length > limit * 2 || !/^[\w+/=-]*$/.test(text)) throw new Fault("invalid_base64");
  try {
    const decoded = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
    if (decoded.length > limit) throw new Error();
    return Uint8Array.from(decoded, (c) => c.charCodeAt(0));
  } catch {
    throw new Fault("invalid_base64");
  }
}
function port(value, fallback = 443) {
  if (value === void 0 || value === null || value === "") return fallback;
  if (!/^\d{1,5}$/.test(String(value)) || +value < 1 || +value > 65535) throw new Fault("invalid_port");
  return +value;
}
function host(value) {
  let name = String(value).trim();
  if (name.startsWith("[") && name.endsWith("]")) name = name.slice(1, -1);
  if (!name || /[\s/@?#%\\]/.test(name)) throw new Fault("invalid_host");
  try {
    const url = new URL("http://" + (name.includes(":") ? "[" + name + "]" : name));
    if (url.port || url.pathname !== "/") throw new Error();
    name = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    throw new Fault("invalid_host");
  }
  if (name.length > 253) throw new Fault("invalid_host");
  return name;
}
var authority = (name, p) => (name.includes(":") ? "[" + name + "]" : name) + ":" + p;
function address(value, defaultPort = 443) {
  const text = String(value).trim();
  let name = text, p;
  if (text.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
    if (!match) throw new Fault("invalid_address");
    [, name, p] = match;
  } else if ((text.match(/:/g) || []).length === 1) {
    const at = text.lastIndexOf(":");
    name = text.slice(0, at);
    p = text.slice(at + 1);
    if (!p) throw new Fault("invalid_port");
  }
  return { host: host(name), port: port(p, defaultPort) };
}
var isIP = (value) => value.includes(":") ? 6 : /^\d+\.\d+\.\d+\.\d+$/.test(value) ? 4 : 0;
function ipBytes(name) {
  if (isIP(name) === 4) return Uint8Array.from(name.split(".").map(Number));
  const pieces = name.split("::");
  const left = pieces[0].split(":").filter(Boolean);
  const right = (pieces[1] || "").split(":").filter(Boolean);
  const words = pieces.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  if (words.length !== 8) throw new Fault("invalid_ipv6");
  return Uint8Array.from(words.flatMap((word) => [parseInt(word, 16) >> 8, parseInt(word, 16) & 255]));
}
async function boundedBody(body, limit = 1048576) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  let size = 0;
  const chunks = [];
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Fault("body_too_large", 413);
      chunks.push(value);
    }
    return concat(...chunks);
  } catch (error) {
    await reader.cancel().catch(() => {
    });
    throw error;
  } finally {
    reader.releaseLock();
  }
}
async function jsonBody(request) {
  try {
    return JSON.parse(decoder.decode(await boundedBody(request.body)));
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault("invalid_json");
  }
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
}
async function deadline(promise, ms = 1e4, code = "connection_timeout") {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Fault(code, 504)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
var Budget = class {
  constructor(enabled) {
    this.enabled = enabled;
    this.bytes = 0;
    this.chunks = 0;
  }
  add(length) {
    this.bytes += length;
    this.chunks++;
    if (this.enabled && (this.bytes > 393216 || this.chunks > 96)) throw new Fault("transfer_budget_exceeded", 429);
  }
};

// rewrite-js/src/settings.mjs
var IMPLEMENTATION = "javascript-rewrite-1.0.0";
var CORE_VERSION = "2026.11.02.1";
var DEFAULTS = Object.freeze({
  freeCpu: "no",
  wk: "",
  ev: "yes",
  et: "no",
  ex: "no",
  ech: "no",
  tp: "",
  customDNS: "https://223.5.5.5/dns-query",
  customECHDomain: "cloudflare-ech.com",
  alpn: "",
  d: "",
  p: "",
  yx: "",
  yxURL: "",
  s: "",
  homepage: "",
  scu: "",
  ena: "no",
  epd: "yes",
  epi: "yes",
  egi: "yes",
  ae: "",
  rm: "",
  qj: "",
  dkby: "no",
  yxby: "",
  ipv4: "yes",
  ipv6: "yes",
  ispMobile: "yes",
  ispUnicom: "yes",
  ispTelecom: "yes",
  jk: "no"
});
var BOOL = new Set("freeCpu ev et ex ech ena epd epi egi ipv4 ipv6 ispMobile ispUnicom ispTelecom jk".split(" "));
var SPECIAL = { freeCpu: "FREE_CPU", customDNS: "CUSTOM_DNS", customECHDomain: "CUSTOM_ECH_DOMAIN", yxURL: "YX_URL", ispMobile: "ISP_MOBILE", ispUnicom: "ISP_UNICOM", ispTelecom: "ISP_TELECOM" };
function flag(value, fallback = false) {
  const text = String(value).toLowerCase().trim();
  return ["yes", "true", "1", "on"].includes(text) ? true : ["no", "false", "0", "off"].includes(text) ? false : fallback;
}
function normalize(env = {}, saved = {}) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const alias = [key, key.toUpperCase(), SPECIAL[key]].find((k) => k && env[k] !== void 0 && env[k] !== "");
    out[key] = String(saved[key] ?? (alias ? env[alias] : DEFAULTS[key]));
    if (BOOL.has(key)) out[key] = flag(out[key], flag(DEFAULTS[key])) ? "yes" : "no";
  }
  if (out.ev !== "yes" && out.et !== "yes" && out.ex !== "yes") out.ev = "yes";
  if (out.ech === "yes") out.dkby = "yes";
  if (!["", "h3", "h2", "http/1.1", "h3,h2", "h2,http/1.1", "h3,h2,http/1.1"].includes(out.alpn)) out.alpn = "";
  return Object.freeze(out);
}
function patch(saved, update) {
  if (!update || typeof update !== "object" || Array.isArray(update)) throw new Fault("object_required");
  const values = { ...update }, next = { ...saved };
  if (Object.hasOwn(values, "customIP")) {
    if (!Object.hasOwn(values, "p")) values.p = values.customIP;
    delete values.customIP;
  }
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(DEFAULTS, key) || value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new Fault("unknown_or_invalid_setting");
    if (value === null || value === "") {
      delete next[key];
      continue;
    }
    if (String(value).length > (key === "yx" ? 262144 : 16384)) throw new Fault("setting_too_large");
    if (key === "qj" && !["no", "only"].includes(String(value))) throw new Fault("invalid_outbound_mode");
    if (key === "p") address(value);
    if (key === "s") proxySpec(String(value));
    if (key === "customDNS") {
      let u;
      try {
        u = new URL(String(value));
      } catch {
        throw new Fault("invalid_dns_url");
      }
      if (u.protocol !== "https:" || u.username || u.password) throw new Fault("invalid_dns_url");
    }
    next[key] = value;
  }
  return next;
}
function proxySpec(text) {
  if (!text) return null;
  let u;
  try {
    u = new URL(text.includes("://") ? text : "socks5://" + text);
  } catch {
    throw new Fault("invalid_proxy");
  }
  const type = u.protocol.slice(0, -1).replace(/^socks$/, "socks5");
  if (!["socks5", "http", "https"].includes(type) || u.search || u.hash || u.pathname && u.pathname !== "/") throw new Fault("invalid_proxy");
  if (type === "socks5" && !u.port) throw new Fault("proxy_port_required");
  try {
    return Object.freeze({ type, host: host(u.hostname), port: port(u.port, type === "https" ? 443 : 80), username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
  } catch {
    throw new Fault("invalid_proxy");
  }
}
async function load(env) {
  const uuid = String(env.u || env.U || "").trim().toLowerCase();
  if (!UUID.test(uuid)) throw new Fault("identity_not_configured", 503);
  const kv = env.C || env.c;
  let saved = {};
  if (kv) {
    const raw = await kv.get("c");
    if (raw) {
      try {
        saved = JSON.parse(raw);
      } catch {
        throw new Fault("invalid_saved_settings", 503);
      }
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Fault("invalid_saved_settings", 503);
    }
  }
  return { uuid, kv, saved, config: normalize(env, saved), env };
}
async function save(state, saved) {
  if (!state.kv) throw new Fault("kv_required", 503);
  await state.kv.put("c", JSON.stringify(saved));
  await state.kv.put("c_ver", crypto.randomUUID());
}
function preferred(text) {
  const result = [], seen = /* @__PURE__ */ new Set();
  for (const line of text.split(/[\r\n,]+/)) {
    if (!line.trim()) continue;
    try {
      const mark = line.indexOf("#");
      const target2 = address(mark < 0 ? line : line.slice(0, mark));
      const key = authority(target2.host, target2.port);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ ip: target2.host, port: target2.port, name: mark < 0 ? "" : line.slice(mark + 1).trim().slice(0, 120) });
    } catch {
    }
  }
  return result;
}
var formatPreferred = (rows) => rows.map((r) => authority(r.ip, r.port) + (r.name ? "#" + r.name : "")).join("\n");
async function preferredAPI(request, state) {
  if (!state.kv) throw new Fault("kv_required", 503);
  if (state.saved.ae !== "yes") throw new Fault("preferred_api_disabled", 403);
  const rows = preferred(state.config.yx);
  if (request.method === "GET") return json({ success: true, data: rows });
  if (!["POST", "DELETE"].includes(request.method)) throw new Fault("method_not_allowed", 405);
  const body = await jsonBody(request);
  let next = rows, count = 0, skipped = 0;
  if (request.method === "DELETE") {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Fault("object_required");
    if (body.all === true) next = [];
    else {
      const name = host(body.ip ?? "");
      const p = port(body.port);
      next = rows.filter((r) => r.ip !== name || r.port !== p);
    }
    count = rows.length - next.length;
  } else {
    const entries = Array.isArray(body) ? body : [body];
    if (entries.length > 2048) throw new Fault("too_many_addresses");
    next = [...rows];
    const seen = new Set(rows.map((r) => authority(r.ip, r.port)));
    for (const row of entries) {
      try {
        if (!row || typeof row !== "object") throw new Fault("invalid_address");
        const name = host(row.ip ?? ""), p = port(row.port), key = authority(name, p);
        if (seen.has(key)) {
          skipped++;
          continue;
        }
        const remark = String(row.name || "").replace(/[\r\n,#]/g, " ").slice(0, 120);
        next.push({ ip: name, port: p, name: remark });
        seen.add(key);
        count++;
      } catch {
        skipped++;
      }
    }
  }
  if (count) await save(state, patch(state.saved, { yx: formatPreferred(next) || null }));
  return json({ success: request.method === "DELETE" || count > 0, added: request.method === "POST" ? count : void 0, skipped, deletedCount: request.method === "DELETE" ? count : void 0, data: next });
}

// node_modules/@noble/hashes/_u64.js
var fromNumH = (n) => n / 2 ** 32 | 0;
var fromNumL = (n) => n >>> 0;
function setU64FromNum(view, byteOffset, n, isLE) {
  const h = fromNumH(n);
  const l = fromNumL(n);
  view.setUint32(byteOffset, isLE ? l : h, isLE);
  view.setUint32(byteOffset + 4, isLE ? h : l, isLE);
}

// node_modules/@noble/hashes/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle = (title) => title ? `"${title}" ` : "";
function anumber(n, title = "") {
  if (typeof n !== "number")
    throw new TypeError(atitle(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes(value, length, title = "") {
  if (isBytes(value) && (length === void 0 || value.length === length))
    return value;
  if (length !== void 0)
    anumber(length, "length");
  const bytes = isBytes(value);
  const ofLen = length !== void 0 ? ` of length ${length}` : "";
  const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
  const message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes)
    throw new TypeError(message);
  throw new RangeError(message);
}
var aobject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError((label === "object" ? "" : `"${label}" `) + "expected object, got type=" + typeof value);
};
var aopts = (value, label) => {
  aobject(value, label);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(`"${label}" expected plain object`);
  if (Object.hasOwn(value, "__proto__"))
    throw new TypeError(`"${label}.__proto__" is not allowed`);
};
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput(out, instance) {
  abytes(out, void 0, "output");
  const min = instance.outputLen;
  if (!(out.length >= min)) {
    throw new RangeError('"output" expected length >= ' + min);
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
function checkOpts(defaults, opts, title = "opts") {
  aopts(defaults, "defaults");
  if (opts !== void 0)
    aopts(opts, title);
  const merged = Object.assign(/* @__PURE__ */ Object.create(null), defaults, opts);
  return merged;
}
function createHasher(hashCons, info = {}) {
  if (typeof hashCons !== "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
  info = checkOpts({}, info, "info");
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(void 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
var oidNist = (suffix) => ({
  // Current NIST hashAlgs suffixes used here fit in one DER subidentifier octet.
  // Larger suffix values would need base-128 OID encoding and a different length byte.
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// node_modules/@noble/hashes/_md.js
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class {
  blockLen;
  outputLen;
  canXOF = false;
  padOffset;
  isLE;
  // For partial updates less than block size
  buffer;
  view;
  finished = false;
  length = 0;
  pos = 0;
  destroyed = false;
  constructor(blockLen, outputLen, padOffset, isLE) {
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    let processed = false;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        processed = true;
        continue;
      }
      buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
        processed = true;
      }
    }
    this.length += data.length;
    if (processed)
      this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    buffer.fill(0, pos);
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      buffer.fill(0);
    }
    setU64FromNum(view, blockLen - 8, this.length * 8, isLE);
    this.process(view, 0);
    this.roundClean();
    const oview = out === buffer ? view : createView(out);
    const len = this.outputLen;
    const outLen = len / 4;
    const state = this.get();
    if (len % 4 || outLen > state.length)
      throw new Error("invalid outputLen");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneIntoMeta(to) {
    const { buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (pos)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);
var SHA224_IV = /* @__PURE__ */ Uint32Array.from([
  3238371032,
  914150663,
  812702999,
  4144912697,
  4290775857,
  1750603025,
  1694076839,
  3204075428
]);

// node_modules/@noble/hashes/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA2_32B = class extends HashMD {
  // We cannot use array here since array allows indexing by variable
  // which means optimizer/compiler cannot use registers.
  // Numeric initializers matter: starting the fields as `undefined` changes
  // V8's field representation and makes sha256 3x slower (measured).
  A = 0;
  B = 0;
  C = 0;
  D = 0;
  E = 0;
  F = 0;
  G = 0;
  H = 0;
  constructor(outputLen, IV) {
    super(64, outputLen, 8, false);
    this.A = IV[0] | 0;
    this.B = IV[1] | 0;
    this.C = IV[2] | 0;
    this.D = IV[3] | 0;
    this.E = IV[4] | 0;
    this.F = IV[5] | 0;
    this.G = IV[6] | 0;
    this.H = IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  _cloneInto(to) {
    (to ||= new this.constructor()).set(...this.get());
    return this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.destroyed = true;
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
var _SHA256 = class extends SHA2_32B {
  constructor() {
    super(32, SHA256_IV);
  }
};
var _SHA224 = class extends SHA2_32B {
  constructor() {
    super(28, SHA224_IV);
  }
};
var sha256 = /* @__PURE__ */ createHasher(
  () => new _SHA256(),
  /* @__PURE__ */ oidNist(1)
);
var sha224 = /* @__PURE__ */ createHasher(
  () => new _SHA224(),
  /* @__PURE__ */ oidNist(4)
);

// rewrite-js/src/protocol.mjs
var trojanDigest = (password) => encoder.encode(Array.from(sha224(encoder.encode(password)), (n) => n.toString(16).padStart(2, "0")).join(""));
var uuidBytes = (uuid) => Uint8Array.from(uuid.replaceAll("-", "").match(/../g), (byte) => parseInt(byte, 16));
function target(bytes, at, type, domainType, ipv6Type) {
  if (type === 1) {
    if (bytes.length < at + 4) return null;
    return { host: [...bytes.subarray(at, at + 4)].join("."), end: at + 4 };
  }
  if (type === domainType) {
    if (bytes.length < at + 1) return null;
    const length = bytes[at++];
    if (!length) throw new Fault("empty_destination");
    if (bytes.length < at + length) return null;
    return { host: host(decoder.decode(bytes.subarray(at, at + length))), end: at + length };
  }
  if (type === ipv6Type) {
    if (bytes.length < at + 16) return null;
    const words = [];
    for (let i = 0; i < 16; i += 2) words.push((bytes[at + i] << 8 | bytes[at + i + 1]).toString(16));
    return { host: host(words.join(":")), end: at + 16 };
  }
  throw new Fault("unsupported_address_type");
}
var Handshake = class {
  constructor(uuid, config, xhttp2 = false) {
    this.identity = uuidBytes(uuid);
    this.password = trojanDigest(config.tp || uuid);
    this.config = config;
    this.xhttp = xhttp2;
    this.buffer = new Uint8Array();
    this.done = false;
  }
  feed(bytes) {
    if (this.done) throw new Fault("handshake_already_complete");
    const prefixRoom = 1024 - this.buffer.length;
    const prefix = concat(this.buffer, bytes.subarray(0, Math.max(0, prefixRoom)));
    const result = this.parse(prefix);
    if (!result) {
      if (prefix.length >= 1024 || bytes.length > prefixRoom) throw new Fault("header_too_large");
      this.buffer = prefix;
      return null;
    }
    this.done = true;
    result.payload = concat(prefix.subarray(result.end), bytes.subarray(Math.max(0, prefixRoom)));
    this.buffer = new Uint8Array();
    return result;
  }
  parse(b) {
    if (!b.length) return null;
    if (b[0] === 0) {
      if (this.xhttp ? this.config.ex !== "yes" : this.config.ev !== "yes") throw new Fault("protocol_disabled");
      if (b.length < 18) return null;
      if (!same(b.subarray(1, 17), this.identity)) throw new Fault("authentication_failed", 403);
      const at = 18 + b[17];
      if (b.length < at + 4) return null;
      const command = b[at], p2 = b[at + 1] << 8 | b[at + 2];
      if (command !== 1 && command !== 2 || !p2) throw new Fault("unsupported_command");
      if (command === 2 && p2 !== 53) throw new Fault("dns_udp_only");
      const destination2 = target(b, at + 4, b[at + 3], 2, 3);
      if (!destination2) return null;
      return { ...destination2, port: p2, udp: command === 2, reply: new Uint8Array([0, 0]), protocol: "vless" };
    }
    if (this.xhttp || this.config.et !== "yes") throw new Fault("protocol_disabled");
    if (b.length < 58) return null;
    if (!same(b.subarray(0, 56), this.password) || b[56] !== 13 || b[57] !== 10) throw new Fault("authentication_failed", 403);
    if (b.length < 60) return null;
    if (b[58] !== 1) throw new Fault("unsupported_command");
    const destination = target(b, 60, b[59], 3, 4);
    if (!destination || b.length < destination.end + 4) return null;
    const p = b[destination.end] << 8 | b[destination.end + 1];
    if (!p || b[destination.end + 2] !== 13 || b[destination.end + 3] !== 10) throw new Fault("invalid_trojan_header");
    return { ...destination, end: destination.end + 4, port: p, udp: false, reply: new Uint8Array(), protocol: "trojan" };
  }
};
function socksAddress(name, p) {
  const family = isIP(name);
  const data = family ? ipBytes(name) : encoder.encode(name);
  if (data.length > 255) throw new Fault("destination_too_long");
  return concat(new Uint8Array(family === 4 ? [1] : family === 6 ? [4] : [3, data.length]), data, new Uint8Array([p >> 8, p & 255]));
}

// rewrite-js/src/outbound.mjs
var BufferedReader = class {
  constructor(reader) {
    this.reader = reader;
    this.buffer = new Uint8Array();
  }
  async exact(n) {
    while (this.buffer.length < n) {
      const part = await deadline(this.reader.read());
      if (part.done) throw new Fault("proxy_closed", 502);
      this.buffer = concat(this.buffer, part.value);
      if (this.buffer.length > 1048576) throw new Fault("proxy_reply_too_large", 502);
    }
    const out = this.buffer.slice(0, n);
    this.buffer = this.buffer.slice(n);
    return out;
  }
  async headers() {
    for (; ; ) {
      for (let i = 0; i + 3 < this.buffer.length; i++) {
        if (this.buffer[i] === 13 && this.buffer[i + 1] === 10 && this.buffer[i + 2] === 13 && this.buffer[i + 3] === 10) {
          if (i > 16380) throw new Fault("proxy_reply_too_large", 502);
          const out = this.buffer.slice(0, i + 4);
          this.buffer = this.buffer.slice(i + 4);
          return decoder.decode(out);
        }
      }
      if (this.buffer.length > 16384) throw new Fault("proxy_reply_too_large", 502);
      const part = await deadline(this.reader.read());
      if (part.done) throw new Fault("proxy_closed", 502);
      this.buffer = concat(this.buffer, part.value);
    }
  }
  async read() {
    if (this.buffer.length) {
      const value = this.buffer;
      this.buffer = new Uint8Array();
      return { done: false, value };
    }
    return this.reader.read();
  }
};
async function throughProxy(channel, proxy, target2) {
  const { reader, writer } = channel;
  if (proxy.type === "socks5") {
    const credentials = proxy.username !== "" || proxy.password !== "";
    await writer.write(new Uint8Array(credentials ? [5, 1, 2] : [5, 1, 0]));
    const selection = await reader.exact(2);
    if (selection[0] !== 5 || selection[1] !== (credentials ? 2 : 0)) throw new Fault("proxy_auth_method_rejected", 502);
    if (credentials) {
      const username = encoder.encode(proxy.username), password = encoder.encode(proxy.password);
      if (username.length > 255 || password.length > 255) throw new Fault("proxy_credentials_too_long");
      await writer.write(concat(new Uint8Array([1, username.length]), username, new Uint8Array([password.length]), password));
      const result2 = await reader.exact(2);
      if (result2[0] !== 1 || result2[1] !== 0) throw new Fault("proxy_authentication_failed", 502);
    }
    await writer.write(concat(new Uint8Array([5, 1, 0]), socksAddress(target2.host, target2.port)));
    const result = await reader.exact(4);
    if (result[0] !== 5 || result[1] !== 0 || result[2] !== 0) throw new Fault("proxy_connect_rejected", 502);
    const length = result[3] === 1 ? 4 : result[3] === 4 ? 16 : result[3] === 3 ? (await reader.exact(1))[0] : -1;
    if (length < 0) throw new Fault("invalid_proxy_response", 502);
    await reader.exact(length + 2);
  } else {
    const destination = authority(target2.host, target2.port);
    const auth = proxy.username || proxy.password ? "Proxy-Authorization: Basic " + b64(encoder.encode(proxy.username + ":" + proxy.password)) + "\r\n" : "";
    await writer.write(encoder.encode("CONNECT " + destination + " HTTP/1.1\r\nHost: " + destination + "\r\n" + auth + "\r\n"));
    const response = await reader.headers();
    if (!/^HTTP\/1\.[01] 200(?: |\r)/.test(response)) throw new Fault("proxy_connect_rejected", 502);
  }
}
async function open(connect2, target2, proxy) {
  const peer = proxy || target2;
  const socket = connect2({ hostname: peer.host, port: peer.port }, { secureTransport: proxy?.type === "https" ? "on" : "off", allowHalfOpen: true });
  socket.closed.catch(() => {
  });
  let channel;
  try {
    await deadline(socket.opened);
    channel = {
      reader: new BufferedReader(socket.readable.getReader()),
      writer: socket.writable.getWriter(),
      closed: false,
      close() {
        if (this.closed) return;
        this.closed = true;
        Promise.resolve(socket.close()).catch(() => {
        });
      }
    };
    if (proxy) await deadline(throughProxy(channel, proxy, target2));
    return channel;
  } catch (error) {
    if (channel) channel.close();
    else Promise.resolve(socket.close()).catch(() => {
    });
    throw error;
  }
}
function routes(config, target2) {
  const proxy = proxySpec(config.s);
  const fallback = config.p ? address(config.p, target2.port) : null;
  if (config.qj === "only") {
    if (!proxy) throw new Fault("proxy_required_for_only_mode", 503);
    return [{ target: target2, proxy }];
  }
  const result = [];
  if (config.qj === "no") {
    result.push({ target: target2 });
    if (proxy) result.push({ target: target2, proxy });
    if (fallback) result.push({ target: fallback });
  } else {
    result.push({ target: target2, proxy });
    if (fallback) result.push({ target: fallback, proxy });
  }
  return result;
}
async function dial(connect2, config, target2) {
  for (const candidate of routes(config, target2)) {
    try {
      return await open(connect2, candidate.target, candidate.proxy);
    } catch {
    }
  }
  throw new Fault("outbound_unavailable", 502);
}

// rewrite-js/src/streams.mjs
var InputQueue = class {
  constructor(maxBytes = 1048576, maxFrames = 256) {
    this.maxBytes = maxBytes;
    this.maxFrames = maxFrames;
    this.items = [];
    this.bytes = 0;
    this.waiter = null;
    this.stopped = false;
  }
  push(bytes) {
    if (this.stopped) return;
    if (bytes.length + this.bytes > this.maxBytes || this.items.length >= this.maxFrames) throw new Fault("incoming_queue_full", 429);
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value: bytes, done: false });
    } else {
      this.items.push(bytes);
      this.bytes += bytes.length;
    }
  }
  read() {
    if (this.items.length) {
      const value = this.items.shift();
      this.bytes -= value.length;
      return Promise.resolve({ value, done: false });
    }
    if (this.stopped) return Promise.resolve({ done: true });
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
  stop() {
    this.stopped = true;
    this.items = [];
    this.bytes = 0;
    if (this.waiter) {
      this.waiter({ done: true });
      this.waiter = null;
    }
  }
};
var DNSFrames = class {
  constructor(config, fetcher) {
    this.config = config;
    this.fetcher = fetcher;
    this.pending = new Uint8Array();
  }
  async feed(bytes, send) {
    if (this.config.qj === "only") throw new Fault("dns_over_proxy_only_not_supported", 409);
    if (this.pending.length + bytes.length > 131074) throw new Fault("dns_buffer_too_large");
    this.pending = concat(this.pending, bytes);
    while (this.pending.length >= 2) {
      const length = this.pending[0] << 8 | this.pending[1];
      if (length < 12) throw new Fault("invalid_dns_message");
      if (this.pending.length < length + 2) break;
      const query = this.pending.slice(2, length + 2);
      this.pending = this.pending.slice(length + 2);
      const url = new URL(this.config.customDNS);
      if (url.protocol !== "https:") throw new Fault("invalid_dns_url");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1e4);
      try {
        const reply = await this.fetcher(url.href, { method: "POST", body: query, headers: { "content-type": "application/dns-message", accept: "application/dns-message" }, signal: controller.signal, redirect: "error" });
        if (!reply.ok || !reply.headers.get("content-type")?.toLowerCase().startsWith("application/dns-message")) throw new Fault("dns_upstream_failed", 502);
        const data = await boundedBody(reply.body, 65535);
        if (data.length < 12) throw new Fault("invalid_dns_reply", 502);
        await send(concat(new Uint8Array([data.length >> 8, data.length & 255]), data));
      } finally {
        clearTimeout(timer);
      }
    }
  }
  finish() {
    if (this.pending.length) throw new Fault("truncated_dns_message");
  }
};
async function handshake(source, parser, budget) {
  const expires = Date.now() + 1e4;
  for (; ; ) {
    const part = await deadline(source.read(), Math.max(1, expires - Date.now()), "handshake_timeout");
    if (part.done) throw new Fault("incomplete_handshake");
    budget.add(part.value.length);
    const result = parser.feed(part.value);
    if (result) return result;
  }
}
function perConnection(config, url) {
  const out = { ...config };
  for (const key of ["p", "wk", "rm", "s"]) {
    const value = url.searchParams.get(key);
    if (!value || value.length > 16384) continue;
    try {
      if (key === "s") proxySpec(value);
      if (key === "p") address(value);
      out[key] = value;
    } catch {
    }
  }
  return out;
}
function websocket(request, state, ctx, connect2, fetcher = fetch) {
  const [client, server] = Object.values(new WebSocketPair());
  server.binaryType = "arraybuffer";
  server.accept();
  const queue = new InputQueue();
  const budget = new Budget(state.config.freeCpu === "yes");
  let channel, finished = false;
  const finish = (code = 1e3) => {
    if (finished) return;
    finished = true;
    queue.stop();
    channel?.close();
    try {
      server.close(code, code === 1e3 ? "" : "connection ended");
    } catch {
    }
  };
  server.addEventListener("message", (event) => {
    if (finished) return;
    try {
      if (event.data instanceof ArrayBuffer) queue.push(new Uint8Array(event.data));
      else if (ArrayBuffer.isView(event.data)) queue.push(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
      else throw new Fault("binary_frames_required");
    } catch (error) {
      console.warn(JSON.stringify({ event: "input_rejected", code: error instanceof Fault ? error.code : "invalid_frame" }));
      finish(1009);
    }
  });
  server.addEventListener("close", () => finish());
  server.addEventListener("error", () => finish(1011));
  const task = (async () => {
    const early = request.headers.get("sec-websocket-protocol");
    if (early) queue.push(unb64(early, 8192));
    const config = perConnection(state.config, new URL(request.url));
    const first = await handshake(queue, new Handshake(state.uuid, config), budget);
    const send = async (bytes) => {
      if (finished) throw new Fault("connection_closed");
      budget.add(bytes.length);
      if ((server.bufferedAmount || 0) + bytes.length > 1048576) throw new Fault("outgoing_queue_full", 429);
      server.send(bytes);
    };
    let prefix = first.reply;
    const reply = async (bytes) => {
      const data = prefix.length ? concat(prefix, bytes) : bytes;
      prefix = new Uint8Array();
      await send(data);
    };
    if (first.udp) {
      const dns = new DNSFrames(config, fetcher);
      if (first.payload.length) await dns.feed(first.payload, reply);
      for (; ; ) {
        const part = await queue.read();
        if (part.done) break;
        budget.add(part.value.length);
        await dns.feed(part.value, reply);
      }
      dns.finish();
      return;
    }
    channel = await dial(connect2, config, first);
    if (finished) {
      channel.close();
      return;
    }
    if (first.payload.length) await channel.writer.write(first.payload);
    const upload = async () => {
      for (; ; ) {
        const part = await queue.read();
        if (part.done) return;
        budget.add(part.value.length);
        await channel.writer.write(part.value);
      }
    };
    const download = async () => {
      for (; ; ) {
        const part = await channel.reader.read();
        if (part.done) return;
        await reply(part.value);
      }
    };
    await Promise.race([upload(), download()]);
  })();
  ctx.waitUntil(task.then(() => finish(), (error) => {
    console.warn(JSON.stringify({ event: "connection_failed", code: error instanceof Fault ? error.code : "stream_error" }));
    finish(1011);
  }));
  const headers = {};
  const earlyProtocol = request.headers.get("sec-websocket-protocol");
  if (earlyProtocol && earlyProtocol.length <= 10924 && /^[\w-]+$/.test(earlyProtocol)) headers["sec-websocket-protocol"] = earlyProtocol;
  return new Response(null, { status: 101, webSocket: client, headers });
}
async function xhttp(request, state, ctx, connect2, fetcher = fetch) {
  if (!request.body) throw new Fault("body_required");
  const reader = request.body.getReader();
  const budget = new Budget(state.config.freeCpu === "yes");
  let channel;
  let first;
  try {
    first = await handshake(reader, new Handshake(state.uuid, state.config, true), budget);
  } catch (error) {
    await reader.cancel().catch(() => {
    });
    reader.releaseLock();
    throw error;
  }
  if (first.udp) {
    await reader.cancel().catch(() => {
    });
    reader.releaseLock();
    throw new Fault("xhttp_tcp_only");
  }
  try {
    channel = await dial(connect2, state.config, first);
  } catch (error) {
    await reader.cancel().catch(() => {
    });
    reader.releaseLock();
    throw error;
  }
  let stopped = false;
  let prefix = first.reply;
  let controller;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    channel.close();
    reader.cancel().catch(() => {
    });
    request.signal.removeEventListener("abort", stop);
    try {
      controller?.close();
    } catch {
    }
  };
  const body = new ReadableStream({
    start(c) {
      controller = c;
    },
    async pull(c) {
      try {
        const part = await channel.reader.read();
        if (stopped) return;
        if (part.done) {
          stop();
          return;
        }
        const bytes = concat(prefix, part.value);
        prefix = new Uint8Array();
        budget.add(bytes.length);
        c.enqueue(bytes);
      } catch {
        stop();
      }
    },
    cancel() {
      stop();
    }
  });
  const upload = (async () => {
    try {
      if (first.payload.length) await channel.writer.write(first.payload);
      for (; ; ) {
        const part = await reader.read();
        if (part.done || stopped) break;
        budget.add(part.value.length);
        await channel.writer.write(part.value);
      }
      if (!stopped) await channel.writer.close();
    } catch {
      stop();
    } finally {
      reader.releaseLock();
    }
  })();
  ctx.waitUntil(upload);
  request.signal.addEventListener("abort", stop, { once: true });
  if (request.signal.aborted) stop();
  const header = state.uuid.slice(1, 7), key = "_" + state.uuid.slice(25, 31);
  const random = crypto.getRandomValues(new Uint8Array(128));
  const padding = Array.from(random, (n) => String.fromCharCode(97 + n % 26)).join("");
  return new Response(body, { headers: { "content-type": "application/grpc", "cache-control": "no-store", "x-accel-buffering": "no", [header]: "https://padding.invalid/?" + key + "=" + padding } });
}

// rewrite-js/src/subscription.mjs
var LABEL_KEY = "subscription_exit_labels_js_v1";
var MAX_AGE = 7 * 864e5;
var TLS_PORTS = /* @__PURE__ */ new Set([443, 2053, 2083, 2087, 2096, 8443]);
var PLAIN_PORTS = /* @__PURE__ */ new Set([80, 8080, 8880, 2052, 2082, 2086, 2095]);
var COUNTRIES = { HK: "\u9999\u6E2F", TW: "\u53F0\u6E7E", JP: "\u65E5\u672C", SG: "\u65B0\u52A0\u5761", US: "\u7F8E\u56FD", KR: "\u97E9\u56FD", DE: "\u5FB7\u56FD", GB: "\u82F1\u56FD", FR: "\u6CD5\u56FD", CA: "\u52A0\u62FF\u5927", AU: "\u6FB3\u5927\u5229\u4E9A", NL: "\u8377\u5170", CN: "\u4E2D\u56FD" };
var hex = (bytes) => Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join("");
function scopeFor(state, hostname) {
  const c = state.config;
  return hex(sha256(encoder.encode(JSON.stringify([IMPLEMENTATION, hostname, state.uuid, c.tp, c.s, c.qj, c.p, c.customDNS, c.ev, c.et, c.ex]))));
}
var nodeKey = (node) => [node.protocol, node.transport, node.host, node.port].join("|");
function labelFor(node, labels, scope, now = Date.now()) {
  const measured = labels?.scope === scope ? labels.records?.[nodeKey(node)] : null;
  if (!measured || !/^[A-Z]{2}$/.test(measured.countryCode)) return "\u51FA\u53E3\u5F85\u6D4B";
  if (!Number.isFinite(measured.measuredAt) || measured.measuredAt > now + 3e5 || now - measured.measuredAt > MAX_AGE) return "\u51FA\u53E3\u5F85\u590D\u6D4B";
  const city = String(measured.city || "").replace(/[\r\n,=|]/g, " ").slice(0, 60);
  return (COUNTRIES[measured.countryCode] || measured.countryCode) + (city ? "\xB7" + city : "");
}
async function remoteList(url, fetcher) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Fault("invalid_feed_url");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8e3);
  try {
    const response = await fetcher(parsed.href, { signal: controller.signal, redirect: "error", headers: { accept: "text/plain, application/json" } });
    if (!response.ok) throw new Fault("feed_unavailable", 502);
    const text = decoder.decode(await boundedBody(response.body, 1048576));
    if (response.headers.get("content-type")?.includes("application/json")) {
      const rows = JSON.parse(text);
      if (!Array.isArray(rows)) throw new Fault("invalid_feed");
      return preferred(rows.slice(0, 2048).map((row) => typeof row === "string" ? row : authority(host(row.ip || row.host || ""), row.port || 443)).join("\n"));
    }
    return preferred(text);
  } finally {
    clearTimeout(timer);
  }
}
async function collect(state, hostname, fetcher = fetch) {
  const c = state.config;
  let rows = [];
  if (c.yxby !== "yes") {
    if (c.yx.trim()) rows = preferred(c.yx).map((row) => ({ ...row, source: "\u4F18\u9009" }));
    else if (c.egi === "yes" && c.yxURL.trim()) {
      const urls = c.yxURL.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean);
      if (urls.length > 4) throw new Fault("too_many_feeds");
      const fetched = await Promise.allSettled(urls.map((url) => remoteList(url, fetcher)));
      rows = fetched.flatMap((result) => result.status === "fulfilled" ? result.value.map((row) => ({ ...row, source: "\u5728\u7EBF\u4F18\u9009" })) : []);
      if (!rows.length) throw new Fault("no_usable_feed_addresses", 503);
    }
  }
  rows = rows.filter((row) => {
    const family = isIP(row.ip);
    return family ? c.epi === "yes" && (family === 4 ? c.ipv4 === "yes" : c.ipv6 === "yes") : c.epd === "yes";
  });
  if (c.ena === "yes") rows.unshift({ ip: hostname, port: 443, source: "\u539F\u751F" });
  const seen = /* @__PURE__ */ new Set(), out = [];
  for (const row of rows) {
    const key = authority(row.ip, row.port);
    if (seen.has(key)) continue;
    const tls = TLS_PORTS.has(row.port);
    if (!tls && (!PLAIN_PORTS.has(row.port) || c.dkby === "yes" || c.ech === "yes")) continue;
    seen.add(key);
    out.push({ host: row.ip, port: row.port, source: row.source, tls });
    if (out.length >= 256) break;
  }
  if (!out.length) throw new Fault("configure_native_or_preferred_addresses", 503);
  return out;
}
async function nodesFor(state, hostname, format, fetcher = fetch) {
  const c = state.config, rows = await collect(state, hostname, fetcher), scope = scopeFor(state, hostname);
  let labels = null;
  if (state.kv) {
    try {
      labels = JSON.parse(await state.kv.get(LABEL_KEY) || "null");
    } catch {
    }
  }
  const nodes = [];
  let index = 0;
  for (const row of rows) {
    for (const [protocol, transport, enabled] of [["vless", "ws", c.ev], ["trojan", "ws", c.et], ["vless", "xhttp", c.ex]]) {
      if (enabled !== "yes" || format === "loon" && transport === "xhttp" || transport === "xhttp" && !row.tls || protocol === "trojan" && !row.tls) continue;
      const node = { ...row, protocol, transport, sni: hostname, path: transport === "ws" ? "/?ed=2048" : "/" + state.uuid.slice(0, 8) };
      node.name = labelFor(node, labels, scope) + " | " + row.source + "-" + String(++index).padStart(3, "0") + " | " + protocol.toUpperCase() + "-" + transport.toUpperCase();
      nodes.push(node);
    }
  }
  if (!nodes.length) throw new Fault("no_compatible_protocol_for_format", 503);
  return { nodes, scope };
}
function uri(node, state) {
  const c = state.config;
  const args = new URLSearchParams({ security: node.tls ? "tls" : "none", type: node.transport, host: node.sni, path: node.path });
  if (node.protocol === "vless") args.set("encryption", "none");
  if (node.tls) {
    args.set("sni", node.sni);
    args.set("fp", "chrome");
  }
  const alpn = node.transport === "xhttp" ? "h2" : c.alpn;
  if (alpn) args.set("alpn", alpn);
  if (node.transport === "xhttp") args.set("mode", "stream-one");
  if (c.ech === "yes") args.set("ech", c.customECHDomain + "+" + c.customDNS);
  const password = node.protocol === "trojan" ? c.tp || state.uuid : state.uuid;
  return node.protocol + "://" + encodeURIComponent(password) + "@" + authority(node.host, node.port) + "?" + args + "#" + encodeURIComponent(node.name);
}
function clashNode(node, state) {
  const c = state.config;
  const row = { name: node.name, type: node.protocol, server: node.host, port: node.port, tls: node.tls, udp: false, network: node.transport, "skip-cert-verify": false };
  row[node.protocol === "trojan" ? "password" : "uuid"] = node.protocol === "trojan" ? c.tp || state.uuid : state.uuid;
  if (node.tls) {
    row[node.protocol === "trojan" ? "sni" : "servername"] = node.sni;
    row["client-fingerprint"] = "chrome";
  }
  if (node.transport === "ws") row["ws-opts"] = { path: node.path, headers: { Host: node.sni } };
  else row["xhttp-opts"] = { path: node.path, host: node.sni, mode: "stream-one" };
  const alpn = node.transport === "xhttp" ? "h2" : c.alpn;
  if (alpn) row.alpn = alpn.split(",");
  if (c.ech === "yes") row["ech-opts"] = { enable: true, "query-server-name": c.customECHDomain };
  return row;
}
var quote = (value) => JSON.stringify(String(value));
function loonNode(node, state) {
  const password = node.protocol === "trojan" ? state.config.tp || state.uuid : state.uuid;
  return node.name + " = " + (node.protocol === "trojan" ? "Trojan" : "VLESS") + ", " + node.host + ", " + node.port + ", " + quote(password) + ", transport=ws, path=" + quote(node.path) + ", host=" + quote(node.sni) + ", over-tls=" + node.tls + (node.tls ? ", tls-name=" + quote(node.sni) + ", skip-cert-verify=false" : "");
}
async function subscription(request, state, fetcher = fetch) {
  const url = new URL(request.url);
  const raw = (url.searchParams.get("target") || url.searchParams.get("format") || "base64").toLowerCase();
  const format = { v2ray: "base64", shadowrocket: "base64", clash: "clash", mihomo: "clash", loon: "loon", uri: "uri", base64: "base64" }[raw];
  if (!format) throw new Fault("unsupported_subscription_format");
  if (state.config.jk === "yes") throw new Fault("chain_subscription_requires_explicit_client_configuration", 409);
  if (format === "loon" && state.config.ech === "yes") throw new Fault("loon_ech_not_verified_disable_ech_or_use_other_format", 409);
  const { nodes } = await nodesFor(state, url.hostname, format, fetcher);
  let text, type = "text/plain; charset=utf-8";
  if (format === "clash") {
    text = JSON.stringify({
      "mixed-port": 7890,
      "allow-lan": false,
      mode: "rule",
      "log-level": "warning",
      dns: { enable: true, nameserver: [state.config.customDNS] },
      proxies: nodes.map((node) => clashNode(node, state)),
      "proxy-groups": [{ name: "\u8282\u70B9\u9009\u62E9", type: "select", proxies: nodes.map((node) => node.name) }],
      rules: ["MATCH,\u8282\u70B9\u9009\u62E9"]
    }, null, 2);
    type = "application/yaml; charset=utf-8";
  } else if (format === "loon") {
    text = "[General]\nipv6 = false\n\n[Proxy]\n" + nodes.map((node) => loonNode(node, state)).join("\n") + "\n\n[Proxy Group]\n\u8282\u70B9\u9009\u62E9 = select, " + nodes.map((node) => node.name).join(", ") + "\n\n[Rule]\nFINAL,\u8282\u70B9\u9009\u62E9\n";
  } else {
    text = nodes.map((node) => uri(node, state)).join("\n");
    if (format === "base64") text = b64(encoder.encode(text));
  }
  return new Response(text, { headers: { "content-type": type, "cache-control": "no-store", "profile-title": "base64:" + b64(encoder.encode("\u72EC\u7ACB\u5185\u6838 \xB7 \u51FA\u53E3\u5B9E\u6D4B\u6807\u7B7E")), "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
}
async function labelsAPI(request, state) {
  const scope = scopeFor(state, new URL(request.url).hostname);
  if (!state.kv) throw new Fault("kv_required", 503);
  if (request.method === "GET") {
    let labels;
    try {
      labels = JSON.parse(await state.kv.get(LABEL_KEY) || "null");
    } catch {
      labels = null;
    }
    return json({ scope, maxAgeDays: 7, labels: labels?.scope === scope ? labels : null });
  }
  if (request.method !== "POST") throw new Fault("method_not_allowed", 405);
  const body = await jsonBody(request);
  if (!body || body.scope !== scope || !body.records || Array.isArray(body.records) || typeof body.records !== "object") throw new Fault("measurement_scope_mismatch");
  const records = {};
  const entries = Object.entries(body.records);
  if (entries.length > 768) throw new Fault("too_many_measurements");
  for (const [key, value] of entries) {
    if (!/^(vless|trojan)\|(ws|xhttp)\|[^|]{1,253}\|\d{1,5}$/.test(key) || !value || !/^[A-Z]{2}$/.test(value.countryCode) || !Number.isFinite(value.measuredAt) || value.measuredAt > Date.now() + 3e5 || Date.now() - value.measuredAt > MAX_AGE) throw new Fault("invalid_measurement");
    const exitIp = host(value.exitIp || "");
    if (!isIP(exitIp)) throw new Fault("exit_ip_required");
    records[key] = { countryCode: value.countryCode, city: String(value.city || "").replace(/[\r\n,=|]/g, " ").slice(0, 60), exitIp, measuredAt: value.measuredAt };
  }
  await state.kv.put(LABEL_KEY, JSON.stringify({ scope, records }));
  return json({ success: true, count: entries.length, scope });
}

// rewrite-js/src/app.mjs
var safeEqual = (a, b) => same(encoder.encode(a), encoder.encode(b));
function entryPath(value) {
  if (!value) return "";
  return "/" + value.replace(/^\/+|\/+$/g, "");
}
function createApp(connect2, fetcher = fetch) {
  return {
    async fetch(request, env, ctx) {
      try {
        const url = new URL(request.url);
        if (url.pathname === "/" && request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("hello", { headers: { "cache-control": "no-store", "content-type": "text/plain" } });
        const state = await load(env);
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          if (request.method !== "GET") throw new Fault("method_not_allowed", 405);
          return websocket(request, state, ctx, connect2, fetcher);
        }
        let path;
        try {
          path = decodeURIComponent(url.pathname).replace(/\/+$/, "") || "/";
        } catch {
          throw new Fault("invalid_path");
        }
        const entries = ["/" + state.uuid, entryPath(state.config.d)].filter(Boolean);
        let suffix = null;
        for (const entry of entries) {
          if (safeEqual(path, entry)) {
            suffix = "";
            break;
          }
          if (path.startsWith(entry + "/") && safeEqual(path.slice(0, entry.length), entry)) {
            suffix = path.slice(entry.length);
            break;
          }
        }
        const xpaths = [...entries, "/" + state.uuid.slice(0, 8), entryPath(state.config.tp)];
        if (request.method === "POST" && state.config.ex === "yes" && xpaths.some((p) => p && safeEqual(path, p))) return await xhttp(request, state, ctx, connect2, fetcher);
        const querySub = path === "/sub" && safeEqual(url.searchParams.get("uuid") || "", state.uuid);
        if (querySub || suffix === "/sub") {
          if (request.method !== "GET") throw new Fault("method_not_allowed", 405);
          return await subscription(request, state, fetcher);
        }
        if (suffix === null) throw new Fault("not_found", 404);
        if (suffix === "/api/config") {
          if (request.method === "POST") {
            const next = patch(state.saved, await jsonBody(request));
            await save(state, next);
            return json({ success: true, ...normalize(env, next), kvEnabled: !!state.kv, implementation: IMPLEMENTATION });
          }
          if (request.method !== "GET") throw new Fault("method_not_allowed", 405);
          return json({ ...state.config, uuid: state.uuid, kvEnabled: !!state.kv, coreVersion: CORE_VERSION, implementation: IMPLEMENTATION });
        }
        if (suffix === "/api/preferred-ips") return await preferredAPI(request, state);
        if (suffix === "/api/exit-labels") return await labelsAPI(request, state);
        if (request.method !== "GET") throw new Fault("method_not_allowed", 405);
        if (suffix === "/region") return json({ region: "dynamic", actualExit: null, configuredRegion: state.config.wk, fallback: state.config.p || null });
        if (suffix === "/test-api") return json({ success: true, implementation: IMPLEMENTATION });
        if (suffix === "") return json({ implementation: IMPLEMENTATION, kvEnabled: !!state.kv, subscription: "Append /sub?target=clash, loon or base64", exitLabels: "Measured records are required; /region does not detect egress." });
        throw new Fault("not_found", 404);
      } catch (error) {
        if (!(error instanceof Fault)) console.error(JSON.stringify({ event: "request_failed", code: "internal_error" }));
        return json({ success: false, error: error instanceof Fault ? error.code : "internal_error" }, error instanceof Fault ? error.status : 500);
      }
    }
  };
}

// rewrite-js/src/worker.mjs
var worker_default = createApp(connect);
export {
  worker_default as default
};
