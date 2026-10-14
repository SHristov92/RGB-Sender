// Reference receiver for protocol v1 (symbol level). It is the executable form of
// the receiver algorithm in docs/SPEC.md section 7 and is what the tests use; a
// microcontroller receiver ports the same state machine.
//
// Input: colour segments, i.e. runs of one classified palette colour and how long
// they lasted, as produced by sampling a colour sensor and merging equal samples.
import { rsDecode } from './rs.js';
import { crc16 } from './crc.js';
import {
  COLOR,
  MODE,
  MODE_INFO,
  FRAME_TYPE,
  CAL_SEQUENCE,
  HEADER_INFO_LEN,
  HEADER_PARITY_LEN,
  HEADER_SYMBOLS,
  colorToDigit,
  digitsToByte,
  parseHeaderInfo,
  bodySymbolCount,
  parseEnvelope,
} from './protocol.js';

const SYNC_HOLD_MIN = 3; // a W segment at least this many T long starts a frame
const SPLIT_THRESHOLD = 1.75; // segments shorter than this many T are one symbol
const CAL_LEN = CAL_SEQUENCE.length;

// Converts colours to bytes with the differential code. Symbols that cannot be
// decoded become wrong bytes for Reed–Solomon to fix.
export function colorsToBytes(colors, mode, prev) {
  const { N, spb } = MODE_INFO[mode];
  const bytes = new Uint8Array(colors.length / spb);
  let invalid = 0;
  let c = prev;
  for (let i = 0; i < bytes.length; i++) {
    const digits = [];
    for (let k = 0; k < spb; k++) {
      const color = colors[i * spb + k];
      digits.push(colorToDigit(c, color, N));
      c = color;
    }
    const v = digitsToByte(digits, mode);
    if (v < 0) invalid++;
    bytes[i] = v < 0 ? 0 : v;
  }
  return { bytes, invalid };
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export class FrameDecoder {
  constructor(onFrame, onEvent = () => {}) {
    this.onFrame = onFrame;
    this.onEvent = onEvent;
    this.recent = []; // recent segment durations, for an unlocked estimate of T
    this.lastSegment = null;
    this.reset();
  }

  reset() {
    this.state = 'hunt';
    this.symbols = [];
    this.header = null;
    this.T = 0;
    this.T0 = 0;
    this.tSum = 0;
    this.tCount = 0;
  }

  get estimatedT() {
    if (this.T) return this.T;
    return this.recent.length ? median(this.recent) : 0;
  }

  pushSegment(color, duration) {
    const prevSegment = this.lastSegment;
    this.lastSegment = { color, duration };
    const tRef = this.estimatedT;
    this.recent.push(duration);
    if (this.recent.length > 31) this.recent.shift();

    // A long white hold can only be a sync: it aborts whatever was in progress.
    if (color === COLOR.W && tRef && duration >= SYNC_HOLD_MIN * tRef) {
      if (this.state === 'frame') this.onEvent({ type: 'frame-aborted', symbols: this.symbols.length });
      this.reset();
      this.state = 'sync';
      return;
    }

    if (this.state === 'hunt') return;

    if (this.state === 'sync') {
      const T = duration / 2;
      const ratio = prevSegment ? prevSegment.duration / T : 0;
      if (color === COLOR.K && ratio >= 3.5 && ratio <= 7) {
        this.state = 'frame';
        this.T = T;
        this.T0 = T;
        this.onEvent({ type: 'sync', T });
      } else {
        this.reset();
      }
      return;
    }

    // In a frame: split the segment into whole symbols.
    const n = duration < SPLIT_THRESHOLD * this.T ? 1 : Math.round(duration / this.T);
    if (n === 1) {
      // Refine T from single-symbol segments (seeded by the sync's K hold).
      this.tSum += duration;
      this.tCount++;
      this.T = (this.T0 * 2 + this.tSum) / (2 + this.tCount);
    }
    for (let i = 0; i < n; i++) this.symbols.push(color);
    this.process();
  }

  process() {
    const headerEnd = CAL_LEN + HEADER_SYMBOLS;
    if (!this.header && this.symbols.length >= headerEnd) {
      const calErrors = CAL_SEQUENCE.filter((c, i) => this.symbols[i] !== c).length;
      if (calErrors > 2) {
        this.onEvent({ type: 'calibration-mismatch', calErrors });
        this.reset();
        return;
      }
      const { bytes } = colorsToBytes(this.symbols.slice(CAL_LEN, headerEnd), MODE.ROBUST, COLOR.W);
      const decoded = rsDecode(bytes, HEADER_PARITY_LEN);
      const header = decoded && parseHeaderInfo(decoded.data.subarray(0, HEADER_INFO_LEN));
      if (!header) {
        this.onEvent({ type: 'header-failed' });
        this.reset();
        return;
      }
      this.header = header;
    }
    if (this.header) {
      const bodyEnd = headerEnd + bodySymbolCount(this.header);
      if (this.symbols.length < bodyEnd) return;
      const h = this.header;
      const { bytes } = colorsToBytes(this.symbols.slice(headerEnd, bodyEnd), h.mode, this.symbols[headerEnd - 1]);
      const decoded = rsDecode(bytes, 2 * h.t);
      if (decoded && crc16(decoded.data) === h.bodyCrc) {
        this.onFrame({ ...h, data: decoded.data, corrected: decoded.corrected });
      } else {
        this.onEvent({ type: 'body-failed', header: h });
      }
      this.reset();
    }
  }
}

// Collects frames of one session and rebuilds the message (carousel + XOR parity).
export class Assembler {
  constructor() {
    this.clear();
  }

  clear() {
    this.key = null;
    this.data = [];
    this.parity = [];
  }

  // Returns { contentType, data, recovered } once the message is complete, else null.
  addFrame(f) {
    const key = `${f.sessionId}/${f.K}/${f.L}/${f.P}`;
    if (key !== this.key) {
      this.clear();
      this.key = key;
      this.K = f.K;
      this.L = f.L;
      this.P = f.P;
    }
    if (f.type === FRAME_TYPE.DATA) this.data[f.index] = f.data;
    else this.parity[f.index] = f.data;
    return this.tryComplete();
  }

  get progress() {
    let have = 0;
    for (let i = 0; i < this.K; i++) if (this.data[i]) have++;
    return { have, total: this.K };
  }

  tryComplete() {
    let recovered = 0;
    for (let i = 0; i < this.K; i++) {
      if (this.data[i] || !this.P) continue;
      const j = i % this.P;
      if (!this.parity[j]) continue;
      const others = [];
      for (let k = j; k < this.K; k += this.P) if (k !== i) others.push(this.data[k]);
      if (others.some((d) => !d)) continue;
      const rebuilt = Uint8Array.from(this.parity[j]);
      for (const d of others) for (let b = 0; b < this.L; b++) rebuilt[b] ^= d[b];
      this.data[i] = rebuilt;
      recovered++;
    }
    for (let i = 0; i < this.K; i++) if (!this.data[i]) return null;
    const all = new Uint8Array(this.K * this.L);
    for (let i = 0; i < this.K; i++) all.set(this.data[i], i * this.L);
    const msg = parseEnvelope(all);
    if (!msg) {
      // A frame passed its CRC-16 but the whole message did not: start over.
      this.clear();
      return null;
    }
    return { ...msg, recovered };
  }
}

// Convenience wrapper: segments in, messages out.
export class Receiver {
  constructor(onMessage, onEvent = () => {}) {
    this.assembler = new Assembler();
    this.frames = new FrameDecoder((f) => {
      onEvent({ type: 'frame', frame: f });
      const msg = this.assembler.addFrame(f);
      if (msg) onMessage(msg);
    }, onEvent);
  }

  pushSegment(color, duration) {
    this.frames.pushSegment(color, duration);
  }
}
