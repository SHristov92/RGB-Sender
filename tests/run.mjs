import assert from 'node:assert/strict';
import { rsEncode, rsDecode } from '../js/rs.js';
import { crc16, crc32 } from '../js/crc.js';
import {
  MODE,
  CONTENT_TYPE,
  byteToDigits,
  digitsToByte,
  bytesToColors,
  buildTransmission,
  buildEnvelope,
  parseEnvelope,
} from '../js/protocol.js';
import { Receiver, colorsToBytes } from '../js/receiver.js';
import { simulate, makeRng } from './sim.mjs';

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n     ${e.stack}`);
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

test('CRC check values', () => {
  assert.equal(crc16(enc.encode('123456789')), 0x29b1);
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
});

test('Reed–Solomon corrects up to t errors', () => {
  const rng = makeRng(1);
  for (let iter = 0; iter < 400; iter++) {
    const nsym = 2 * (1 + Math.floor(rng() * 10));
    const k = 1 + Math.floor(rng() * (255 - nsym));
    const data = Uint8Array.from({ length: k }, () => Math.floor(rng() * 256));
    const cw = rsEncode(data, nsym);
    const errs = Math.floor(rng() * (nsym / 2 + 1));
    const bad = Uint8Array.from(cw);
    const used = new Set();
    while (used.size < errs) used.add(Math.floor(rng() * cw.length));
    for (const p of used) bad[p] ^= 1 + Math.floor(rng() * 255);
    const out = rsDecode(bad, nsym);
    assert.ok(out, `decode failed n=${cw.length} nsym=${nsym} errs=${errs}`);
    assert.deepEqual(out.data, data);
    assert.equal(out.corrected, errs);
  }
});

test('Reed–Solomon matches a known codeword', () => {
  // Cross-checked with Python reedsolo: RSCodec(4, prim=0x11d, fcr=0, generator=2).
  assert.deepEqual(Array.from(rsEncode(enc.encode('hello world'), 4)), [
    ...enc.encode('hello world'),
    69, 60, 23, 78,
  ]);
});

test('Reed–Solomon rejects most over-capacity corruption', () => {
  const rng = makeRng(2);
  let accepted = 0;
  for (let iter = 0; iter < 300; iter++) {
    const data = Uint8Array.from({ length: 32 }, () => Math.floor(rng() * 256));
    const cw = rsEncode(data, 16);
    for (let e = 0; e < 14; e++) cw[Math.floor(rng() * cw.length)] ^= 1 + Math.floor(rng() * 255);
    const out = rsDecode(cw, 16);
    if (out && !out.data.every((v, i) => v === data[i])) accepted++;
  }
  assert.ok(accepted < 3, `miscorrections: ${accepted}`);
});

test('digit mapping round-trips every byte in both modes', () => {
  for (const mode of [MODE.ROBUST, MODE.DENSE]) {
    for (let b = 0; b < 256; b++) assert.equal(digitsToByte(byteToDigits(b, mode), mode), b);
  }
  assert.equal(digitsToByte([6, 6, 6], MODE.DENSE), -1);
});

test('differential code never repeats a colour and decodes back', () => {
  const rng = makeRng(3);
  for (const mode of [MODE.ROBUST, MODE.DENSE]) {
    const bytes = Uint8Array.from({ length: 200 }, () => Math.floor(rng() * 256));
    const colors = bytesToColors(bytes, mode, 4);
    let prev = 4;
    for (const c of colors) {
      assert.notEqual(c, prev);
      prev = c;
    }
    assert.deepEqual(colorsToBytes(colors, mode, 4).bytes, bytes);
  }
});

test('envelope detects corruption', () => {
  const env = buildEnvelope(CONTENT_TYPE.TEXT, enc.encode('abc'));
  assert.equal(dec.decode(parseEnvelope(env).data), 'abc');
  env[4] ^= 1;
  assert.equal(parseEnvelope(env), null);
});

function runChannel({ text, opts, channel, seed, rounds = 3, startAt = 0, killFrames = [] }) {
  const tx = buildTransmission(CONTENT_TYPE.TEXT, enc.encode(text), opts);
  const rng = makeRng(seed);
  let message = null;
  let symbolsUsed = 0;
  const rx = new Receiver((m) => {
    if (!message) message = m;
  });
  const stream = [...tx.preamble];
  for (let r = 0; r < rounds; r++) {
    const round = Array.from(tx.round);
    if (r === 0) {
      for (const f of killFrames) {
        // Wipe a whole frame (e.g. the phone moved): replace with noise.
        const start = tx.frameStarts[f];
        const end = tx.frameStarts[f + 1] ?? round.length;
        for (let i = start + 8; i < end; i++) round[i] = Math.floor(rng() * 4) + 1;
      }
    }
    stream.push(...round);
  }
  const segments = simulate(stream.slice(startAt), { T: opts.symbolMs ?? 50, ...channel }, rng);
  for (const s of segments) {
    rx.pushSegment(s.color, s.duration);
    symbolsUsed++;
    if (message) break;
  }
  return { message, tx };
}

const SAMPLE = 'WIFI:T:WPA;S:Workshop 2.4GHz;P:correct horse battery staple;;';

for (const mode of [MODE.ROBUST, MODE.DENSE]) {
  const name = mode === MODE.ROBUST ? 'robust' : 'dense';

  test(`${name}: clean channel delivers in one round`, () => {
    const { message } = runChannel({ text: SAMPLE, opts: { mode }, channel: {}, seed: 10, rounds: 1 });
    assert.ok(message);
    assert.equal(dec.decode(message.data), SAMPLE);
  });

  test(`${name}: symbol errors, timing jitter and dropped display frames`, () => {
    for (let seed = 20; seed < 30; seed++) {
      const { message } = runChannel({
        text: SAMPLE.repeat(3),
        opts: { mode },
        channel: { errorRate: 0.01, jitter: 0.15, dropRate: 0.03 },
        seed,
        rounds: 4,
      });
      assert.ok(message, `seed ${seed}`);
      assert.equal(dec.decode(message.data), SAMPLE.repeat(3));
    }
  });

  test(`${name}: fast 2-frame symbols survive dropped display frames`, () => {
    for (let seed = 30; seed < 35; seed++) {
      const { message } = runChannel({
        text: SAMPLE.repeat(2),
        opts: { mode, symbolMs: 33.3 },
        channel: { errorRate: 0.01, jitter: 0.15, dropRate: 0.1 },
        seed,
        rounds: 4,
      });
      assert.ok(message, `seed ${seed}`);
    }
  });

  test(`${name}: receiver joins mid-transmission`, () => {
    const { message, tx } = runChannel({ text: SAMPLE.repeat(2), opts: { mode }, channel: { jitter: 0.1 }, seed: 40, rounds: 2, startAt: 300 });
    assert.ok(message);
    assert.ok(tx.K > 1);
    assert.equal(dec.decode(message.data), SAMPLE.repeat(2));
  });

  test(`${name}: a destroyed frame is rebuilt from XOR parity in the same round`, () => {
    const { message, tx } = runChannel({ text: SAMPLE.repeat(4), opts: { mode }, channel: {}, seed: 50, rounds: 1, killFrames: [1] });
    assert.ok(tx.P >= 1);
    assert.ok(message, 'message not recovered in one round');
    assert.equal(message.recovered, 1);
    assert.equal(dec.decode(message.data), SAMPLE.repeat(4));
  });
}

test('binary payload with tiny chunks and no parity', () => {
  const rng = makeRng(60);
  const data = Uint8Array.from({ length: 300 }, () => Math.floor(rng() * 256));
  const tx = buildTransmission(CONTENT_TYPE.BINARY, data, { chunkSize: 16, eccT: 4, parityEvery: 0, mode: MODE.DENSE });
  let got = null;
  const rx = new Receiver((m) => (got = m));
  for (const s of simulate([...tx.preamble, ...tx.round], { T: 50 }, rng)) rx.pushSegment(s.color, s.duration);
  assert.ok(got);
  assert.equal(got.contentType, CONTENT_TYPE.BINARY);
  assert.deepEqual(got.data, data);
});

if (failures) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall tests passed');
