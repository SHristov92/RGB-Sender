#include "RGBReceiver.h"

#include <string.h>

// Forget the calibration after this many failed frames in a row, or this long
// without a sync (e.g. the sensor moved to another screen). Re-learning it takes
// one frame, so resetting is cheap.
static const uint8_t FAILURES_BEFORE_RESET = 3;
static const uint32_t NO_SYNC_RESET_US = 60000000UL;

RGBReceiver::RGBReceiver(RGBSensor &sensor, uint8_t *buffer, size_t size, uint8_t maxCodeword) : sensor_(&sensor) {
  init(buffer, size, maxCodeword);
}

RGBReceiver::RGBReceiver(uint8_t *buffer, size_t size, uint8_t maxCodeword) : sensor_(nullptr) {
  init(buffer, size, maxCodeword);
}

void RGBReceiver::init(uint8_t *buffer, size_t size, uint8_t maxCodeword) {
  if (maxCodeword > size) maxCodeword = (uint8_t)size;
  decoder_.begin(buffer, maxCodeword, this);
  assembler_.begin(buffer + maxCodeword, size - maxCodeword);
  reset();
}

bool RGBReceiver::begin() { return sensor_ ? sensor_->begin() : true; }

void RGBReceiver::reset() {
  classifier_.reset();
  decoder_.reset();
  assembler_.clear();
  curValid_ = pendValid_ = false;
  ambiguous_ = 0;
  haveLast_ = false;
  segMeanValid_ = prevMeanValid_ = false;
  failures_ = 0;
  newMessage_ = false;
}

bool RGBReceiver::poll() {
  RGBSample s;
  if (!sensor_ || !sensor_->read(s)) return false;
#if defined(ARDUINO)
  return pushSample(s, micros());
#else
  return false;
#endif
}

void RGBReceiver::event(RGBEventType type, RGBFailReason reason, const RGBFrameHeader *h, int8_t corrected) {
  if (!eventCb_) return;
  RGBEvent e;
  e.type = type;
  e.reason = reason;
  e.header = h;
  e.corrected = corrected;
  e.slotUs = decoder_.estimatedT();
  e.have = assembler_.have();
  e.total = assembler_.total();
  eventCb_(e);
}

bool RGBReceiver::pushSample(const RGBSample &s, uint32_t us) {
  uint32_t dt = haveLast_ ? us - lastUs_ : 0;
  lastUs_ = us;
  haveLast_ = true;
  newMessage_ = false;

  if (classifier_.calibrated() && us - lastSyncUs_ > NO_SYNC_RESET_US) {
    classifier_.reset();
    lastSyncUs_ = us;
    event(RGB_EVENT_CALIBRATION_RESET);
  }
  classifier_.observe(s);

  // Palette for the slot after the segments not yet decoded (5 colours in robust data).
  uint16_t ahead = (pendValid_ ? decoder_.slotsFor(pend_.duration) : 0) + (curValid_ ? decoder_.slotsFor(cur_.duration) : 0);
  uint8_t color = classifier_.classify(s, decoder_.paletteSize(ahead));
  lastColor_ = color;

  if (color == RGB_NONE) {
    ambiguous_ += dt;  // added to whichever segment follows
    return newMessage_;
  }
  if (curValid_ && cur_.color == color) {
    cur_.duration += dt + ambiguous_;
  } else {
    if (curValid_) finishSegment(cur_);
    cur_.color = color;
    cur_.duration = dt + ambiguous_;
    cur_.n = 0;
    memset(cur_.sum, 0, sizeof(cur_.sum));
    curValid_ = true;
  }
  ambiguous_ = 0;
  cur_.sum[0] += s.r;
  cur_.sum[1] += s.g;
  cur_.sum[2] += s.b;
  cur_.sum[3] += s.c;
  cur_.n++;
  return newMessage_;
}

// Glitch filter (SPEC 3.3): a segment shorter than 0.3 T is merged into its
// neighbour. Segments are held back by one so equal neighbours can rejoin.
void RGBReceiver::finishSegment(Segment &seg) {
  if (!pendValid_) {
    pend_ = seg;
    pendValid_ = true;
    return;
  }
  if (seg.color == pend_.color) {
    pend_.duration += seg.duration;
    pend_.n += seg.n;
    for (uint8_t ch = 0; ch < 4; ch++) pend_.sum[ch] += seg.sum[ch];
    return;
  }
  uint32_t T = decoder_.estimatedT();
  if (T && seg.duration * 10 < T * 3) {
    pend_.duration += seg.duration;
    return;
  }
  deliver(pend_);
  pend_ = seg;
}

bool RGBReceiver::meanOf(const Segment &seg, RGBSample &out) const {
  if (!seg.n) return false;
  out.r = (uint16_t)(seg.sum[0] / seg.n);
  out.g = (uint16_t)(seg.sum[1] / seg.n);
  out.b = (uint16_t)(seg.sum[2] / seg.n);
  out.c = (uint16_t)(seg.sum[3] / seg.n);
  return true;
}

void RGBReceiver::deliver(const Segment &seg) {
  prevMean_ = segMean_;
  prevMeanValid_ = segMeanValid_;
  segMeanValid_ = meanOf(seg, segMean_);
  decoder_.pushSegment(seg.color, seg.duration);
}

bool RGBReceiver::pushSegment(uint8_t color, uint32_t durationUs) {
  newMessage_ = false;
  segMeanValid_ = false;
  decoder_.pushSegment(color, durationUs);
  return newMessage_;
}

void RGBReceiver::frameFailed(RGBFailReason reason, const RGBFrameHeader *h) {
  if (++failures_ >= FAILURES_BEFORE_RESET && classifier_.calibratedMask()) {
    classifier_.reset();
    failures_ = 0;
    event(RGB_EVENT_CALIBRATION_RESET);
  }
  event(RGB_EVENT_FRAME_FAILED, reason, h);
}

void RGBReceiver::onDecoderEvent(const RGBDecoderEvent &e) {
  switch (e.type) {
    case RGB_DEC_SYNC:
      lastSyncUs_ = lastUs_;
      classifier_.discard();
      // The sync's white and black holds are the W and K references.
      if (prevMeanValid_) classifier_.stage(RGB_W, prevMean_);
      if (segMeanValid_) classifier_.stage(RGB_K, segMean_);
      event(RGB_EVENT_SYNC);
      break;
    case RGB_DEC_CAL_SYMBOL:
      if (e.single && segMeanValid_ && e.color == RGB_CAL_SEQUENCE[e.index]) classifier_.stage(e.color, segMean_);
      break;
    case RGB_DEC_CAL_OK:
      classifier_.commit();
      break;
    case RGB_DEC_CAL_FAILED:
      classifier_.discard();
      frameFailed(RGB_FAIL_CALIBRATION, nullptr);
      break;
    case RGB_DEC_HEADER_FAILED:
      frameFailed(RGB_FAIL_HEADER, nullptr);
      break;
    case RGB_DEC_TOO_LARGE:
      // The link is fine, the frame just does not fit: not a calibration problem.
      event(RGB_EVENT_FRAME_FAILED, RGB_FAIL_TOO_LARGE, e.header);
      break;
    case RGB_DEC_BODY_FAILED:
      frameFailed(RGB_FAIL_BODY, e.header);
      break;
    case RGB_DEC_ABORTED:
      frameFailed(RGB_FAIL_ABORTED, nullptr);
      break;
    case RGB_DEC_FRAME: {
      failures_ = 0;
      RGBAddResult r = assembler_.addFrame(*e.header, e.data);
      event(RGB_EVENT_FRAME_OK, RGB_FAIL_NONE, e.header, e.corrected);
      if (r == RGB_ADD_COMPLETE) {
        newMessage_ = true;
        event(RGB_EVENT_MESSAGE);
        if (messageCb_) messageCb_(assembler_.message());
      } else if (r == RGB_ADD_CORRUPT) {
        event(RGB_EVENT_MESSAGE_CORRUPT);
      } else if (r == RGB_ADD_TOO_SMALL) {
        event(RGB_EVENT_BUFFER_TOO_SMALL, RGB_FAIL_NONE, e.header);
      }
      break;
    }
  }
}
