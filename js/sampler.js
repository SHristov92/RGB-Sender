// Sample front end for receivers that see raw RGB values (camera, or a sensor
// without per-colour calibration): classify each sample into a palette colour
// and merge samples into the (colour, duration) segments js/receiver.js expects.
//
// The palette is exactly the 8 on/off combinations of R, G and B, so a sample is
// classified by thresholding each channel halfway between the darkest and
// brightest values that channel showed recently. That adapts to white balance,
// exposure and screen brightness without needing calibration.

const CHANNEL_TO_COLOR = [0, 3, 2, 5, 1, 6, 7, 4]; // index = r<<2 | g<<1 | b → K B G C R M Y W

export class ChannelClassifier {
  constructor({ windowMs = 4000, minRange = 30, ambiguity = 0.12 } = {}) {
    this.windowMs = windowMs;
    this.minRange = minRange; // smaller channel swings than this are noise, not signal
    this.ambiguity = ambiguity; // half-width of the "can't tell" band around the threshold
    this.history = [];
    this.last = null;
  }

  // Returns a palette index, or null when the sample is mid-transition or there is no signal yet.
  classify(t, rgb) {
    this.history.push({ t, rgb });
    while (this.history.length && this.history[0].t < t - this.windowMs) this.history.shift();
    const lo = [255, 255, 255];
    const hi = [0, 0, 0];
    for (const { rgb: v } of this.history) {
      for (let c = 0; c < 3; c++) {
        if (v[c] < lo[c]) lo[c] = v[c];
        if (v[c] > hi[c]) hi[c] = v[c];
      }
    }
    let bits = 0;
    let ambiguous = false;
    const levels = [];
    for (let c = 0; c < 3; c++) {
      const range = hi[c] - lo[c];
      if (range < this.minRange) {
        this.last = { lo, hi, levels: null, color: null };
        return null;
      }
      const x = (rgb[c] - lo[c]) / range;
      levels.push(x);
      if (Math.abs(x - 0.5) < this.ambiguity) ambiguous = true;
      if (x >= 0.5) bits |= 4 >> c;
    }
    const color = ambiguous ? null : CHANNEL_TO_COLOR[bits];
    this.last = { lo, hi, levels, color };
    return color;
  }
}

// Merges classified samples into segments. Unclassifiable samples extend the
// current run; runs shorter than the glitch limit (camera frames that straddle
// two colours) are folded into their neighbours.
export class Segmenter {
  constructor(onSegment, glitchMs = () => 0) {
    this.onSegment = onSegment;
    this.glitchMs = glitchMs;
    this.current = null; // { color, start }
    this.pending = null; // last closed run, held back one step so a glitch can merge into it
  }

  push(t, color) {
    if (color === null || color === undefined) return;
    if (!this.current) {
      this.current = { color, start: t };
      return;
    }
    if (color === this.current.color) return;
    const closed = { color: this.current.color, duration: t - this.current.start };
    if (closed.duration < this.glitchMs()) {
      if (this.pending) this.pending.duration += closed.duration;
      if (this.pending && this.pending.color === color) {
        // A-glitch-A: the glitch was noise inside one run.
        this.current = { color, start: t - this.pending.duration };
        this.pending = null;
        return;
      }
    } else {
      if (this.pending) this.onSegment(this.pending.color, this.pending.duration);
      this.pending = closed;
    }
    this.current = { color, start: t };
  }
}
