# RGBReceiver (Arduino library)

Receives data flashed by the [RGB Sender](../../README.md) web page with a colour
sensor or RGB photodiodes. It implements protocol v1 from
[docs/SPEC.md](../../docs/SPEC.md): self‑clocking colour code, per‑frame
calibration, Reed–Solomon FEC, CRC‑16/CRC‑32, carousel and XOR parity frames.

Works on AVR (Uno, Nano, Nano Every), ESP32, ESP8266, RP2040 and other Arduino
cores. On an Uno the ReceiveText example (messages up to 120 bytes) needs about
12 KB of flash and 800 bytes of RAM for the library and its buffer, plus what
`Serial` and `Wire` use; peak stack during Reed–Solomon decoding is about 400 bytes.

## Install

Copy (or symlink) `arduino/RGBReceiver` into your Arduino `libraries` folder, or
zip that folder and use *Sketch → Include Library → Add .ZIP Library*.

## Sensors

| Class | Hardware |
| --- | --- |
| `TCS34725Sensor` | TCS34725 breakout over I²C (recommended). Switch its white LED off (LED pin to GND). |
| `AnalogRGBSensor` | Three photodiodes / phototransistors with R, G, B filters, or a 3‑channel RGB photodiode, on analog pins (optional 4th clear channel). |
| your own | Derive from `RGBSensor` and implement `begin()` and a non‑blocking `read(RGBSample&)`. |

The receiver needs at least 7 readings per colour slot: 140 readings/s at the
default 50 ms slots. Mount the sensor in a short black tube pressed against the
screen (SPEC 2.3); light leaking in is the main cause of trouble.

## Use

```cpp
#include <Wire.h>
#include <RGBReceiver.h>

TCS34725Sensor sensor;
uint8_t buffer[rgbBufferSize(120)];   // messages up to 120 bytes
RGBReceiver rx(sensor, buffer, sizeof(buffer));

void setup() {
  Serial.begin(115200);
  Wire.begin();
  Wire.setClock(400000);
  rx.begin();
}

void loop() {
  if (rx.poll()) Serial.println((const char *)rx.message().data);
}
```

Call `poll()` as often as possible: avoid `delay()` in `loop()` while receiving.
`message()` stays valid until frames of a different message start arriving.
Text messages are NUL‑terminated. `rx.onEvent()` reports syncs, good and lost
frames and progress (`have`/`total`), which is handy for a status LED.

`rgbBufferSize(maxPayload, chunkSize = 48, eccT = 8, parityEvery = 4)` sizes the
buffer for the page's *Link settings*. If you raise the chunk size or ECC on the
page, pass the same values and give the receiver a larger codeword buffer:
`RGBReceiver rx(sensor, buffer, sizeof(buffer), chunkSize + 2 * eccT)`.

Wi‑Fi credentials (content type 2) can be parsed with `rgbParseWifi()`; see the
`WiFiSetup` example.

## Examples

- **ReceiveText**: TCS34725, prints messages, blinks the LED on every good frame.
- **SensorTest**: raw readings, percent of full scale and the classified colour;
  use it with the page's *Show test pattern* to aim the sensor and set the gain.
- **AnalogPhotodiodes**: three photodiodes on A0–A2.
- **WiFiSetup**: ESP32/ESP8266, receive Wi‑Fi credentials and connect.

## How it works

```
sensor readings ─▶ RGBClassifier ─▶ segments ─▶ RGBFrameDecoder ─▶ RGBAssembler ─▶ message
                   (normalise by    (ambiguity    (sync, CAL, RS,     (carousel,
                    black/white,     rule, 0.3 T   CRC‑16)             XOR parity,
                    nearest colour)  glitch filter)                    CRC‑32)
```

- Before the first frame the classifier uses the running min/max of each channel
  as black and white and ideal colours; that is enough to find the sync and read
  the first calibration sequence. After that every frame's SYNC and CAL slots
  update the references (exponential average). After 3 failed frames in a row,
  or a minute without a sync, the calibration is relearned from scratch.
- Symbols are turned into bytes as they arrive, so only one codeword (64 bytes
  with the page defaults) is buffered. GF(256) tables live in flash.
- `pushSample(sample, micros)` and `pushSegment(colour, durationUs)` let you feed
  readings or already classified colours yourself.

## Tests

`npm run test:arduino` (from the repository root) compiles the library with the
host C++ compiler and runs it against transmissions built by the JavaScript
sender: colour segments from the channel simulator (checked against the JS
reference receiver) and simulated raw sensor readings with LCD lag, noise,
ambient light and dropped display frames.
