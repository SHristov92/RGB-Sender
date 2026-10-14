// Three photodiodes (or phototransistors) behind red, green and blue filters, or
// a 3-channel RGB photodiode, read with analogRead(). Each channel needs its own
// load resistor or transimpedance amplifier; trim them so a white screen reads
// well below full scale on every channel. LDRs are too slow for the default speed.
#pragma once

#if defined(ARDUINO)
#include <Arduino.h>

#include "RGBSensor.h"

class AnalogRGBSensor : public RGBSensor {
 public:
  // clearPin < 0: the clear channel is reported as r + g + b.
  // inverted: the voltage falls as light rises (e.g. phototransistor to GND with a pull-up).
  AnalogRGBSensor(int8_t redPin, int8_t greenPin, int8_t bluePin, int8_t clearPin = -1, uint16_t intervalUs = 2500,
                  uint8_t oversample = 4, bool inverted = false)
      : pins_{redPin, greenPin, bluePin, clearPin},
        intervalUs_(intervalUs),
        oversample_(oversample ? oversample : 1),
        inverted_(inverted) {}

  bool begin() override;
  bool read(RGBSample &s) override;
  // analogRead() full scale: 1023 on AVR, 4095 on ESP32 / 12-bit ADCs (only used when inverted).
  void setFullScale(uint16_t fullScale) { fullScale_ = fullScale; }

 private:
  uint16_t readPin(int8_t pin);

  int8_t pins_[4];
  uint16_t intervalUs_;
  uint8_t oversample_;
  bool inverted_;
  uint32_t lastUs_ = 0;
  uint16_t fullScale_ = 1023;
};
#endif
