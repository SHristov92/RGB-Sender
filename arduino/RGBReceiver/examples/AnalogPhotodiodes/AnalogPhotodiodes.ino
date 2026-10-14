// Receives with three photodiodes (or phototransistors) behind red, green and
// blue filters, or a 3-channel RGB photodiode, on analog pins A0-A2.
//
// Simplest circuit per channel: photodiode reverse-biased from 5V to the analog
// pin, load resistor (100k-1M) from the pin to GND. Pick the resistors so a
// white screen gives roughly 2-4 V on each pin. Add a 4th, unfiltered diode on
// A3 for a clear channel, or leave it out (clear = r + g + b).
#include <RGBReceiver.h>

AnalogRGBSensor sensor(A0, A1, A2, -1, 2500 /* us between readings */, 2 /* oversampling */);
uint8_t buffer[rgbBufferSize(120)];
RGBReceiver rx(sensor, buffer, sizeof(buffer));

void setup() {
  Serial.begin(115200);
  rx.begin();
  Serial.println(F("Listening..."));
}

void loop() {
  if (rx.poll()) {
    Serial.print(F("Received: "));
    Serial.println((const char *)rx.message().data);
  }
}
