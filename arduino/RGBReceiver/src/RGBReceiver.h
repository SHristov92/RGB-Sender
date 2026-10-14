// RGBReceiver: receives data flashed by the RGB Sender web page (protocol v1,
// docs/SPEC.md) through a colour sensor.
//
//   TCS34725Sensor sensor;
//   uint8_t buffer[rgbBufferSize(100)];   // messages up to 100 bytes
//   RGBReceiver rx(sensor, buffer, sizeof(buffer));
//   ...
//   if (rx.poll()) Serial.println((const char *)rx.message().data);
//
// Pipeline: sensor readings -> classifier (calibrated per frame) -> colour
// segments (ambiguity rule, glitch filter) -> frame decoder (sync, RS, CRC-16)
// -> assembler (carousel, XOR parity, CRC-32) -> message.
#pragma once

#include "RGBAssembler.h"
#include "RGBClassifier.h"
#include "RGBFrameDecoder.h"
#include "RGBProtocol.h"
#include "RGBSensor.h"
#include "RGBWifi.h"
#if defined(ARDUINO)
#include "AnalogRGBSensor.h"
#include "TCS34725Sensor.h"
#endif

enum RGBEventType : uint8_t {
  RGB_EVENT_SYNC,               // frame start found (T in event.slotUs)
  RGB_EVENT_FRAME_OK,           // a frame decoded (header, corrected)
  RGB_EVENT_FRAME_FAILED,       // a frame was lost (reason)
  RGB_EVENT_MESSAGE,            // message complete
  RGB_EVENT_MESSAGE_CORRUPT,    // all chunks arrived but the CRC-32 failed; starting over
  RGB_EVENT_BUFFER_TOO_SMALL,   // the message does not fit the buffer
  RGB_EVENT_CALIBRATION_RESET,  // repeated failures: calibration forgotten
};

enum RGBFailReason : uint8_t {
  RGB_FAIL_NONE,
  RGB_FAIL_CALIBRATION,  // CAL sequence misread
  RGB_FAIL_HEADER,       // header RS failed or header invalid
  RGB_FAIL_BODY,         // body RS or CRC-16 failed
  RGB_FAIL_TOO_LARGE,    // body codeword larger than maxCodeword
  RGB_FAIL_ABORTED,      // next sync arrived before the frame ended (lost slots)
};

struct RGBEvent {
  RGBEventType type;
  RGBFailReason reason;
  const RGBFrameHeader *header;  // FRAME_OK, and FRAME_FAILED when the header was read
  int8_t corrected;              // FRAME_OK: bytes fixed by Reed-Solomon
  uint32_t slotUs;               // measured slot time T
  uint8_t have, total;           // data frames collected / needed for the current message
};

// Buffer size for messages of up to maxPayload bytes, given the sender's chunk
// size, Reed-Solomon strength and parity setting (the web page defaults).
// It includes the codeword buffer (chunkSize + 2 * eccT bytes).
constexpr size_t rgbChunk_(size_t chunk, size_t t) { return chunk < 255 - 2 * t ? chunk : 255 - 2 * t; }
constexpr size_t rgbFrames_(size_t e, size_t maxL) { return (e + maxL - 1) / maxL; }
constexpr size_t rgbParity_(size_t k, size_t every) {
  return (every && k > 1) ? ((k + every - 1) / every < 15 ? (k + every - 1) / every : 15) : 0;
}
constexpr size_t rgbBufferSize(size_t maxPayload, size_t chunkSize = 48, size_t eccT = 8, size_t parityEvery = 4) {
  return rgbChunk_(chunkSize, eccT) + 2 * eccT + (maxPayload + 7) + rgbFrames_(maxPayload + 7, rgbChunk_(chunkSize, eccT)) +
         rgbParity_(rgbFrames_(maxPayload + 7, rgbChunk_(chunkSize, eccT)), parityEvery) * rgbChunk_(chunkSize, eccT);
}

class RGBReceiver : private RGBDecoderListener {
 public:
  typedef void (*MessageCallback)(const RGBMessage &msg);
  typedef void (*EventCallback)(const RGBEvent &event);

  // `buffer` holds one frame codeword (the first maxCodeword bytes; the default
  // 64 fits the web page's defaults: chunk 48 + 2 x 8 RS bytes) and the message
  // being assembled. Use rgbBufferSize() to size it.
  RGBReceiver(RGBSensor &sensor, uint8_t *buffer, size_t size, uint8_t maxCodeword = 64);
  // Without a sensor: feed readings with pushSample() or segments with pushSegment().
  RGBReceiver(uint8_t *buffer, size_t size, uint8_t maxCodeword = 64);

  // Starts the sensor (if any). Returns false if the sensor did not respond.
  bool begin();
  // Call as often as possible from loop(). Returns true once per completed message.
  bool poll();

  // Feed one reading taken at time `us` (micros()). Returns true when a message completed.
  bool pushSample(const RGBSample &s, uint32_t us);
  // Feed an already classified colour segment, bypassing the classifier.
  bool pushSegment(uint8_t color, uint32_t durationUs);

  // The last completed message. Its data stays valid until a frame of a different
  // message arrives; copy it out if you keep listening.
  const RGBMessage &message() const { return assembler_.message(); }
  bool hasMessage() const { return assembler_.complete(); }
  // Data frames collected / needed for the message in progress (0/0 if none).
  uint8_t framesHave() const { return assembler_.have(); }
  uint8_t framesTotal() const { return assembler_.total(); }

  void onMessage(MessageCallback cb) { messageCb_ = cb; }
  void onEvent(EventCallback cb) { eventCb_ = cb; }

  // Forgets the message in progress, calibration and timing.
  void reset();

  // For diagnostics (see the SensorTest example).
  uint8_t lastColor() const { return lastColor_; }
  const RGBClassifier &classifier() const { return classifier_; }
  uint32_t slotUs() const { return decoder_.estimatedT(); }

 private:
  struct Segment {
    uint8_t color;
    uint16_t n;  // samples summed
    uint32_t duration;
    uint32_t sum[4];
  };

  void init(uint8_t *buffer, size_t size, uint8_t maxCodeword);
  void onDecoderEvent(const RGBDecoderEvent &e) override;
  void frameFailed(RGBFailReason reason, const RGBFrameHeader *h);
  void finishSegment(Segment &seg);
  void deliver(const Segment &seg);
  bool meanOf(const Segment &seg, RGBSample &out) const;
  void event(RGBEventType type, RGBFailReason reason = RGB_FAIL_NONE, const RGBFrameHeader *h = nullptr,
             int8_t corrected = 0);

  RGBSensor *sensor_;
  RGBClassifier classifier_;
  RGBFrameDecoder decoder_;
  RGBAssembler assembler_;
  MessageCallback messageCb_ = nullptr;
  EventCallback eventCb_ = nullptr;

  Segment cur_, pend_;
  bool curValid_ = false, pendValid_ = false;
  uint32_t ambiguous_ = 0;  // duration of ambiguous samples, given to the next segment
  uint32_t lastUs_ = 0;
  bool haveLast_ = false;
  uint8_t lastColor_ = RGB_NONE;

  // Mean reading of the segment being delivered and of the one before (the sync's W hold).
  RGBSample segMean_, prevMean_;
  bool segMeanValid_ = false, prevMeanValid_ = false;

  uint8_t failures_ = 0;  // frames failed in a row
  uint32_t lastSyncUs_ = 0;
  bool newMessage_ = false;
};
