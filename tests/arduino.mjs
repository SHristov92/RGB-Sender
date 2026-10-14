// Runs the Arduino library (arduino/RGBReceiver) on the host: compiles it with g++
// and feeds it transmissions built by js/protocol.js, both as colour segments
// (compared with the JS reference receiver) and as simulated raw sensor readings.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { MODE, CONTENT_TYPE, buildTransmission } from '../js/protocol.js';
import { Receiver } from '../js/receiver.js';
import { simulate, makeRng } from './sim.mjs';

const LIB = new URL('../arduino/RGBReceiver/', import.meta.url).pathname;
const bin = join(mkdtempSync(join(tmpdir(), 'rgbrx-')), 'host_test');
const sources = readdirSync(join(LIB, 'src'))
  .filter((f) => f.endsWith('.cpp'))
  .map((f) => join(LIB, 'src', f));
execFileSync('g++', ['-std=c++11', '-Wall', '-Wextra', '-Werror', '-O2', '-I', join(LIB, 'src'), join(LIB, 'extras/test/host_test.cpp'), ...sources, '-o', bin], {
  stdio: 'inherit',
});

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
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function runHost(lines) {
  const out = execFileSync(bin, { input: lines.join('\n') + '\n', maxBuffer: 1 << 26 }).toString();
  const messages = out
    .split('\n')
    .filter((l) => l.startsWith('MSG '))
    .map((l) => {
      const [, type, recovered, data = ''] = l.split(' ');
      return { contentType: +type, recovered: +recovered, hex: data };
    });
  const events = out.split('\n').find((l) => l.startsWith('EVENTS')) ?? '';
  return { messages, events };
}

// ---- Segment level: same input to the C++ and the JS receiver -----------------

function slotStream(tx, rounds, killFrames, rng) {
  const stream = [...tx.preamble];
  for (let r = 0; r < rounds; r++) {
    const round = Array.from(tx.round);
    if (r === 0) {
      for (const f of killFrames) {
        const start = tx.frameStarts[f];
        const end = tx.frameStarts[f + 1] ?? round.length;
        for (let i = start + 8; i < end; i++) round[i] = Math.floor(rng() * 4) + 1;
      }
    }
    stream.push(...round);
  }
  return stream;
}

function segmentCase({ data, contentType = CONTENT_TYPE.TEXT, opts, channel = {}, seed, rounds = 3, startAt = 0, killFrames = [] }) {
  const tx = buildTransmission(contentType, data, opts);
  const rng = makeRng(seed);
  const segments = simulate(slotStream(tx, rounds, killFrames, rng).slice(startAt), { T: opts.symbolMs ?? 50, ...channel }, rng);
  let jsMessage = null;
  const rx = new Receiver((m) => (jsMessage ??= m));
  for (const s of segments) rx.pushSegment(s.color, s.duration);
  const host = runHost(segments.map((s) => `S ${s.color} ${Math.round(s.duration * 1000)}`));
  return { tx, jsMessage, host };
}

const SAMPLE = 'WIFI:T:WPA;S:Workshop 2.4GHz;P:correct horse battery staple;;';

for (const mode of [MODE.ROBUST, MODE.DENSE]) {
  const name = mode === MODE.ROBUST ? 'robust' : 'dense';

  test(`arduino ${name}: clean channel, one round`, () => {
    const { host } = segmentCase({ data: enc.encode(SAMPLE), opts: { mode }, seed: 10, rounds: 1 });
    assert.equal(host.messages.length, 1, host.events);
    assert.equal(host.messages[0].hex, hex(enc.encode(SAMPLE)));
    assert.equal(host.messages[0].contentType, CONTENT_TYPE.TEXT);
  });

  test(`arduino ${name}: errors, jitter and dropped display frames (agrees with JS)`, () => {
    for (let seed = 20; seed < 30; seed++) {
      const text = enc.encode(SAMPLE.repeat(3));
      const { host, jsMessage } = segmentCase({ data: text, opts: { mode }, channel: { errorRate: 0.01, jitter: 0.15, dropRate: 0.03 }, seed, rounds: 4 });
      assert.ok(jsMessage, `JS seed ${seed}`);
      assert.ok(host.messages.length >= 1, `seed ${seed}: ${host.events}`);
      assert.equal(host.messages[0].hex, hex(text));
    }
  });

  test(`arduino ${name}: 33 ms slots with dropped frames`, () => {
    for (let seed = 30; seed < 35; seed++) {
      const text = enc.encode(SAMPLE.repeat(2));
      const { host } = segmentCase({ data: text, opts: { mode, symbolMs: 33.3 }, channel: { errorRate: 0.01, jitter: 0.15, dropRate: 0.1 }, seed, rounds: 4 });
      assert.ok(host.messages.length >= 1, `seed ${seed}: ${host.events}`);
      assert.equal(host.messages[0].hex, hex(text));
    }
  });

  test(`arduino ${name}: joins mid-transmission`, () => {
    const text = enc.encode(SAMPLE.repeat(2));
    const { host } = segmentCase({ data: text, opts: { mode }, channel: { jitter: 0.1 }, seed: 40, rounds: 2, startAt: 300 });
    assert.equal(host.messages[0]?.hex, hex(text), host.events);
  });

  test(`arduino ${name}: destroyed frame rebuilt from XOR parity in the same round`, () => {
    const text = enc.encode(SAMPLE.repeat(4));
    const { host, tx } = segmentCase({ data: text, opts: { mode }, seed: 50, rounds: 1, killFrames: [1] });
    assert.ok(tx.P >= 1);
    assert.equal(host.messages.length, 1, host.events);
    assert.equal(host.messages[0].recovered, 1);
    assert.equal(host.messages[0].hex, hex(text));
  });
}

test('arduino: binary payload, tiny chunks, no parity', () => {
  const rng = makeRng(60);
  const data = Uint8Array.from({ length: 300 }, () => Math.floor(rng() * 256));
  const { host } = segmentCase({ data, contentType: CONTENT_TYPE.BINARY, opts: { chunkSize: 16, eccT: 4, parityEvery: 0, mode: MODE.DENSE }, seed: 60, rounds: 1 });
  assert.equal(host.messages[0]?.contentType, CONTENT_TYPE.BINARY, host.events);
  assert.equal(host.messages[0].hex, hex(data));
});

test('arduino: a message switch mid-carousel delivers the new message', () => {
  const a = buildTransmission(CONTENT_TYPE.TEXT, enc.encode(SAMPLE.repeat(2)), {});
  const b = buildTransmission(CONTENT_TYPE.TEXT, enc.encode('second message'), {});
  const rng = makeRng(70);
  const slots = [...a.round.slice(0, a.frameStarts[1] + 40), ...b.round, ...b.round];
  const segs = simulate(slots, { T: 50 }, rng);
  const host = runHost(segs.map((s) => `S ${s.color} ${Math.round(s.duration * 1000)}`));
  assert.equal(host.messages.length, 1, host.events);
  assert.equal(host.messages[0].hex, hex(enc.encode('second message')));
});

test('arduino: Wi-Fi credential parser', () => {
  const cases = [
    ['WIFI:T:WPA;S:Workshop 2.4GHz;P:correct horse;;', 'WIFI Workshop 2.4GHz|correct horse|WPA|0'],
    ['WIFI:T:WPA;S:a\\;b\\:c;P:p\\\\w\\"d;H:true;;', 'WIFI a;b:c|p\\w"d|WPA|1'],
    ['WIFI:T:nopass;S:Open;;', 'WIFI Open||nopass|0'],
    ['hello', 'WIFI invalid'],
  ];
  const out = execFileSync(bin, { input: cases.map(([t]) => `W ${hex(enc.encode(t))}`).join('\n') + '\n' }).toString().split('\n');
  cases.forEach(([, want], i) => assert.equal(out[i], want));
});

// ---- Sample level: simulated sensor readings through the classifier ------------

// Sensor counts for full red, green and blue screen primaries, with crosstalk; the
// clear channel sees everything. Values are per 4.8 ms integration.
const PRIMARY = [
  [820, 110, 70],
  [160, 690, 190],
  [60, 170, 610],
];
const PALETTE_RGB = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
  [1, 0, 1],
  [1, 1, 0],
];

function sensorCase({ data, opts, seed, rounds = 2, gain = 1, ambient = [15, 18, 12], noise = 0.02, tauMs = 4, intMs = 4.8, readMs = 0.5, channel = {} }) {
  const tx = buildTransmission(CONTENT_TYPE.TEXT, data, opts);
  const rng = makeRng(seed);
  const T = opts.symbolMs ?? 50;
  const slots = slotStream(tx, rounds, [], rng);
  // Slot timeline with sender-side jitter and dropped display frames.
  const { jitter = 0.05, dropRate = 0.02, frameMs = 16.7 } = channel;
  const times = [];
  let t = 0;
  let carry = 0;
  for (const c of slots) {
    let d = T + carry + (rng() * 2 - 1) * jitter * T;
    carry = 0;
    if (rng() < dropRate) {
      d += frameMs;
      carry = -frameMs;
    }
    times.push(t);
    t += d;
  }
  const end = t;
  const gauss = () => (rng() + rng() + rng() - 1.5) * 1.15;
  const lines = [];
  const step = 0.1;
  let screen = [0, 0, 0]; // linear light per primary, follows the target with an LCD lag
  let slot = 0;
  let acc = [0, 0, 0, 0];
  let accN = 0;
  let nextRead = intMs + readMs;
  let windowStart = 0;
  for (let now = 0; now < end; now += step) {
    while (slot + 1 < times.length && times[slot + 1] <= now) slot++;
    const target = PALETTE_RGB[slots[slot]];
    const k = 1 - Math.exp(-step / tauMs);
    screen = screen.map((v, i) => v + (target[i] - v) * k);
    if (now >= windowStart && now < windowStart + intMs) {
      const counts = [0, 1, 2].map((ch) => gain * (screen[0] * PRIMARY[0][ch] + screen[1] * PRIMARY[1][ch] + screen[2] * PRIMARY[2][ch]) + ambient[ch]);
      const clear = 0.9 * (counts[0] + counts[1] + counts[2]);
      [...counts, clear].forEach((v, i) => (acc[i] += v));
      accN++;
    }
    if (now >= nextRead) {
      const vals = acc.map((v) => Math.max(0, Math.round((v / accN) * (1 + noise * gauss()))));
      lines.push(`X ${Math.round(now * 1000)} ${vals.join(' ')}`);
      acc = [0, 0, 0, 0];
      accN = 0;
      windowStart = now;
      nextRead = now + intMs + readMs;
    }
  }
  const r = runHost(lines);
  if (process.env.DEBUG) console.log(`     ${lines.length} readings, ${r.events}`);
  return r;
}

for (const mode of [MODE.ROBUST, MODE.DENSE]) {
  const name = mode === MODE.ROBUST ? 'robust' : 'dense';
  test(`arduino ${name}: raw sensor readings with LCD lag, noise and flicker-free integration`, () => {
    const text = enc.encode(SAMPLE);
    const host = sensorCase({ data: text, opts: { mode }, seed: 80 + mode });
    assert.ok(host.messages.length >= 1, host.events);
    assert.equal(host.messages[0].hex, hex(text));
  });

  test(`arduino ${name}: dim screen, more ambient light, slow LCD`, () => {
    const text = enc.encode(SAMPLE.repeat(2));
    const host = sensorCase({ data: text, opts: { mode }, seed: 90 + mode, gain: 0.3, ambient: [60, 70, 40], tauMs: 8, noise: 0.03, rounds: 3 });
    assert.ok(host.messages.length >= 1, host.events);
    assert.equal(host.messages[0].hex, hex(text));
  });
}

test('arduino robust: 33 ms slots with 2.4 ms integration', () => {
  const text = enc.encode(SAMPLE);
  const host = sensorCase({ data: text, opts: { mode: MODE.ROBUST, symbolMs: 33.3 }, seed: 100, intMs: 2.4, readMs: 0.6, rounds: 3 });
  assert.ok(host.messages.length >= 1, host.events);
  assert.equal(host.messages[0].hex, hex(text));
});

if (failures) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall Arduino library tests passed');
