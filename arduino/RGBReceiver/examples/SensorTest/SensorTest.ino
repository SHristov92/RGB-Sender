// Prints raw TCS34725 readings and the colour the receiver would see. Open the
// sender page, tap "Show test pattern" and hold the sensor against the screen:
// - white should read 30-80 % of full scale on the clear channel; change the gain
//   (or ATIME) below if it does not;
// - black should read close to 0 (if not, light leaks in: improve the shield);
// - after one full cycle of the pattern the colour column should follow the screen.
#include <Wire.h>
#include <RGBReceiver.h>

TCS34725Sensor sensor(Wire, 0xFE, TCS34725Sensor::GAIN_4X);
uint8_t buffer[rgbBufferSize(20)];
RGBReceiver rx(buffer, sizeof(buffer));  // only used to classify readings here

uint32_t readings = 0, lastPrint = 0;
const char KEYS[] = "KRGBWCMY";

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Wire.setClock(400000);
  if (!sensor.begin()) {
    Serial.println(F("TCS34725 not found, check wiring"));
    while (true) {}
  }
  Serial.println(F("r\tg\tb\tc\tc%FS\treadings/s\tcolour"));
}

void loop() {
  RGBSample s;
  if (!sensor.read(s)) return;
  readings++;
  rx.pushSample(s, micros());
  uint32_t now = millis();
  if (now - lastPrint < 250) return;
  Serial.print(s.r);
  Serial.print('\t');
  Serial.print(s.g);
  Serial.print('\t');
  Serial.print(s.b);
  Serial.print('\t');
  Serial.print(s.c);
  Serial.print('\t');
  Serial.print(100UL * s.c / sensor.fullScale());
  Serial.print(F("%\t"));
  Serial.print(readings * 1000UL / (now - lastPrint));
  Serial.print(F("\t\t"));
  uint8_t c = rx.lastColor();
  Serial.println(c < 8 ? KEYS[c] : '?');
  readings = 0;
  lastPrint = now;
}
