#include "RGBAssembler.h"

#include <string.h>

void RGBAssembler::begin(uint8_t *buffer, size_t capacity) {
  buf_ = buffer;
  cap_ = capacity;
  clear();
}

void RGBAssembler::clear() {
  active_ = false;
  delivered_ = false;
  recovered_ = 0;
  memset(bitmap_, 0, sizeof(bitmap_));
  message_.contentType = 0;
  message_.data = nullptr;
  message_.length = 0;
  message_.recovered = 0;
}

uint8_t RGBAssembler::have() const {
  uint8_t n = 0;
  for (uint16_t i = 0; i < K_ && active_; i++)
    if (has(i)) n++;
  return n;
}

RGBAddResult RGBAssembler::addFrame(const RGBFrameHeader &h, const uint8_t *data) {
  // Buffers are keyed by (session, K, L, P); a different key is a new message.
  if (!active_ || h.sessionId != session_ || h.K != K_ || h.L != L_ || h.P != P_) {
    clear();
    if ((size_t)h.K * h.L > cap_) return RGB_ADD_TOO_SMALL;
    active_ = true;
    session_ = h.sessionId;
    K_ = h.K;
    L_ = h.L;
    P_ = h.P;
    keepParity_ = (size_t)(h.K + h.P) * h.L <= cap_;
  }
  if (delivered_) return RGB_ADD_DUPLICATE;
  uint16_t slot;
  if (h.type == RGB_FRAME_DATA) {
    slot = h.index;
  } else {
    if (!keepParity_) return RGB_ADD_DUPLICATE;
    slot = (uint16_t)K_ + h.index;
  }
  if (has(slot)) return RGB_ADD_DUPLICATE;
  memcpy(slotPtr(slot), data, L_);
  set(slot);
  return tryComplete();
}

RGBAddResult RGBAssembler::tryComplete() {
  if (keepParity_ && P_) {
    for (uint16_t i = 0; i < K_; i++) {
      if (has(i)) continue;
      uint16_t j = i % P_;
      if (!has(K_ + j)) continue;
      bool ok = true;
      for (uint16_t k = j; k < K_; k += P_)
        if (k != i && !has(k)) ok = false;
      if (!ok) continue;
      // Missing chunk = parity XOR every other chunk of its class.
      uint8_t *dst = slotPtr(i);
      memcpy(dst, slotPtr(K_ + j), L_);
      for (uint16_t k = j; k < K_; k += P_) {
        if (k == i) continue;
        const uint8_t *src = slotPtr(k);
        for (uint8_t b = 0; b < L_; b++) dst[b] ^= src[b];
      }
      set(i);
      recovered_++;
    }
  }
  for (uint16_t i = 0; i < K_; i++)
    if (!has(i)) return RGB_ADD_STORED;

  // Envelope: [type][length LE16][data][CRC-32 LE] (SPEC 7.1).
  size_t total = (size_t)K_ * L_;
  uint16_t len = buf_[1] | ((uint16_t)buf_[2] << 8);
  bool ok = total >= 7 && (size_t)len + 7 <= total;
  if (ok) {
    const uint8_t *c = buf_ + 3 + len;
    uint32_t crc = c[0] | ((uint32_t)c[1] << 8) | ((uint32_t)c[2] << 16) | ((uint32_t)c[3] << 24);
    ok = rgbCrc32(buf_, (size_t)len + 3) == crc;
  }
  if (!ok) {
    // Every frame passed its CRC-16 but the whole message did not: start over.
    clear();
    return RGB_ADD_CORRUPT;
  }
  buf_[3 + len] = 0;  // CRC already checked; NUL-terminate for convenience
  message_.contentType = buf_[0];
  message_.data = buf_ + 3;
  message_.length = len;
  message_.recovered = recovered_;
  delivered_ = true;
  return RGB_ADD_COMPLETE;
}
