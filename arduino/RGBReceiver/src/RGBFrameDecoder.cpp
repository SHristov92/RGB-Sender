#include "RGBFrameDecoder.h"

static const uint8_t SYNC_HOLD_MIN = 3;  // a W segment >= 3 T starts a frame

void RGBFrameDecoder::begin(uint8_t *bodyBuffer, uint8_t bodyCapacity, RGBDecoderListener *listener) {
  body_ = bodyBuffer;
  bodyCap_ = bodyCapacity;
  listener_ = listener;
  recentCount_ = recentPos_ = 0;
  lastDuration_ = 0;
  reset();
}

void RGBFrameDecoder::reset() {
  state_ = HUNT;
  T_ = T0_ = tSum_ = 0;
  tCount_ = 0;
  symbol_ = 0;
  calErrors_ = 0;
  prev_ = RGB_W;
  acc_ = 0;
  digits_ = 0;
  badByte_ = false;
  pos_ = 0;
  haveHeader_ = false;
  N_ = 5;
  base_ = 4;
  spb_ = 4;
}

void RGBFrameDecoder::emit(RGBDecoderEventType type) {
  ev_.type = type;
  if (listener_) listener_->onDecoderEvent(ev_);
}

uint32_t RGBFrameDecoder::estimatedT() const {
  if (T_) return T_;
  if (!recentCount_) return 0;
  uint16_t s[RECENT];
  for (uint8_t i = 0; i < recentCount_; i++) s[i] = recent_[i];
  for (uint8_t i = 1; i < recentCount_; i++) {  // insertion sort, n <= 31
    uint16_t v = s[i];
    int8_t j = i - 1;
    while (j >= 0 && s[j] > v) {
      s[j + 1] = s[j];
      j--;
    }
    s[j + 1] = v;
  }
  return (uint32_t)s[recentCount_ / 2] * 16;
}

uint16_t RGBFrameDecoder::slotsFor(uint32_t d) const {
  uint32_t T = estimatedT();
  if (!T) return 1;
  // Shorter than 1.75 T is one slot (a slot stretched by a dropped display frame).
  if (d * 4 < T * 7) return 1;
  uint32_t n = (d + T / 2) / T;
  return n > 1000 ? 1000 : (uint16_t)n;
}

uint8_t RGBFrameDecoder::paletteSize(uint16_t ahead) const {
  if (state_ != FRAME) return RGB_PALETTE_SIZE;
  uint16_t i = symbol_ + ahead;
  if (i < RGB_CAL_LEN) return RGB_PALETTE_SIZE;
  if (i < RGB_CAL_LEN + RGB_HEADER_SYMBOLS) return 5;
  return haveHeader_ ? N_ : RGB_PALETTE_SIZE;
}

void RGBFrameDecoder::pushSegment(uint8_t color, uint32_t d) {
  uint32_t prevDuration = lastDuration_;
  lastDuration_ = d;
  uint32_t tRef = estimatedT();
  uint32_t r16 = d / 16;
  recent_[recentPos_] = r16 > 0xFFFF ? 0xFFFF : (uint16_t)r16;
  recentPos_ = (recentPos_ + 1) % RECENT;
  if (recentCount_ < RECENT) recentCount_++;

  // A long white hold can only be a sync: it aborts whatever was in progress.
  if (color == RGB_W && tRef && d >= SYNC_HOLD_MIN * tRef) {
    if (state_ == FRAME) emit(RGB_DEC_ABORTED);
    reset();
    state_ = SYNC;
    return;
  }

  if (state_ == HUNT) return;

  if (state_ == SYNC) {
    uint32_t T = d / 2;
    // White hold must be 3.5 .. 7 T.
    if (color == RGB_K && T && prevDuration * 2 >= T * 7 && prevDuration <= T * 7) {
      state_ = FRAME;
      T_ = T0_ = T;
      emit(RGB_DEC_SYNC);
    } else {
      reset();
    }
    return;
  }

  // In a frame: split the segment into whole symbols.
  uint16_t n = slotsFor(d);
  if (n == 1) {
    // Refine T from single-slot segments, seeded by the sync's K hold (weight 2).
    tSum_ += d;
    tCount_++;
    T_ = (T0_ * 2 + tSum_) / (2 + tCount_);
  }
  if (symbol_ < RGB_CAL_LEN) {
    ev_.index = (uint8_t)symbol_;
    ev_.color = color;
    ev_.single = n == 1;
    emit(RGB_DEC_CAL_SYMBOL);
  }
  for (uint16_t i = 0; i < n && state_ == FRAME; i++) pushSymbol(color);
}

void RGBFrameDecoder::pushSymbol(uint8_t color) {
  uint16_t i = symbol_++;
  if (i < RGB_CAL_LEN) {
    if (color != RGB_CAL_SEQUENCE[i]) calErrors_++;
    if (i == RGB_CAL_LEN - 1) {
      if (calErrors_ > 2) {
        emit(RGB_DEC_CAL_FAILED);
        reset();
      } else {
        emit(RGB_DEC_CAL_OK);
      }
    }
    return;
  }

  // Differential code: digit = (colour - previous - 1) mod N; invalid symbols give a wrong byte.
  int8_t digit;
  if (color >= N_ || prev_ >= N_ || color == prev_)
    digit = -1;
  else
    digit = (int8_t)((color + N_ - prev_ - 1) % N_);
  prev_ = color;
  if (digit < 0 || digit >= base_) badByte_ = true;
  else acc_ = acc_ * base_ + digit;
  if (++digits_ < spb_) return;
  uint8_t byte = (badByte_ || acc_ > 255) ? 0 : (uint8_t)acc_;
  acc_ = 0;
  digits_ = 0;
  badByte_ = false;

  if (!haveHeader_) {
    headerBuf_[pos_++] = byte;
    if (pos_ < sizeof(headerBuf_)) return;
    pos_ = 0;
    if (rgbRsDecode(headerBuf_, sizeof(headerBuf_), RGB_HEADER_PARITY_LEN) < 0 ||
        !rgbParseHeader(headerBuf_, header_)) {
      emit(RGB_DEC_HEADER_FAILED);
      reset();
      return;
    }
    ev_.header = &header_;
    bodyLen_ = header_.L + 2 * header_.t;
    if (bodyLen_ > bodyCap_) {
      emit(RGB_DEC_TOO_LARGE);
      reset();
      return;
    }
    haveHeader_ = true;
    if (header_.mode == RGB_MODE_DENSE) {
      N_ = 8;
      base_ = 7;
      spb_ = 3;
    }
    return;
  }

  body_[pos_++] = byte;
  if (pos_ < bodyLen_) return;
  int corrected = rgbRsDecode(body_, bodyLen_, 2 * header_.t);
  ev_.header = &header_;
  if (corrected >= 0 && rgbCrc16(body_, header_.L) == header_.bodyCrc) {
    ev_.corrected = (int8_t)corrected;
    ev_.data = body_;
    emit(RGB_DEC_FRAME);
  } else {
    emit(RGB_DEC_BODY_FAILED);
  }
  reset();
}
