// Frame decoder: colour segments in, verified frames out. A port of FrameDecoder in
// js/receiver.js (SPEC section 8) that converts symbols to bytes on the fly instead
// of buffering them.
#pragma once

#include "RGBProtocol.h"

enum RGBDecoderEventType : uint8_t {
  RGB_DEC_SYNC,           // frame sync found; T measured
  RGB_DEC_CAL_SYMBOL,     // one CAL slot read (index, color, single)
  RGB_DEC_CAL_OK,         // CAL sequence accepted
  RGB_DEC_CAL_FAILED,     // more than 2 CAL slots wrong
  RGB_DEC_HEADER_FAILED,  // header did not decode or is invalid
  RGB_DEC_TOO_LARGE,      // body codeword larger than the body buffer
  RGB_DEC_BODY_FAILED,    // body RS or CRC-16 failed
  RGB_DEC_ABORTED,        // a new sync arrived mid-frame
  RGB_DEC_FRAME,          // frame decoded: header + body data
};

struct RGBDecoderEvent {
  RGBDecoderEventType type;
  uint8_t index;       // CAL_SYMBOL: CAL slot index
  uint8_t color;       // CAL_SYMBOL: colour read
  bool single;         // CAL_SYMBOL: the segment was exactly one slot
  int8_t corrected;    // FRAME: bytes corrected by RS
  const RGBFrameHeader *header;  // FRAME, BODY_FAILED, TOO_LARGE
  const uint8_t *data;           // FRAME: header->L body bytes
};

class RGBDecoderListener {
 public:
  virtual void onDecoderEvent(const RGBDecoderEvent &e) = 0;
};

class RGBFrameDecoder {
 public:
  // bodyBuffer holds one body codeword (L + 2t bytes); frames that need more are
  // rejected with RGB_DEC_TOO_LARGE. 64 bytes fits the sender's defaults (L <= 48, t = 8).
  void begin(uint8_t *bodyBuffer, uint8_t bodyCapacity, RGBDecoderListener *listener);
  void pushSegment(uint8_t color, uint32_t durationUs);
  void reset();

  // Slot time: the measured T while in a frame, else the median of recent segments.
  uint32_t estimatedT() const;
  // Slots a segment of this duration counts as, with the current T.
  uint16_t slotsFor(uint32_t durationUs) const;
  // Palette size a classifier should use for the symbol `ahead` slots after the
  // last one decoded: 5 for robust data, 8 where all colours may appear.
  uint8_t paletteSize(uint16_t ahead) const;
  bool inFrame() const { return state_ == FRAME; }

 private:
  enum State : uint8_t { HUNT, SYNC, FRAME };
  static const uint8_t RECENT = 31;

  void pushSymbol(uint8_t color);
  void emit(RGBDecoderEventType type);

  RGBDecoderListener *listener_ = nullptr;
  uint8_t *body_ = nullptr;
  uint8_t bodyCap_ = 0;

  // Recent segment durations (units of 16 us, saturating) for the unlocked T estimate.
  uint16_t recent_[RECENT];
  uint8_t recentCount_ = 0;
  uint8_t recentPos_ = 0;
  uint32_t lastDuration_ = 0;

  State state_ = HUNT;
  uint32_t T_ = 0, T0_ = 0, tSum_ = 0;
  uint16_t tCount_ = 0;

  uint16_t symbol_ = 0;   // symbols decoded in this frame (CAL starts at 0)
  uint8_t calErrors_ = 0;
  uint8_t prev_ = RGB_W;  // previous colour for the differential code
  uint16_t acc_ = 0;      // digit accumulator for the current byte
  uint8_t digits_ = 0;
  bool badByte_ = false;
  uint8_t pos_ = 0;       // bytes written to the current codeword
  bool haveHeader_ = false;
  uint8_t headerBuf_[RGB_HEADER_INFO_LEN + RGB_HEADER_PARITY_LEN];
  RGBFrameHeader header_;
  uint8_t N_ = 5, base_ = 4, spb_ = 4;
  uint8_t bodyLen_ = 0;

  RGBDecoderEvent ev_;
};
