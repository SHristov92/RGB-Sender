// Renders symbol slots as a camera would see them: frames at a fixed rate, each
// averaging the screen over its exposure window, with colour cast, gain and noise.
import { PALETTE } from '../js/protocol.js';

export function* cameraFrames(slots, opts, rng) {
  const { T = 100, fps = 30, exposureMs = 20, tint = [1, 0.85, 1.1], black = 25, gain = 0.8, noise = 6, phase = 0 } = opts;
  const total = slots.length * T;
  const frameMs = 1000 / fps;
  for (let t = phase; t + exposureMs < total; t += frameMs) {
    const acc = [0, 0, 0];
    const steps = 8;
    for (let k = 0; k < steps; k++) {
      const slot = slots[Math.floor((t + (k + 0.5) * (exposureMs / steps)) / T)];
      const rgb = PALETTE[slot].rgb;
      for (let c = 0; c < 3; c++) acc[c] += rgb[c] / steps;
    }
    const out = acc.map((v, c) => {
      const x = black + v * gain * tint[c] + (rng() * 2 - 1) * noise;
      return Math.max(0, Math.min(255, x));
    });
    yield { t, rgb: out };
  }
}
