import { buildTransmission, CONTENT_TYPE, MODE_INFO, PALETTE, DEFAULTS } from './protocol.js';

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const CSS_COLORS = PALETTE.map(({ rgb }) => `rgb(${rgb.join(',')})`);

const state = {
  tab: 'text',
  fileBytes: null,
  tx: null,
  frameMs: 1000 / 60,
};

// ---- Message input ------------------------------------------------------------

function escapeWifi(s) {
  return s.replace(/([\;,:"])/g, '\\$1');
}

function currentPayload() {
  if (state.tab === 'text') {
    const type = $('text-json').checked ? CONTENT_TYPE.JSON : CONTENT_TYPE.TEXT;
    return { type, data: enc.encode($('text-input').value) };
  }
  if (state.tab === 'wifi') {
    const ssid = $('wifi-ssid').value;
    if (!ssid) throw new Error('Enter the network name.');
    const sec = $('wifi-sec').value;
    let s = `WIFI:T:${sec};S:${escapeWifi(ssid)};`;
    if (sec !== 'nopass') s += `P:${escapeWifi($('wifi-pass').value)};`;
    if ($('wifi-hidden').checked) s += 'H:true;';
    return { type: CONTENT_TYPE.WIFI, data: enc.encode(s + ';') };
  }
  if (!state.fileBytes) throw new Error('Choose a file.');
  return { type: CONTENT_TYPE.BINARY, data: state.fileBytes };
}

function currentOptions() {
  return {
    mode: Number($('opt-mode').value),
    symbolMs: Number($('opt-symbol').value),
    chunkSize: Number($('opt-chunk').value),
    eccT: Number($('opt-ecc').value),
    parityEvery: Number($('opt-parity').value),
    preamblePairs: Number($('opt-preamble').value),
  };
}

// Symbol time snapped to whole display frames so every symbol shows for the same number of frames.
function symbolPeriod(symbolMs) {
  return Math.max(1, Math.round(symbolMs / state.frameMs)) * state.frameMs;
}

function formatDuration(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

function rebuild() {
  const error = $('error');
  const summary = $('summary');
  try {
    const { type, data } = currentPayload();
    const opts = currentOptions();
    const tx = buildTransmission(type, data, opts);
    const T = symbolPeriod(opts.symbolMs);
    tx.T = T;
    state.tx = tx;
    const roundMs = tx.round.length * T;
    const bitsPerSymbol = 8 / MODE_INFO[tx.mode].spb;
    const rows = [
      ['Payload', `${data.length} bytes (${tx.envelope.length} with envelope)`],
      ['Frames', `${tx.K} data + ${tx.P} parity, ${tx.L} bytes each`],
      ['Protection', `Reed–Solomon fixes ${tx.t} bad bytes per frame; ${tx.P ? `any 1 lost frame per parity group is rebuilt` : 'no parity frames'}`],
      ['Symbol', `${T.toFixed(1)} ms, ${bitsPerSymbol.toFixed(2)} bits (${(bitsPerSymbol * 1000 / T).toFixed(0)} bit/s raw)`],
      ['One full round', `${tx.round.length} symbols, ${formatDuration(roundMs)}`],
      ['Effective rate', `${((data.length / roundMs) * 1000).toFixed(1)} bytes/s`],
    ];
    summary.replaceChildren(
      ...rows.flatMap(([k, v]) => {
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = v;
        return [dt, dd];
      }),
    );
    error.hidden = true;
    $('start').disabled = false;
    $('preview').disabled = false;
  } catch (e) {
    state.tx = null;
    summary.replaceChildren();
    error.textContent = e.message;
    error.hidden = false;
    $('start').disabled = true;
    $('preview').disabled = true;
  }
}

// ---- Playback -------------------------------------------------------------------

// Plays slots against the display clock. The slot shown is chosen from elapsed time, not
// by counting callbacks, so a dropped frame lengthens one symbol and the next catches up.
class Player {
  constructor(paint, onTick) {
    this.paint = paint;
    this.onTick = onTick;
    this.raf = 0;
    this.lastColor = -1;
  }

  start(slotAt, T) {
    this.stop();
    this.slotAt = slotAt;
    this.T = T;
    this.t0 = null;
    this.lastColor = -1;
    const step = (ts) => {
      if (this.t0 === null) this.t0 = ts;
      const slot = Math.floor((ts - this.t0 + state.frameMs / 2) / this.T);
      const color = this.slotAt(slot);
      if (color !== this.lastColor) {
        this.paint(color);
        this.lastColor = color;
      }
      this.onTick?.(slot);
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}

function transmissionSlotAt(tx) {
  const pre = tx.preamble.length;
  return (slot) => (slot < pre ? tx.preamble[slot] : tx.round[(slot - pre) % tx.round.length]);
}

function describeSlot(tx, slot) {
  const pre = tx.preamble.length;
  if (slot < pre) return 'lead-in';
  const inRound = (slot - pre) % tx.round.length;
  const round = Math.floor((slot - pre) / tx.round.length) + 1;
  let f = 0;
  while (f + 1 < tx.frameStarts.length && tx.frameStarts[f + 1] <= inRound) f++;
  const label = f < tx.K ? `data ${f + 1}/${tx.K}` : `parity ${f - tx.K + 1}/${tx.P}`;
  return `round ${round} · frame ${label}`;
}

function measureFrameRate() {
  return new Promise((resolve) => {
    const stamps = [];
    const step = (ts) => {
      stamps.push(ts);
      if (stamps.length < 40) requestAnimationFrame(step);
      else {
        const deltas = stamps.slice(1).map((t, i) => t - stamps[i]).sort((a, b) => a - b);
        resolve(deltas[Math.floor(deltas.length / 2)]);
      }
    };
    requestAnimationFrame(step);
  });
}

let wakeLock = null;
async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    wakeLock = null;
  }
}

const stage = $('stage');
const hud = $('hud');
const stagePlayer = new Player((c) => {
  stage.style.background = CSS_COLORS[c];
});

async function enterStage() {
  stage.hidden = false;
  stage.style.background = '#000';
  hud.textContent = 'measuring display…';
  try {
    await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
  } catch {
    // Fullscreen is optional (e.g. iPhone Safari); the stage already covers the viewport.
  }
  await keepAwake();
  state.frameMs = await measureFrameRate();
}

function leaveStage() {
  stagePlayer.stop();
  stage.hidden = true;
  wakeLock?.release?.();
  wakeLock = null;
  if (document.fullscreenElement) document.exitFullscreen?.();
  rebuild();
}

async function startSending() {
  if (!state.tx) return;
  stopPreview();
  await enterStage();
  rebuild(); // re-snap the symbol time to the measured refresh rate
  const tx = state.tx;
  if (!tx || stage.hidden) return;
  let lastLabel = '';
  stagePlayer.onTick = (slot) => {
    const label = `${describeSlot(tx, slot)} · tap to stop`;
    if (label !== lastLabel) hud.textContent = lastLabel = label;
  };
  stagePlayer.start(transmissionSlotAt(tx), tx.T);
}

async function startTestPattern() {
  stopPreview();
  await enterStage();
  if (stage.hidden) return;
  const order = [0, 1, 2, 3, 4, 5, 6, 7];
  const T = 1000;
  stagePlayer.onTick = (slot) => {
    hud.textContent = `test pattern · ${PALETTE[order[slot % order.length]].name} (index ${order[slot % order.length]}) · tap to stop`;
  };
  stagePlayer.start((slot) => order[slot % order.length], T);
}

stage.addEventListener('click', leaveStage);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !stage.hidden) leaveStage();
});
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && !stage.hidden) leaveStage();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !stage.hidden) keepAwake();
});

// ---- Preview ------------------------------------------------------------------------

const previewPlayer = new Player((c) => {
  $('preview-swatch').style.background = CSS_COLORS[c];
});

function stopPreview() {
  previewPlayer.stop();
  $('preview-box').hidden = true;
  $('preview').textContent = 'Preview';
}

function togglePreview() {
  if (!$('preview-box').hidden) {
    stopPreview();
    return;
  }
  const tx = state.tx;
  if (!tx) return;
  $('preview-box').hidden = false;
  $('preview').textContent = 'Stop preview';
  previewPlayer.onTick = (slot) => {
    $('preview-info').textContent = describeSlot(tx, slot);
  };
  previewPlayer.start(transmissionSlotAt(tx), tx.T);
}

// ---- Wiring -------------------------------------------------------------------------

for (const btn of document.querySelectorAll('[role="tab"]')) {
  btn.addEventListener('click', () => {
    state.tab = btn.dataset.tab;
    for (const b of document.querySelectorAll('[role="tab"]')) b.setAttribute('aria-selected', String(b === btn));
    for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.dataset.panel !== state.tab;
    stopPreview();
    rebuild();
  });
}

for (const el of document.querySelectorAll('input, textarea, select')) {
  if (el.type === 'file') continue;
  el.addEventListener('input', () => {
    stopPreview();
    rebuild();
  });
}

$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  state.fileBytes = file ? new Uint8Array(await file.arrayBuffer()) : null;
  $('file-info').textContent = file ? `${file.name}, ${file.size} bytes` : 'No file chosen.';
  stopPreview();
  rebuild();
});

$('start').addEventListener('click', startSending);
$('test-pattern').addEventListener('click', startTestPattern);
$('preview').addEventListener('click', togglePreview);

$('opt-symbol').value = String(DEFAULTS.symbolMs);
rebuild();
