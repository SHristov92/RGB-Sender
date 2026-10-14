// Turns raw sensor readings into palette colours (SPEC 3.3): normalise by the
// black and white references, then pick the nearest calibrated colour.
//
// Before the first frame has been calibrated it uses the running minimum and
// maximum of each channel as black and white and ideal colours (each of r, g, b
// either off or full), which is enough to find a sync and read the CAL sequence.
#pragma once

#include "RGBProtocol.h"
#include "RGBSensor.h"

class RGBClassifier {
 public:
  RGBClassifier() { reset(); }

  // Forgets all calibration (min/max restart from the next sample).
  void reset();
  // Tracks the running min/max; call for every sample.
  void observe(const RGBSample &s);
  // Nearest colour among palette indices 0 .. paletteSize-1, or RGB_NONE when the
  // sample is ambiguous (nearest and second nearest within 20 %) or there is no
  // black/white contrast yet.
  uint8_t classify(const RGBSample &s, uint8_t paletteSize = RGB_PALETTE_SIZE) const;

  // Calibration: stage a reference for a colour, then commit or discard the set.
  void stage(uint8_t color, const RGBSample &mean);
  void commit();
  void discard() { stageMask_ = 0; }

  bool calibrated() const { return (mask_ & 0x11) == 0x11; }  // K and W known
  uint8_t calibratedMask() const { return mask_; }
  // Raw reference for a colour (calibrated, or black/white estimate for K/W).
  RGBSample reference(uint8_t color) const;

 private:
  void normalise(const uint16_t *raw, int16_t *out, const uint16_t *black, const uint16_t *white) const;
  void updateNorm();

  uint16_t ref_[RGB_PALETTE_SIZE][4];
  int16_t norm_[RGB_PALETTE_SIZE][4];
  uint8_t mask_;
  uint16_t stage_[RGB_PALETTE_SIZE][4];
  uint8_t stageMask_;
  uint16_t lo_[4], hi_[4];
  bool seen_;
};
