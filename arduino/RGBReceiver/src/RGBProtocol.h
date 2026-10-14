// RGB Sender protocol v1: constants, Reed-Solomon and CRCs (see docs/SPEC.md).
// Everything here is plain C++ with no Arduino dependency, so it also builds on a PC.
#pragma once

#include <stddef.h>
#include <stdint.h>

#if defined(ARDUINO)
#include <Arduino.h>
#else
#define PROGMEM
#define pgm_read_byte(p) (*(const uint8_t *)(p))
#endif

// Palette indices (SPEC 3.1).
enum RGBColor : uint8_t {
  RGB_K = 0,
  RGB_R = 1,
  RGB_G = 2,
  RGB_B = 3,
  RGB_W = 4,
  RGB_C = 5,
  RGB_M = 6,
  RGB_Y = 7,
  RGB_NONE = 0xFF,  // ambiguous or unknown sample
};

enum RGBMode : uint8_t { RGB_MODE_ROBUST = 0, RGB_MODE_DENSE = 1 };
enum RGBFrameType : uint8_t { RGB_FRAME_DATA = 0, RGB_FRAME_PARITY = 1 };
enum RGBContentType : uint8_t {
  RGB_CONTENT_BINARY = 0,
  RGB_CONTENT_TEXT = 1,
  RGB_CONTENT_WIFI = 2,
  RGB_CONTENT_JSON = 3,
};

const uint8_t RGB_PALETTE_SIZE = 8;
const uint8_t RGB_CAL_LEN = 7;
const uint8_t RGB_HEADER_INFO_LEN = 8;
const uint8_t RGB_HEADER_PARITY_LEN = 8;
const uint8_t RGB_HEADER_SYMBOLS = (RGB_HEADER_INFO_LEN + RGB_HEADER_PARITY_LEN) * 4;
const uint8_t RGB_MAX_NSYM = 30;  // t <= 15

extern const uint8_t RGB_CAL_SEQUENCE[RGB_CAL_LEN];

// Header fields (SPEC 5.4).
struct RGBFrameHeader {
  uint8_t mode;
  uint8_t type;
  uint8_t sessionId;
  uint8_t index;
  uint8_t K;
  uint8_t L;
  uint8_t P;
  uint8_t t;
  uint16_t bodyCrc;
};

// Parses and validates the 8 header information bytes. Returns false for a header
// a v1 receiver must discard.
bool rgbParseHeader(const uint8_t *info, RGBFrameHeader &h);

// CRC-16/CCITT-FALSE and CRC-32/ISO-HDLC (SPEC 6.2, 6.3).
uint16_t rgbCrc16(const uint8_t *data, size_t len);
uint32_t rgbCrc32(const uint8_t *data, size_t len);

// Reed-Solomon over GF(256), poly 0x11D, fcr 0 (SPEC 6.1). Errors-only decoding,
// in place. `codeword` is n bytes (data followed by nsym parity bytes), n <= 255,
// nsym <= RGB_MAX_NSYM. Returns the number of corrected bytes, or -1 when the
// codeword is uncorrectable.
int rgbRsDecode(uint8_t *codeword, uint8_t n, uint8_t nsym);
