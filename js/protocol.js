// RGB Sender protocol v1: encoder side and shared constants. See docs/SPEC.md.
import { rsEncode } from './rs.js';
import { crc16, crc32 } from './crc.js';

export const VERSION = 1;

// Palette index -> displayed sRGB colour. Indices are part of the protocol.
export const PALETTE = [
  { key: 'K', name: 'black', rgb: [0, 0, 0] },
  { key: 'R', name: 'red', rgb: [255, 0, 0] },
  { key: 'G', name: 'green', rgb: [0, 255, 0] },
  { key: 'B', name: 'blue', rgb: [0, 0, 255] },
  { key: 'W', name: 'white', rgb: [255, 255, 255] },
  { key: 'C', name: 'cyan', rgb: [0, 255, 255] },
  { key: 'M', name: 'magenta', rgb: [255, 0, 255] },
  { key: 'Y', name: 'yellow', rgb: [255, 255, 0] },
];
export const COLOR = { K: 0, R: 1, G: 2, B: 3, W: 4, C: 5, M: 6, Y: 7 };

export const MODE = { ROBUST: 0, DENSE: 1 };
// N = palette size used by the differential line code, spb = symbols per byte.
export const MODE_INFO = {
  [MODE.ROBUST]: { name: 'robust', N: 5, base: 4, spb: 4 },
  [MODE.DENSE]: { name: 'dense', N: 8, base: 7, spb: 3 },
};

export const FRAME_TYPE = { DATA: 0, PARITY: 1 };
export const CONTENT_TYPE = { BINARY: 0, TEXT: 1, WIFI: 2, JSON: 3 };

export const SYNC_W_SLOTS = 5;
export const SYNC_K_SLOTS = 2;
export const CAL_SEQUENCE = [COLOR.R, COLOR.G, COLOR.B, COLOR.C, COLOR.M, COLOR.Y, COLOR.W];
export const HEADER_INFO_LEN = 8;
export const HEADER_PARITY_LEN = 8;
export const HEADER_SYMBOLS = (HEADER_INFO_LEN + HEADER_PARITY_LEN) * MODE_INFO[MODE.ROBUST].spb;
export const PREAMBLE_PAIRS_DEFAULT = 12;

export const DEFAULTS = {
  mode: MODE.ROBUST,
  chunkSize: 48, // L: data bytes per frame
  eccT: 8, // t: correctable byte errors per body codeword (2t parity bytes)
  parityEvery: 4, // one XOR parity frame per this many data frames, 0 = none
  symbolMs: 50,
};

// ---- Line code --------------------------------------------------------------

export function byteToDigits(byte, mode) {
  if (mode === MODE.ROBUST) return [(byte >> 6) & 3, (byte >> 4) & 3, (byte >> 2) & 3, byte & 3];
  return [Math.floor(byte / 49), Math.floor(byte / 7) % 7, byte % 7];
}

// Returns the byte value, or -1 when the digit group is not a valid byte.
export function digitsToByte(digits, mode) {
  const { base } = MODE_INFO[mode];
  let v = 0;
  for (const d of digits) {
    if (d < 0 || d >= base) return -1;
    v = v * base + d;
  }
  return v <= 255 ? v : -1;
}

// Differential colour code: every symbol changes colour, so the stream is self-clocking.
export function nextColor(prev, digit, N) {
  return (prev + 1 + digit) % N;
}

export function colorToDigit(prev, color, N) {
  if (color >= N || prev >= N || color === prev) return -1;
  return (color - prev - 1 + N) % N;
}

export function bytesToColors(bytes, mode, prev) {
  const { N } = MODE_INFO[mode];
  const colors = [];
  let c = prev;
  for (const b of bytes) {
    for (const d of byteToDigits(b, mode)) {
      c = nextColor(c, d, N);
      colors.push(c);
    }
  }
  return colors;
}

// ---- Frame -------------------------------------------------------------------

export function encodeHeaderInfo(h) {
  const info = new Uint8Array(HEADER_INFO_LEN);
  info[0] = ((VERSION & 3) << 6) | ((h.mode & 3) << 4) | (h.type & 3);
  info[1] = h.sessionId & 0xff;
  info[2] = h.index & 0xff;
  info[3] = h.K & 0xff;
  info[4] = h.L & 0xff;
  info[5] = ((h.P & 0xf) << 4) | (h.t & 0xf);
  info[6] = (h.bodyCrc >> 8) & 0xff;
  info[7] = h.bodyCrc & 0xff;
  return info;
}

export function parseHeaderInfo(info) {
  const h = {
    version: info[0] >> 6,
    mode: (info[0] >> 4) & 3,
    reserved: (info[0] >> 2) & 3,
    type: info[0] & 3,
    sessionId: info[1],
    index: info[2],
    K: info[3],
    L: info[4],
    P: info[5] >> 4,
    t: info[5] & 0xf,
    bodyCrc: (info[6] << 8) | info[7],
  };
  const valid =
    h.version === VERSION &&
    h.reserved === 0 &&
    (h.mode === MODE.ROBUST || h.mode === MODE.DENSE) &&
    (h.type === FRAME_TYPE.DATA || h.type === FRAME_TYPE.PARITY) &&
    h.K >= 1 &&
    h.L >= 1 &&
    h.L + 2 * h.t <= 255 &&
    h.index < (h.type === FRAME_TYPE.DATA ? h.K : h.P);
  return valid ? h : null;
}

export function bodySymbolCount(h) {
  return (h.L + 2 * h.t) * MODE_INFO[h.mode].spb;
}

// One frame as a list of palette indices, one per symbol slot of duration T.
export function frameToSlots(frame) {
  const slots = [];
  for (let i = 0; i < SYNC_W_SLOTS; i++) slots.push(COLOR.W);
  for (let i = 0; i < SYNC_K_SLOTS; i++) slots.push(COLOR.K);
  slots.push(...CAL_SEQUENCE);
  const headerColors = bytesToColors(rsEncode(frame.headerInfo, HEADER_PARITY_LEN), MODE.ROBUST, COLOR.W);
  slots.push(...headerColors);
  const bodyColors = bytesToColors(
    rsEncode(frame.body, 2 * frame.t),
    frame.mode,
    headerColors[headerColors.length - 1],
  );
  slots.push(...bodyColors);
  const last = bodyColors[bodyColors.length - 1];
  slots.push(last === COLOR.K ? COLOR.R : COLOR.K); // guard: never W, never equal to last
  return slots;
}

// ---- Message envelope and transport -------------------------------------------

// [content type u8][length u16 LE][data][CRC-32 LE over everything before it]
export function buildEnvelope(contentType, data) {
  if (data.length > 0xffff) throw new Error('Message too long (max 65535 bytes)');
  const env = new Uint8Array(data.length + 7);
  env[0] = contentType & 0xff;
  env[1] = data.length & 0xff;
  env[2] = data.length >> 8;
  env.set(data, 3);
  const crc = crc32(env.subarray(0, data.length + 3));
  env[data.length + 3] = crc & 0xff;
  env[data.length + 4] = (crc >>> 8) & 0xff;
  env[data.length + 5] = (crc >>> 16) & 0xff;
  env[data.length + 6] = (crc >>> 24) & 0xff;
  return env;
}

// Accepts the reassembled (possibly zero-padded) byte stream.
export function parseEnvelope(bytes) {
  if (bytes.length < 7) return null;
  const len = bytes[1] | (bytes[2] << 8);
  if (len + 7 > bytes.length) return null;
  const crc = (bytes[len + 3] | (bytes[len + 4] << 8) | (bytes[len + 5] << 16) | (bytes[len + 6] << 24)) >>> 0;
  if (crc32(bytes.subarray(0, len + 3)) !== crc) return null;
  return { contentType: bytes[0], data: bytes.slice(3, 3 + len) };
}

export function planFrames(envelopeLength, opts = {}) {
  const t = opts.eccT ?? DEFAULTS.eccT;
  const parityEvery = opts.parityEvery ?? DEFAULTS.parityEvery;
  if (t < 0 || t > 15) throw new Error('eccT must be 0..15');
  const maxL = Math.min(opts.chunkSize ?? DEFAULTS.chunkSize, 255 - 2 * t);
  const K = Math.ceil(envelopeLength / maxL);
  const L = Math.ceil(envelopeLength / K); // spread bytes evenly so the last frame is not mostly padding
  if (K > 255) throw new Error(`Message needs ${K} frames; the maximum is 255. Increase the chunk size.`);
  const P = parityEvery > 0 && K > 1 ? Math.min(15, Math.ceil(K / parityEvery)) : 0;
  return { L, K, P, t };
}

export function buildFrames(envelope, opts = {}) {
  const mode = opts.mode ?? DEFAULTS.mode;
  // Derived from the content so re-sending the same message keeps the receiver's partial progress.
  const sessionId = opts.sessionId ?? (crc32(envelope) ^ (mode << 7)) & 0xff;
  const { L, K, P, t } = planFrames(envelope.length, opts);
  const chunks = [];
  for (let i = 0; i < K; i++) {
    const chunk = new Uint8Array(L);
    chunk.set(envelope.subarray(i * L, Math.min((i + 1) * L, envelope.length)));
    chunks.push(chunk);
  }
  const parity = [];
  for (let j = 0; j < P; j++) {
    const acc = new Uint8Array(L);
    for (let i = j; i < K; i += P) for (let k = 0; k < L; k++) acc[k] ^= chunks[i][k];
    parity.push(acc);
  }
  const make = (type, index, body) => ({
    type,
    index,
    mode,
    t,
    body,
    headerInfo: encodeHeaderInfo({ mode, type, sessionId, index, K, L, P, t, bodyCrc: crc16(body) }),
  });
  const frames = [
    ...chunks.map((c, i) => make(FRAME_TYPE.DATA, i, c)),
    ...parity.map((p, j) => make(FRAME_TYPE.PARITY, j, p)),
  ];
  return { sessionId, mode, L, K, P, t, frames };
}

export function preambleSlots(pairs = PREAMBLE_PAIRS_DEFAULT) {
  const slots = [];
  for (let i = 0; i < pairs; i++) slots.push(COLOR.K, COLOR.W);
  slots.push(COLOR.K);
  return slots;
}

// Everything the sender needs: one carousel round of slots plus an optional lead-in.
export function buildTransmission(contentType, data, opts = {}) {
  const envelope = buildEnvelope(contentType, data);
  const plan = buildFrames(envelope, opts);
  const frameSlots = plan.frames.map(frameToSlots);
  const round = [];
  const frameStarts = [];
  for (const s of frameSlots) {
    frameStarts.push(round.length);
    round.push(...s);
  }
  return {
    ...plan,
    envelope,
    preamble: preambleSlots(opts.preamblePairs ?? PREAMBLE_PAIRS_DEFAULT),
    round: Uint8Array.from(round),
    frameStarts,
  };
}
