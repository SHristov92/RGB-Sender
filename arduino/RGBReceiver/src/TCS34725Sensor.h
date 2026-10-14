// Driver for the AMS/ams-OSRAM TCS34725 colour sensor (I2C address 0x29), tuned
// for the RGB Sender link: short integration, a reading every cycle, no blocking.
// Switch the breakout's white LED off (tie its LED pin to GND).
#pragma once

#if defined(ARDUINO)
#include <Arduino.h>
#include <Wire.h>

#include "RGBSensor.h"

class TCS34725Sensor : public RGBSensor {
 public:
  enum Gain : uint8_t { GAIN_1X = 0, GAIN_4X = 1, GAIN_16X = 2, GAIN_60X = 3 };

  // atime: integration time is (256 - atime) x 2.4 ms. 0xFE (4.8 ms, ~200
  // readings/s) suits the default 50 ms slots and averages out OLED flicker; use
  // 0xFF (2.4 ms) for 33 ms slots. Pick the gain so a white screen reads 30-80 %
  // of full scale (the SensorTest example prints it).
  explicit TCS34725Sensor(TwoWire &wire = Wire, uint8_t atime = 0xFE, Gain gain = GAIN_4X)
      : wire_(wire), atime_(atime), gain_(gain) {}

  bool begin() override;
  bool read(RGBSample &s) override;

  void setGain(Gain gain);
  void setIntegration(uint8_t atime);
  uint16_t fullScale() const;  // maximum count at the current integration time
  uint32_t integrationUs() const { return (uint32_t)(256 - atime_) * 2400UL; }

 private:
  void write8(uint8_t reg, uint8_t value);
  bool read8(uint8_t reg, uint8_t &value);

  TwoWire &wire_;
  uint8_t atime_;
  Gain gain_;
  uint32_t lastUs_ = 0;
};
#endif
