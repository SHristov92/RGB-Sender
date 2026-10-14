#if defined(ARDUINO)
#include "TCS34725Sensor.h"

static const uint8_t ADDR = 0x29;
static const uint8_t CMD = 0x80;
static const uint8_t CMD_AUTOINC = 0xA0;
static const uint8_t CMD_CLEAR_INT = 0xE6;
static const uint8_t REG_ENABLE = 0x00, REG_ATIME = 0x01, REG_PERS = 0x0C, REG_CONFIG = 0x0D, REG_CONTROL = 0x0F,
                     REG_ID = 0x12, REG_STATUS = 0x13, REG_CDATAL = 0x14;
static const uint8_t ENABLE_PON = 0x01, ENABLE_AEN = 0x02, ENABLE_AIEN = 0x10;
static const uint8_t STATUS_AINT = 0x10;

void TCS34725Sensor::write8(uint8_t reg, uint8_t value) {
  wire_.beginTransmission(ADDR);
  wire_.write(CMD | reg);
  wire_.write(value);
  wire_.endTransmission();
}

bool TCS34725Sensor::read8(uint8_t reg, uint8_t &value) {
  wire_.beginTransmission(ADDR);
  wire_.write(CMD | reg);
  if (wire_.endTransmission() != 0) return false;
  if (wire_.requestFrom(ADDR, (uint8_t)1) != 1) return false;
  value = wire_.read();
  return true;
}

bool TCS34725Sensor::begin() {
  uint8_t id;
  if (!read8(REG_ID, id)) return false;
  if (id != 0x44 && id != 0x4D && id != 0x10) return false;  // TCS34721/5, TCS34723/7, some clones
  write8(REG_ENABLE, ENABLE_PON);
  delay(3);
  write8(REG_ATIME, atime_);
  write8(REG_CONFIG, 0x00);  // no long wait
  write8(REG_CONTROL, gain_);
  // Interrupt flag on every integration cycle: STATUS.AINT marks a fresh reading.
  write8(REG_PERS, 0x00);
  write8(REG_ENABLE, ENABLE_PON | ENABLE_AEN | ENABLE_AIEN);
  lastUs_ = micros();
  return true;
}

void TCS34725Sensor::setGain(Gain gain) {
  gain_ = gain;
  write8(REG_CONTROL, gain_);
}

void TCS34725Sensor::setIntegration(uint8_t atime) {
  atime_ = atime;
  write8(REG_ATIME, atime_);
}

uint16_t TCS34725Sensor::fullScale() const {
  uint32_t max = (uint32_t)(256 - atime_) * 1024UL;
  return max > 65535UL ? 65535 : (uint16_t)max;
}

bool TCS34725Sensor::read(RGBSample &s) {
  // Do not poll the bus until a new cycle can have finished.
  uint32_t now = micros();
  if (now - lastUs_ < integrationUs() * 3 / 4) return false;
  uint8_t status;
  if (!read8(REG_STATUS, status) || !(status & STATUS_AINT)) return false;

  wire_.beginTransmission(ADDR);
  wire_.write(CMD_AUTOINC | REG_CDATAL);
  if (wire_.endTransmission() != 0) return false;
  if (wire_.requestFrom(ADDR, (uint8_t)8) != 8) return false;
  uint8_t b[8];
  for (uint8_t i = 0; i < 8; i++) b[i] = wire_.read();
  s.c = b[0] | (b[1] << 8);
  s.r = b[2] | (b[3] << 8);
  s.g = b[4] | (b[5] << 8);
  s.b = b[6] | (b[7] << 8);

  wire_.beginTransmission(ADDR);
  wire_.write(CMD_CLEAR_INT);
  wire_.endTransmission();
  lastUs_ = now;
  return true;
}
#endif
