#if defined(ARDUINO)
#include "AnalogRGBSensor.h"

bool AnalogRGBSensor::begin() {
  for (uint8_t i = 0; i < 4; i++)
    if (pins_[i] >= 0) pinMode(pins_[i], INPUT);
  lastUs_ = micros();
  return true;
}

uint16_t AnalogRGBSensor::readPin(int8_t pin) {
  uint32_t sum = 0;
  for (uint8_t i = 0; i < oversample_; i++) {
    uint16_t v = analogRead(pin);
    sum += inverted_ ? (fullScale_ - v) : v;
  }
  return (uint16_t)(sum * 16 / oversample_);  // scale up so averaging keeps its resolution
}

bool AnalogRGBSensor::read(RGBSample &s) {
  uint32_t now = micros();
  if (now - lastUs_ < intervalUs_) return false;
  lastUs_ = now;
  s.r = readPin(pins_[0]);
  s.g = readPin(pins_[1]);
  s.b = readPin(pins_[2]);
  if (pins_[3] >= 0) {
    s.c = readPin(pins_[3]);
  } else {
    uint32_t c = (uint32_t)s.r + s.g + s.b;
    s.c = c > 65535UL ? 65535 : (uint16_t)c;
  }
  return true;
}
#endif
