// Sec-MS-GEC v2 — port do edge-tts (drm.py) para Node stdlib.
// Gerado por transcrição literal do algoritmo Python e verificado contra
// vetores do próprio Python (ver TESTES-CONVERSA-TURNOS.md).
// Sem dependências externas. Não contém segredo: o token é público
// (TRUSTED_CLIENT_TOKEN é o mesmo do pacote edge-tts).
'use strict';

const MASK = 0xFFFFFFFF;
const WIN_EPOCH = 11644473600;
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

const _SHA256_INITIAL = [0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19];
const _SHA256_STATE = [0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A, 0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2];
const _SHA256_SCHEDULE = [0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA, 0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6, 0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33, 0xD258B060, 0x72766564];
const _SHA256_ROUND_CONSTANTS = [0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5, 0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174, 0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA, 0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967, 0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85, 0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070, 0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3, 0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2];
const _SHA256_ADJUSTMENT = 0xC9DC06A7;
const _SHA256_BLOCK_CONSTANTS = _SHA256_ROUND_CONSTANTS.slice(0, 14).concat([_SHA256_ADJUSTMENT], _SHA256_ROUND_CONSTANTS.slice(15));
const _SHA256_SIGMA0_ADJUSTMENT = 0x059C0B80;
const _SHA256_SIGMA1_ADJUSTMENT = 0x000B92C0;
const _CS64_COEFFICIENTS = [[0xE82E91B1, 0xB32700D0], [0x44DE24C6, 0x88DFF51D], [0x3BEB65BC, 0x29514038], [0xC89C5933, 0xB328CBDF], [0x8D1EC211, 0xD405B4D5], [0x314EF5D5, 0x26E55F3C], [0xE92491B1, 0x607801C6], [0xF0A5B9D5, 0x82B2C1FB], [0x06064CF3, 0xFA51A3DA], [0xDA79FA60, 0x207CC464], [0xBED20560, 0x3C3C74F3], [0x89F9C9F8, 0xD2D14B61], [0x35FA38C6, 0xBB04A2C1], [0xCB49E3C6, 0xC5626167]];
const _CS64_FACTOR = 0x82893933;
const _CS64_ADJUSTMENT0 = 0xF2F90B1A;
const _CS64_ADJUSTMENT1 = 0x0B1A0000;

function rotr32(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }
function rol16(v) { v >>>= 0; return ((v << 16) | (v >>> 16)) >>> 0; }
// Multiplicação de dois uint32 com o resultado reduzido a 32 bits
// (o produto passa de 2^53, então usa BigInt).
function mul32(a, b) { return Number((BigInt(a >>> 0) * BigInt(b >>> 0)) & 0xFFFFFFFFn); }

function sigma0(v) { return (rotr32(v, 7) ^ rotr32(v, 18) ^ (v >>> 3)) >>> 0; }
function sigma1(v) { return (rotr32(v, 17) ^ rotr32(v, 19) ^ (v >>> 10)) >>> 0; }

function expandSchedule(words, firstWord) {
  firstWord = firstWord === undefined ? 16 : firstWord;
  for (let index = firstWord; index < 64; index++) {
    const x = words[index - 2], y = words[index - 15];
    const s1 = sigma1(x), s0 = sigma0(y);
    words.push((s1 + words[index - 7] + s0 + words[index - 16]) >>> 0);
  }
}

function sha256Rounds(state, words, firstRound) {
  firstRound = firstRound || 0;
  let a = state[0], b = state[1], c = state[2], d = state[3];
  let e = state[4], f = state[5], g = state[6], h = state[7];
  const K = firstRound === 14 ? _SHA256_BLOCK_CONSTANTS : _SHA256_ROUND_CONSTANTS;
  const S1 = (x) => (rotr32(x, 6) ^ rotr32(x, 11) ^ rotr32(x, 25)) >>> 0;
  const S0 = (x) => (rotr32(x, 2) ^ rotr32(x, 13) ^ rotr32(x, 22)) >>> 0;
  const Ch = (x, y, z) => (z ^ (x & (y ^ z))) >>> 0;
  const Maj = (x, y, z) => ((x & y) | (z & (x | y))) >>> 0;
  const aligned = Math.min(64, Math.floor((firstRound + 7) / 8) * 8);
  for (let index = firstRound; index < aligned; index++) {
    const t1 = (h + S1(e) + Ch(e, f, g) + K[index] + words[index]) >>> 0;
    const t2 = (S0(a) + Maj(a, b, c)) >>> 0;
    const na = (t1 + t2) >>> 0, ne = (d + t1) >>> 0;
    h = g; g = f; f = e; e = ne; d = c; c = b; b = a; a = na;
  }
  for (let index = aligned; index < 64; index += 8) {
    let t1 = (h + S1(e) + Ch(e, f, g) + K[index] + words[index]) >>> 0;
    d = (d + t1) >>> 0;
    h = (t1 + S0(a) + Maj(a, b, c)) >>> 0;
    t1 = (g + S1(d) + Ch(d, e, f) + K[index + 1] + words[index + 1]) >>> 0;
    c = (c + t1) >>> 0;
    g = (t1 + S0(h) + Maj(h, a, b)) >>> 0;
    t1 = (f + S1(c) + Ch(c, d, e) + K[index + 2] + words[index + 2]) >>> 0;
    b = (b + t1) >>> 0;
    f = (t1 + S0(g) + Maj(g, h, a)) >>> 0;
    t1 = (e + S1(b) + Ch(b, c, d) + K[index + 3] + words[index + 3]) >>> 0;
    a = (a + t1) >>> 0;
    e = (t1 + S0(f) + Maj(f, g, h)) >>> 0;
    t1 = (d + S1(a) + Ch(a, b, c) + K[index + 4] + words[index + 4]) >>> 0;
    h = (h + t1) >>> 0;
    d = (t1 + S0(e) + Maj(e, f, g)) >>> 0;
    t1 = (c + S1(h) + Ch(h, a, b) + K[index + 5] + words[index + 5]) >>> 0;
    g = (g + t1) >>> 0;
    c = (t1 + S0(d) + Maj(d, e, f)) >>> 0;
    t1 = (b + S1(g) + Ch(g, h, a) + K[index + 6] + words[index + 6]) >>> 0;
    f = (f + t1) >>> 0;
    b = (t1 + S0(c) + Maj(c, d, e)) >>> 0;
    t1 = (a + S1(f) + Ch(f, g, h) + K[index + 7] + words[index + 7]) >>> 0;
    e = (e + t1) >>> 0;
    a = (t1 + S0(b) + Maj(b, c, d)) >>> 0;
  }
  return [a, b, c, d, e, f, g, h];
}

function sha256Init(data) { // data: Buffer, len >= 7
  const words = new Array(14).fill(0);
  words.push(data.readUIntBE(0, 3));
  words.push(data.readUIntBE(3, 4));
  for (let index = 16; index < 30; index++) {
    let value = _SHA256_SCHEDULE[index - 16];
    if (index - 2 >= 14) value += (index === 16 ? (sigma1(words[index - 2]) ^ _SHA256_SIGMA1_ADJUSTMENT) : sigma1(words[index - 2]));
    if (index - 7 >= 14) value += words[index - 7];
    if (index - 15 >= 14) value += (index === 29 ? (sigma0(words[index - 15]) ^ _SHA256_SIGMA0_ADJUSTMENT) : sigma0(words[index - 15]));
    words.push(value >>> 0);
  }
  words.push((sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] + _SHA256_ADJUSTMENT - _SHA256_ROUND_CONSTANTS[14]) >>> 0);
  expandSchedule(words, 31);
  const working = sha256Rounds(_SHA256_STATE, words, 14);
  return _SHA256_INITIAL.map((x, i) => (x + working[i]) >>> 0);
}

function sha256Digest(data) { // data: Buffer -> Buffer(32)
  if (data.length < 7) throw new Error('Token salt must contain at least seven bytes');
  const length = 57 + data.length;
  const padZeros = ((55 - length) % 64 + 64) % 64;
  const padded = Buffer.concat([data.subarray(7), Buffer.from([0x80]), Buffer.alloc(padZeros), Buffer.alloc(8)]);
  padded.writeBigUInt64BE(BigInt(length * 8), padded.length - 8);
  let state = sha256Init(data.subarray(0, 7));
  for (let off = 0; off < padded.length; off += 64) {
    const words = [];
    for (let i = 0; i < 16; i++) words.push(padded.readUInt32BE(off + i * 4));
    expandSchedule(words);
    const working = sha256Rounds(state, words, 0);
    state = state.map((x, i) => (x + working[i]) >>> 0);
  }
  const out = Buffer.alloc(32);
  state.forEach((w, i) => out.writeUInt32BE(w, i * 4));
  return out;
}

function wordsLe4Even(data) {
  const padded = Buffer.concat([data, Buffer.alloc(((-data.length % 4) + 4) % 4)]);
  const words = [];
  for (let i = 0; i < padded.length; i += 4) words.push(padded.readUInt32LE(i));
  if (words.length % 2) words.push(0);
  return words;
}

function cs64Digest(data, digest) {
  let keyA = (digest.readUInt32LE(0) | 1) >>> 0;
  let keyB = (digest.readUInt32LE(4) | 1) >>> 0;
  const factors = [mul32(keyA, _CS64_FACTOR), mul32(keyB, _CS64_FACTOR)];
  const terms = _CS64_COEFFICIENTS.map((pair, index) => mul32(pair[0], factors[index % 2]));
  const offsets = _CS64_COEFFICIENTS.map((pair) => pair[1]);
  wordsLe4Even(Buffer.concat([Buffer.from([0x00]), data])).forEach((word, index) => {
    let term = mul32(word, index % 2 === 0 ? keyA : keyB);
    let offset = mul32(rol16(word), index % 2 === 0 ? 0xEF0569FB : 0xC31713DB);
    if (index === 0) {
      term = (term + mul32(_CS64_ADJUSTMENT0, factors[0])) >>> 0;
      offset = (offset + _CS64_ADJUSTMENT1) >>> 0;
    }
    terms.push(term);
    offsets.push(offset);
  });
  let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
  for (let index = 0; index < terms.length; index += 2) {
    const x = terms[index], y = terms[index + 1];
    let t = rol16((offsets[index] + x) >>> 0);
    let q = mul32(t, 0x76F50F34);
    swapAcc = (swapAcc + ((mul32(rol16(q), 0xC3EFEA97) + q) >>> 0)) >>> 0;
    t = rol16((offsets[index + 1] + y) >>> 0);
    q = mul32(t, 0x1881CE3C);
    swapLast = (mul32(rol16(q), 0x35BD1EC9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;
    state = (mul32(state, keyA) + x) >>> 0;
    state = mul32(rol16(state), 0xCF98B111);
    state = mul32(rol16(state), 0x87085B9F);
    state = mul32(rol16(state), 0x12CEB96D);
    state = mul32(rol16(state), 0x257E1D83);
    acc = (acc + state) >>> 0;
    t = (mul32(state, keyB) + y) >>> 0;
    t = mul32(rol16(t), 0xA27416F5);
    t = mul32(rol16(t), 0xD38396FF);
    state = mul32(rol16(mul32(rol16(t), 0x7C932B89)), 0xBFA49F69);
    acc = (acc + state) >>> 0;
  }
  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

function tokenHash(data) { // data: Buffer -> [cs64Hex16, shaHex64]
  const digest = sha256Digest(data);
  const pair = cs64Digest(data, digest);
  const csBuf = Buffer.alloc(8);
  csBuf.writeUInt32LE(pair[0], 0);
  csBuf.writeUInt32LE(pair[1], 4);
  return [csBuf.toString('hex').toUpperCase(), digest.toString('hex').toUpperCase()];
}

function generateSecMsGec(unixSeconds) {
  let ticks = (unixSeconds === undefined ? Date.now() / 1000 : unixSeconds) + WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e7; // S_TO_NS / 100
  const str = String(Math.round(ticks)) + TRUSTED_CLIENT_TOKEN;
  const data = Buffer.from(str, 'ascii');
  const parts = tokenHash(data);
  return parts[0] + '-' + parts[1];
}

module.exports = { generateSecMsGec, tokenHash, sha256Digest, TRUSTED_CLIENT_TOKEN };
