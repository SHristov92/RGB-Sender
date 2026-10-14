#include "RGBClassifier.h"

#include <string.h>

static const int16_t ONE = 256;        // normalised full scale
static const uint16_t MIN_SPAN = 16;   // counts between black and white before we trust them
static const int32_t BIG = 0x7FFFFFFF;

// Which of r, g, b each palette colour lights up.
static const uint8_t PALETTE_RGB[RGB_PALETTE_SIZE] = {0x0, 0x4, 0x2, 0x1, 0x7, 0x3, 0x5, 0x6};

static inline void toArray(const RGBSample &s, uint16_t *a) {
  a[0] = s.r;
  a[1] = s.g;
  a[2] = s.b;
  a[3] = s.c;
}

void RGBClassifier::reset() {
  mask_ = 0;
  stageMask_ = 0;
  seen_ = false;
  updateNorm();
}

void RGBClassifier::observe(const RGBSample &s) {
  uint16_t a[4];
  toArray(s, a);
  for (uint8_t ch = 0; ch < 4; ch++) {
    if (!seen_ || a[ch] < lo_[ch]) lo_[ch] = a[ch];
    if (!seen_ || a[ch] > hi_[ch]) hi_[ch] = a[ch];
  }
  seen_ = true;
}

void RGBClassifier::normalise(const uint16_t *raw, int16_t *out, const uint16_t *black, const uint16_t *white) const {
  for (uint8_t ch = 0; ch < 4; ch++) {
    int32_t span = (int32_t)white[ch] - black[ch];
    if (span < 1) span = 1;
    int32_t v = ((int32_t)raw[ch] - black[ch]) * ONE / span;
    if (v < -4 * ONE) v = -4 * ONE;
    if (v > 4 * ONE) v = 4 * ONE;
    out[ch] = (int16_t)v;
  }
}

void RGBClassifier::updateNorm() {
  for (uint8_t i = 0; i < RGB_PALETTE_SIZE; i++) {
    if (calibrated() && (mask_ & (1 << i))) {
      normalise(ref_[i], norm_[i], ref_[RGB_K], ref_[RGB_W]);
    } else {
      // Ideal colour: channel fully on or off; clear in proportion.
      uint8_t bits = PALETTE_RGB[i];
      norm_[i][0] = (bits & 4) ? ONE : 0;
      norm_[i][1] = (bits & 2) ? ONE : 0;
      norm_[i][2] = (bits & 1) ? ONE : 0;
      norm_[i][3] = (int16_t)(ONE * (((bits >> 2) & 1) + ((bits >> 1) & 1) + (bits & 1)) / 3);
    }
  }
}

uint8_t RGBClassifier::classify(const RGBSample &s, uint8_t paletteSize) const {
  const uint16_t *black, *white;
  bool cal = calibrated();
  if (cal) {
    black = ref_[RGB_K];
    white = ref_[RGB_W];
  } else {
    if (!seen_) return RGB_NONE;
    black = lo_;
    white = hi_;
  }
  for (uint8_t ch = 0; ch < 3; ch++)
    if (white[ch] < black[ch] + MIN_SPAN) return RGB_NONE;

  uint16_t raw[4];
  toArray(s, raw);
  int16_t x[4];
  normalise(raw, x, black, white);
  // The clear channel only joins the distance once real references exist.
  uint8_t channels = cal ? 4 : 3;

  int32_t best = BIG, second = BIG;
  uint8_t bestColor = RGB_NONE;
  for (uint8_t i = 0; i < paletteSize && i < RGB_PALETTE_SIZE; i++) {
    int32_t d = 0;
    for (uint8_t ch = 0; ch < channels; ch++) {
      int32_t e = (int32_t)x[ch] - norm_[i][ch];
      d += e * e;
    }
    if (d < best) {
      second = best;
      best = d;
      bestColor = i;
    } else if (d < second) {
      second = d;
    }
  }
  // Ambiguous when the two nearest distances are within 20 % (compare squares: 0.8^2 = 16/25).
  if (second != BIG && best * 25 > second * 16 && best > (int32_t)ONE * ONE / 64) return RGB_NONE;
  return bestColor;
}

void RGBClassifier::stage(uint8_t color, const RGBSample &mean) {
  if (color >= RGB_PALETTE_SIZE) return;
  toArray(mean, stage_[color]);
  stageMask_ |= 1 << color;
}

void RGBClassifier::commit() {
  // Only accept a set that includes black and white, which every other colour is relative to.
  if ((stageMask_ & 0x11) != 0x11) {
    stageMask_ = 0;
    return;
  }
  for (uint8_t i = 0; i < RGB_PALETTE_SIZE; i++) {
    if (!(stageMask_ & (1 << i))) continue;
    for (uint8_t ch = 0; ch < 4; ch++) {
      // Exponential average across frames (weight 1/4 for the new reading).
      ref_[i][ch] = (mask_ & (1 << i)) ? (uint16_t)(((uint32_t)ref_[i][ch] * 3 + stage_[i][ch] + 2) / 4) : stage_[i][ch];
    }
    mask_ |= 1 << i;
  }
  stageMask_ = 0;
  updateNorm();
}

RGBSample RGBClassifier::reference(uint8_t color) const {
  RGBSample s = {0, 0, 0, 0};
  const uint16_t *a = nullptr;
  if (color < RGB_PALETTE_SIZE && (mask_ & (1 << color))) a = ref_[color];
  else if (color == RGB_K && seen_) a = lo_;
  else if (color == RGB_W && seen_) a = hi_;
  if (a) {
    s.r = a[0];
    s.g = a[1];
    s.b = a[2];
    s.c = a[3];
  }
  return s;
}
