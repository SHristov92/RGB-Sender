# RGB Sender

Send data from a phone screen to a microcontroller board (Arduino, ESP32, Pico, …)
by flashing full‑screen colour sequences at a colour sensor.

- **[Protocol and hardware spec](docs/SPEC.md)**: palette, self‑clocking colour code,
  framing, Reed–Solomon FEC, CRCs, carousel repetition and XOR parity frames for a
  one‑way link, sensor and wiring guidance.
- **Sender web page** (`index.html`): plain HTML/CSS/JavaScript, no build step.
  Text, Wi‑Fi credentials or a small file in; a full‑screen colour stream out.
- **Camera test receiver** (`receive.html`): decodes a transmission with a phone or
  laptop camera, so you can test the sender before building the hardware. Set the
  sender to 100 ms symbols or slower.
- **Reference decoder** (`js/receiver.js`): the receiver state machine from the spec,
  used by the tests and meant as the template for a microcontroller port.

## Use it

Open the GitHub Pages site (see below), type a message, check **Link settings** if you
need a faster or more robust link, then tap **Start sending** and hold the sensor
against the centre of the screen. Tap the screen to stop. **Show test pattern**
shows each colour for one second, for aiming the sensor and setting its gain.

Run it locally with any static server (ES modules do not load from `file://`):

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

## Deploy on GitHub Pages

Repository **Settings → Pages → Build and deployment**: Source *Deploy from a branch*,
branch `main`, folder `/ (root)`. The site is then served at
`https://<user>.github.io/RGB-Sender/`.

## Tests

```sh
npm test          # RS/CRC unit tests + end-to-end runs through a simulated noisy channel
npm run vectors   # prints the test vectors quoted in docs/SPEC.md
```

The channel simulator (`tests/sim.mjs`) and camera simulator (`tests/camera-sim.mjs`) inject colour misreads, timing jitter,
dropped display frames, destroyed frames, late receiver start, camera exposure blur,
colour cast and sensor noise.

## Layout

```
index.html, css/        sender page
js/protocol.js          encoder: palette, line code, frames, envelope, carousel
js/rs.js, js/crc.js     Reed–Solomon GF(256) and CRC-16/CRC-32
js/receiver.js          reference decoder (segments in, messages out)
js/sampler.js           RGB sample classifier + segmenter (camera front end)
receive.html, js/receive.js  camera test receiver page
js/app.js               page logic: input, settings, full-screen player
docs/SPEC.md            protocol v1
tests/                  test runner, channel simulator, vector generator
```
