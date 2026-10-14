// Collects the frames of one message and rebuilds it (carousel + XOR parity,
// SPEC section 7). A port of Assembler in js/receiver.js.
#pragma once

#include "RGBProtocol.h"

struct RGBMessage {
  uint8_t contentType;  // RGB_CONTENT_*
  const uint8_t *data;  // points into the receiver's buffer; followed by a NUL byte
  uint16_t length;
  uint8_t recovered;    // data frames rebuilt from parity
};

enum RGBAddResult : uint8_t {
  RGB_ADD_STORED,        // frame stored, message not complete yet
  RGB_ADD_DUPLICATE,     // already had this frame, or message already delivered
  RGB_ADD_COMPLETE,      // message complete and CRC-32 verified
  RGB_ADD_CORRUPT,       // all chunks present but CRC-32 failed: buffers cleared
  RGB_ADD_TOO_SMALL,     // message does not fit the buffer
};

class RGBAssembler {
 public:
  // The buffer holds K * L data bytes plus P * L parity bytes when they fit
  // (parity frames are ignored when only the data fits).
  void begin(uint8_t *buffer, size_t capacity);
  void clear();
  RGBAddResult addFrame(const RGBFrameHeader &h, const uint8_t *data);
  const RGBMessage &message() const { return message_; }
  bool complete() const { return delivered_; }
  uint8_t have() const;   // data frames present
  uint8_t total() const { return active_ ? K_ : 0; }

 private:
  static const uint16_t MAX_FRAMES = 255 + 15;
  bool has(uint16_t slot) const { return bitmap_[slot >> 3] & (1 << (slot & 7)); }
  void set(uint16_t slot) { bitmap_[slot >> 3] |= 1 << (slot & 7); }
  uint8_t *slotPtr(uint16_t slot) { return buf_ + (size_t)slot * L_; }
  RGBAddResult tryComplete();

  uint8_t *buf_ = nullptr;
  size_t cap_ = 0;
  bool active_ = false;
  bool delivered_ = false;
  uint8_t session_ = 0, K_ = 0, L_ = 0, P_ = 0;
  bool keepParity_ = false;
  uint8_t recovered_ = 0;
  uint8_t bitmap_[(MAX_FRAMES + 7) / 8];
  RGBMessage message_;
};
