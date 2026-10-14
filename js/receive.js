import { Receiver } from './receiver.js';
import { ChannelClassifier, Segmenter } from './sampler.js';
import { PALETTE, CONTENT_TYPE, FRAME_TYPE } from './protocol.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = document.createElement('canvas');
const SAMPLE_PX = 24;
canvas.width = canvas.height = SAMPLE_PX;
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const CSS_COLORS = PALETTE.map(({ rgb }) => `rgb(${rgb.join(',')})`);
const CONTENT_NAMES = { [CONTENT_TYPE.BINARY]: 'Binary', [CONTENT_TYPE.TEXT]: 'Text', [CONTENT_TYPE.WIFI]: 'Wi‑Fi credentials', [CONTENT_TYPE.JSON]: 'JSON' };

let stream = null;
let frameHandle = 0;
let rx;
let classifier;
let segmenter;
let stats;
let lastMessage = null;
let clock = null; // which timestamp source the camera gives us, fixed on the first frame

function log(text) {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  const list = $('log');
  list.prepend(li);
  while (list.children.length > 60) list.lastChild.remove();
}

function resetDecoder() {
  classifier = new ChannelClassifier();
  stats = { frames: 0, failed: 0, corrected: 0, samples: 0, firstT: null, lastT: null, frameIntervals: [] };
  rx = new Receiver(onMessage, onEvent);
  segmenter = new Segmenter(
    (color, duration) => rx.pushSegment(color, duration),
    () => {
      // A glitch is at most about one camera frame that straddled two colours.
      const T = rx.frames.estimatedT;
      return T ? Math.min(0.45 * T, 1.2 * cameraFrameMs()) : 0;
    },
  );
  $('progress-bar').style.width = '0';
}

function cameraFrameMs() {
  const d = [...stats.frameIntervals].sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)] : 33;
}

function onEvent(e) {
  if (e.type === 'frame') {
    const f = e.frame;
    stats.frames++;
    stats.corrected += f.corrected;
    const kind = f.type === FRAME_TYPE.DATA ? `data ${f.index + 1}/${f.K}` : `parity ${f.index + 1}/${f.P}`;
    log(`frame OK: ${kind}, ${f.corrected} byte(s) corrected`);
    const { have, total } = rx.assembler.progress;
    $('progress-bar').style.width = `${(100 * have) / total}%`;
  } else if (e.type === 'sync') {
    log(`sync, symbol time ${e.T.toFixed(0)} ms`);
  } else if (e.type === 'header-failed' || e.type === 'body-failed') {
    stats.failed++;
    log(e.type === 'header-failed' ? 'frame lost: header unreadable' : 'frame lost: too many errors in body');
  } else if (e.type === 'calibration-mismatch') {
    stats.failed++;
    log(`frame lost: colour check failed (${e.calErrors} wrong)`);
  } else if (e.type === 'frame-aborted') {
    log('frame interrupted by a new sync');
  }
}

function onMessage(m) {
  lastMessage = m;
  $('progress-bar').style.width = '100%';
  log(`message complete: ${m.data.length} bytes${m.recovered ? `, ${m.recovered} frame(s) rebuilt from parity` : ''}`);
  showResult(m);
  navigator.vibrate?.(200);
}

function parseWifi(s) {
  const fields = {};
  const body = s.replace(/^WIFI:/, '');
  const re = /([A-Z]):((?:\\.|[^;])*);/g;
  let m;
  while ((m = re.exec(body))) fields[m[1]] = m[2].replace(/\\(.)/g, '$1');
  return fields;
}

function showResult(m) {
  const rows = [
    ['Type', CONTENT_NAMES[m.contentType] ?? `Type ${m.contentType}`],
    ['Size', `${m.data.length} bytes`],
  ];
  let text;
  if (m.contentType === CONTENT_TYPE.BINARY || m.contentType >= 4) {
    text = Array.from(m.data.subarray(0, 512), (b) => b.toString(16).padStart(2, '0')).join(' ');
    if (m.data.length > 512) text += ' …';
  } else {
    text = new TextDecoder().decode(m.data);
    if (m.contentType === CONTENT_TYPE.WIFI) {
      const w = parseWifi(text);
      rows.push(['Network', w.S ?? '?'], ['Password', w.P ?? '(none)'], ['Security', w.T ?? '?']);
    } else if (m.contentType === CONTENT_TYPE.JSON) {
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        rows.push(['Note', 'not valid JSON']);
      }
    }
  }
  $('result-meta').replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }),
  );
  $('result-text').textContent = text;
  $('result').hidden = false;
}

// ---- Camera ------------------------------------------------------------------------

function roiFraction() {
  return Number($('roi-size').value) / 100;
}

function layoutRoi() {
  const box = video.parentElement.getBoundingClientRect();
  const side = roiFraction() * Math.min(box.width, box.height);
  $('roi').style.width = $('roi').style.height = `${side}px`;
  $('roi-label').textContent = `${$('roi-size').value}%`;
}

// Average colour of the centre square that the on-screen box marks.
function sampleRoi() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const box = video.getBoundingClientRect();
  const scale = Math.max(box.width / vw, box.height / vh); // object-fit: cover
  const side = (roiFraction() * Math.min(box.width, box.height)) / scale;
  ctx.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, SAMPLE_PX, SAMPLE_PX);
  const px = ctx.getImageData(0, 0, SAMPLE_PX, SAMPLE_PX).data;
  const sum = [0, 0, 0];
  for (let i = 0; i < px.length; i += 4) {
    sum[0] += px[i];
    sum[1] += px[i + 1];
    sum[2] += px[i + 2];
  }
  const n = px.length / 4;
  return sum.map((s) => s / n);
}

function frameTime(now, meta) {
  if (!clock) clock = meta?.captureTime ? 'capture' : meta?.mediaTime ? 'media' : 'now';
  if (clock === 'capture' && meta?.captureTime) return meta.captureTime;
  if (clock === 'media' && meta?.mediaTime) return meta.mediaTime * 1000;
  return now;
}

function onVideoFrame(now, meta) {
  const t = frameTime(now, meta);
  if (stats.lastT !== null && t > stats.lastT) {
    stats.frameIntervals.push(t - stats.lastT);
    if (stats.frameIntervals.length > 60) stats.frameIntervals.shift();
  }
  if (stats.lastT === null || t > stats.lastT) {
    stats.lastT = t;
    const rgb = sampleRoi();
    if (rgb) {
      stats.samples++;
      const color = classifier.classify(t, rgb);
      segmenter.push(t, color);
      updateLive(rgb, color);
    }
  }
  scheduleFrame();
}

function scheduleFrame() {
  if (!stream) return;
  if (video.requestVideoFrameCallback) frameHandle = video.requestVideoFrameCallback(onVideoFrame);
  else frameHandle = requestAnimationFrame((now) => onVideoFrame(now, null));
}

let lastLiveUpdate = 0;
function updateLive(rgb, color) {
  $('sample-swatch').style.background = `rgb(${rgb.map(Math.round).join(',')})`;
  $('class-swatch').style.background = color === null ? 'transparent' : CSS_COLORS[color];
  const now = performance.now();
  if (now - lastLiveUpdate < 250) return;
  lastLiveUpdate = now;
  const fps = 1000 / cameraFrameMs();
  const T = rx.frames.estimatedT;
  const { have, total } = rx.assembler.progress;
  const state = { hunt: 'looking for a frame start', sync: 'frame start seen', frame: 'reading a frame' }[rx.frames.state];
  const rows = [
    ['Camera', `${fps.toFixed(0)} fps`],
    ['Colour', color === null ? '(between colours)' : PALETTE[color].name],
    ['Symbol', T ? `${T.toFixed(0)} ms, ${(T / cameraFrameMs()).toFixed(1)} camera frames` : '…'],
    ['State', state],
    ['Frames', `${stats.frames} OK, ${stats.failed} lost, ${stats.corrected} bytes corrected`],
    ['Message', total ? `${have} of ${total} chunks` : '…'],
  ];
  if (T && T / cameraFrameMs() < 2.5) rows.push(['Warning', 'symbols too short for this camera; slow the sender down']);
  $('live-stats').replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }),
  );
}

// Fixed exposure and white balance keep colours stable; not every browser allows it.
async function lockCamera(track) {
  const caps = track.getCapabilities?.() ?? {};
  const advanced = {};
  if (caps.exposureMode?.includes('manual')) advanced.exposureMode = 'manual';
  if (caps.whiteBalanceMode?.includes('manual')) advanced.whiteBalanceMode = 'manual';
  if (caps.focusMode?.includes('manual')) advanced.focusMode = 'manual';
  if (!Object.keys(advanced).length) return;
  try {
    await track.applyConstraints({ advanced: [advanced] });
    log(`locked ${Object.keys(advanced).join(', ')}`);
  } catch {
    // Keep automatic settings.
  }
}

async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const select = $('camera-select');
  const current = select.value;
  select.replaceChildren(new Option('Rear camera (default)', ''));
  devices
    .filter((d) => d.kind === 'videoinput')
    .forEach((d, i) => select.add(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
  select.value = current;
}

async function startCamera() {
  stopCamera();
  const deviceId = $('camera-select').value;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' }),
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 60 },
      },
    });
  } catch (e) {
    log(`camera unavailable: ${e.message}`);
    stream = null;
    return;
  }
  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings();
  log(`camera on: ${settings.width}×${settings.height} at ${settings.frameRate ?? '?'} fps`);
  await lockCamera(track);
  video.srcObject = stream;
  await video.play();
  $('placeholder').hidden = true;
  $('cam-start').textContent = 'Stop camera';
  clock = null;
  resetDecoder();
  layoutRoi();
  scheduleFrame();
  listCameras();
}

function stopCamera() {
  if (!stream) return;
  if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameHandle);
  cancelAnimationFrame(frameHandle);
  for (const t of stream.getTracks()) t.stop();
  stream = null;
  video.srcObject = null;
  $('placeholder').hidden = false;
  $('cam-start').textContent = 'Start camera';
}

$('cam-start').addEventListener('click', () => (stream ? stopCamera() : startCamera()));
$('camera-select').addEventListener('change', () => stream && startCamera());
$('roi-size').addEventListener('input', layoutRoi);
window.addEventListener('resize', layoutRoi);
$('reset').addEventListener('click', () => {
  resetDecoder();
  $('result').hidden = true;
  log('decoder reset');
});
$('copy').addEventListener('click', () => navigator.clipboard?.writeText($('result-text').textContent));
$('download').addEventListener('click', () => {
  if (!lastMessage) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lastMessage.data]));
  a.download = lastMessage.contentType === CONTENT_TYPE.BINARY ? 'received.bin' : 'received.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

resetDecoder();
layoutRoi();
if (!navigator.mediaDevices?.getUserMedia) log('this browser has no camera access (it needs HTTPS or localhost)');
