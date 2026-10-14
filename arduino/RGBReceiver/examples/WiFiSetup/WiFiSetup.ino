// ESP32 / ESP8266: receive Wi-Fi credentials from the sender page ("Wi-Fi" tab)
// with a TCS34725 and connect to the network.
// Wiring (ESP32): SDA-GPIO21, SCL-GPIO22, VIN-3V3, GND-GND, LED-GND.
#include <Wire.h>
#include <RGBReceiver.h>
#if defined(ESP32)
#include <WiFi.h>
#elif defined(ESP8266)
#include <ESP8266WiFi.h>
#else
#error "This example needs an ESP32 or ESP8266"
#endif

TCS34725Sensor sensor;
uint8_t buffer[rgbBufferSize(200)];
RGBReceiver rx(sensor, buffer, sizeof(buffer));

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Wire.setClock(400000);
  if (!rx.begin()) {
    Serial.println("TCS34725 not found, check wiring");
    while (true) delay(1000);
  }
  Serial.println("Hold the sensor against the phone screen...");
}

void loop() {
  if (!rx.poll()) return;
  const RGBMessage &m = rx.message();
  RGBWifiCredentials wifi;
  if (m.contentType != RGB_CONTENT_WIFI || !rgbParseWifi(m.data, m.length, wifi)) {
    Serial.println("Received something that is not Wi-Fi credentials");
    return;
  }
  Serial.printf("Connecting to \"%s\"...\n", wifi.ssid);
  WiFi.mode(WIFI_STA);
  WiFi.begin(wifi.ssid, wifi.password);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(250);
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Connected, IP ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Could not connect; send the credentials again");
  }
}
