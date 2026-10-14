// Sensor interface. A sensor delivers raw (r, g, b, c) readings; the receiver
// timestamps them, calibrates against the sender's CAL sequence and classifies them.
#pragma once

#include <stdint.h>

struct RGBSample {
  uint16_t r, g, b;
  uint16_t c;  // clear / total channel; sensors without one can report r + g + b
};

class RGBSensor {
 public:
  virtual bool begin() = 0;
  // Non-blocking. Returns true and fills `s` when a new reading is ready.
  // Aim for at least 7 readings per slot (>= 140/s at the default 50 ms slots).
  virtual bool read(RGBSample &s) = 0;
};
