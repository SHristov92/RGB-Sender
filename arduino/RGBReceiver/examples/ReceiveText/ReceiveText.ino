// Receives a message from the RGB Sender web page with a TCS34725 colour sensor
// and prints it to the serial monitor (115200 baud).
//
// Wiring (Uno/Nano): VIN-5V, GND-GND, SDA-A4, SCL-A5, LED-GND (white LED off).
// Hold the sensor, in a short black tube, against the middle of the phone screen.
#include <Wire.h>
#include <RGBReceiver.h>

TCS34725Sensor sensor;  // 4.8 ms integration, gain 4x: see SensorTest to tune
uint8_t buffer[rgbBufferSize(120)];  // messages up to 120 bytes with the page's defaults
RGBReceiver rx(sensor, buffer, sizeof(buffer));

#ifndef LED_BUILTIN
#define LED_BUILTIN 2
#endif
const uint8_t LED = LED_BUILTIN;
uint32_t ledOffAt = 0;

void onEvent(const RGBEvent &e) {
  switch (e.type) {
    case RGB_EVENT_FRAME_OK:
      digitalWrite(LED, HIGH);  // short blink per good frame helps aiming
      ledOffAt = millis() + 100;
      Serial.print(F("frame ok, "));
      Serial.print(e.have);
      Serial.print('/');
      Serial.println(e.total);
      break;
    case RGB_EVENT_FRAME_FAILED:
      Serial.print(F("frame lost, reason "));
      Serial.println(e.reason);
      break;
    case RGB_EVENT_BUFFER_TOO_SMALL:
      Serial.println(F("message too large for the buffer"));
      break;
    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(LED, OUTPUT);
  Wire.begin();
  Wire.setClock(400000);
  if (!rx.begin()) {
    Serial.println(F("TCS34725 not found, check wiring"));
    while (true) {}
  }
  rx.onEvent(onEvent);
  Serial.println(F("Listening..."));
}

void loop() {
  if (rx.poll()) {
    const RGBMessage &m = rx.message();
    Serial.print(F("Message, type "));
    Serial.print(m.contentType);
    Serial.print(F(", "));
    Serial.print(m.length);
    Serial.println(F(" bytes:"));
    if (m.contentType == RGB_CONTENT_BINARY) {
      for (uint16_t i = 0; i < m.length; i++) {
        if (m.data[i] < 16) Serial.print('0');
        Serial.print(m.data[i], HEX);
      }
      Serial.println();
    } else {
      Serial.println((const char *)m.data);  // text is NUL-terminated
    }
  }
  if (ledOffAt && (int32_t)(millis() - ledOffAt) >= 0) {
    digitalWrite(LED, LOW);
    ledOffAt = 0;
  }
}
