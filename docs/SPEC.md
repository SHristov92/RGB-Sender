# RGB Sender — Optical Colour Link, Protocol v1

Status: draft 1 · 2026-10-14

RGB Sender moves small amounts of data (Wi‑Fi credentials, configuration, short
text, keys, small files) from a phone or any screen to a microcontroller board.
The screen flashes a sequence of full‑screen colours; a colour sensor on the
board reads them and decodes the data. The link is **one‑way**: the board can
never ask for a retransmission, so everything that makes it reliable is built
into the transmission itself.

The key words MUST, SHOULD and MAY are used as in RFC 2119.

## Contents

1. [Design goals](#1-design-goals)
2. [Hardware](#2-hardware)
3. [Physical layer: colours and timing](#3-physical-layer-colours-and-timing)
4. [Line code](#4-line-code)
5. [Frame format](#5-frame-format)
6. [Forward error correction and integrity](#6-forward-error-correction-and-integrity)
7. [Transport: message, chunks, carousel, parity frames](#7-transport-message-chunks-carousel-parity-frames)
8. [Receiver algorithm](#8-receiver-algorithm)
9. [Sender requirements](#9-sender-requirements)
10. [Parameters, throughput and test vectors](#10-parameters-throughput-and-test-vectors)
11. [Resilience summary](#11-resilience-summary)
12. [Future extensions](#12-future-extensions)

---

## 1. Design goals

| Goal | How v1 meets it |
| --- | --- |
| Works with a web page, no app install | Plain HTML/JS page, full‑screen colour fills driven by `requestAnimationFrame` |
| Works with cheap sensors and 8‑bit boards | 5 or 8 saturated colours, ≥ 7 samples per symbol, byte‑oriented RS over GF(256), ≤ 1 KB RAM for typical messages |
| No shared clock | Self‑clocking differential colour code: **every symbol is a colour change** |
| Any phone, any screen calibration | Every frame carries a calibration sequence of all colours |
| One‑way link | FEC inside each frame, endless carousel repetition, cross‑frame XOR parity, session IDs so the receiver can join at any moment |
| Never deliver wrong data | CRC‑16 per frame plus CRC‑32 over the whole message |

## 2. Hardware

### 2.1 Receiver board

Any microcontroller with I²C (or GPIO for a frequency‑output sensor) and about
1 KB of free RAM: Arduino Uno/Nano (ATmega328P), Arduino Nano Every, ESP32,
ESP8266, RP2040 (Pico), STM32. 32‑bit boards are recommended for messages over
~300 bytes or when the RS decoder must run with large `t`.

### 2.2 Colour sensor

| Sensor | Interface | Suitability |
| --- | --- | --- |
| **TCS34725** (recommended) | I²C, RGB + clear, 16‑bit | Integration time down to 2.4 ms → 300+ samples/s. IR‑blocking filter. Breakout boards (e.g. Adafruit 1334) include a white LED that **MUST be switched off** (tie the `LED` pin to GND). |
| APDS‑9960 | I²C, RGB + clear | Usable; slightly slower (min. ~2.8 ms ADC time). Disable proximity/gesture engines. |
| TCS3200 / TCS230 | Frequency output, filter selected by pins | Usable at symbol times ≥ 67 ms: channels are read one after another, so a full RGB+C reading takes 4 short gate times. |
| AS7341 / AS7262 | I²C, spectral | Works, overkill. |
| 3 photodiodes / phototransistors + R/G/B gels + ADC | Analog | Works and is fast; needs per‑channel gain trimming. **LDRs are too slow** (tens of ms response) except at ≥ 200 ms symbols. |

The receiver needs **≥ 7 colour samples per symbol** (≥ 140 samples/s at the
50 ms default, ≥ 210 samples/s at 33 ms). For the TCS34725: `ATIME = 0xFF`
(2.4 ms) or `0xFE` (4.8 ms), gain 4× or 16× so that white reads 30–80 % of full
scale. Integrations ≥ 4.8 ms average out OLED PWM flicker (see 3.4).

### 2.3 Optics and mounting

- Mount the sensor in a **light shield**: a short opaque tube (3D‑printed,
  black card or heat‑shrink) 5–15 mm long, open end pressed against the screen,
  with a foam ring so no ambient light leaks in. This is the single most
  important thing for reliable black/white detection.
- Sensor window parallel to the screen, 3–10 mm from the glass. Aim at the
  centre of the screen, away from the top edge where the sender page may draw a
  small status line.
- A status LED on the board (e.g. green = frame OK, red = frame failed) is
  strongly recommended for aiming.

### 2.4 Wiring (TCS34725 breakout → Arduino Uno/Nano)

| Sensor pin | Board pin |
| --- | --- |
| VIN | 5V (or 3V3 on 3.3 V boards) |
| GND | GND |
| SDA | A4 (Uno/Nano) · GPIO21 (ESP32) · GP4 (Pico) |
| SCL | A5 (Uno/Nano) · GPIO22 (ESP32) · GP5 (Pico) |
| LED | GND (LED off) |
| INT | optional, any interrupt pin (data‑ready) |

Use 400 kHz I²C.

### 2.5 Phone settings

Maximum brightness, auto‑brightness off, Night Shift / blue‑light filter /
True Tone / "vivid" colour modes off, battery saver off. The web page cannot
change these. The page keeps the screen awake with the Screen Wake Lock API.

## 3. Physical layer: colours and timing

### 3.1 Palette

Colours are fixed sRGB values filled over the whole screen. The palette index is
what the protocol carries.

| Index | Key | Colour | sRGB |
| --- | --- | --- | --- |
| 0 | K | black | `#000000` |
| 1 | R | red | `#FF0000` |
| 2 | G | green | `#00FF00` |
| 3 | B | blue | `#0000FF` |
| 4 | W | white | `#FFFFFF` |
| 5 | C | cyan | `#00FFFF` |
| 6 | M | magenta | `#FF00FF` |
| 7 | Y | yellow | `#FFFF00` |

Two **colour modes** exist:

| Mode | Value | Palette used for data | Bits per symbol |
| --- | --- | --- | --- |
| Robust | 0 | indices 0–4 (K R G B W), N = 5 | 2 |
| Dense | 1 | indices 0–7, N = 8 | 8/3 ≈ 2.67 |

Robust uses only colours whose sensor signatures differ by a large margin on
every channel. Dense adds the secondary colours, which a well‑shielded sensor
separates reliably after calibration.

### 3.2 Symbol slots

Time is divided into **slots** of duration **T**. One slot shows one colour.
`T` SHOULD be a whole number of display frames. Default: **T = 50 ms** (3
frames at 60 Hz). Allowed range: 2 display frames to 500 ms.

The receiver does not need to know `T` in advance; it measures it from every
frame's sync pattern (section 5.2) and from the data itself.

### 3.3 Sampling and classification (receiver)

The receiver samples the sensor continuously at ≥ 7 samples per slot. Each
sample is a vector `(r, g, b, c)` of raw counts.

1. **Normalise** each sample by the calibrated white and black readings:
   `x_ch = (raw_ch − black_ch) / (white_ch − black_ch)` for ch ∈ {r, g, b, c}.
   This removes the screen's white point, the sensor's channel gains and most
   ambient leakage.
2. **Classify** as the nearest calibrated colour (Euclidean distance in
   normalised `(r, g, b, c)` space), considering only the palette of the
   current mode (robust while reading the header, see 5.4).
3. A sample whose nearest and second‑nearest distances are within 20 % of each
   other is **ambiguous** (screen mid‑transition). Ambiguous samples are not
   classified; they are added to the duration of whichever segment follows.
4. **Segment**: consecutive samples of the same class are merged into a
   segment `(colour, duration)`. Segments shorter than `0.3·T` are glitches
   (transition artefacts) and are merged into the neighbouring segment.

Before any calibration exists, the receiver only needs to tell bright from
dark (clear channel above/below the midpoint of the running min/max), which is
enough to find the sync pattern.

### 3.4 Display behaviour that receivers MUST tolerate

- **Frame drops / jank**: a slot may last one display frame longer than `T`, and
  the following slot one frame shorter (the sender schedules by wall‑clock
  time, section 9).
- **LCD response**: 5–20 ms colour transitions with intermediate hues. Handled
  by the ambiguous‑sample rule and the glitch filter.
- **OLED PWM dimming**: 240–480 Hz brightness modulation at reduced brightness.
  Handled by maximum brightness plus integration times ≥ 4.8 ms or averaging.
- **Refresh rates** of 60, 90, 120, 144 Hz: `T` is snapped to whole frames by the
  sender and measured by the receiver.

## 4. Line code

### 4.1 Differential colour code

Data is carried as **digits**. Each digit selects the next colour relative to
the current one:

```
next_colour = (current_colour + 1 + digit) mod N          digit ∈ [0, N−2]
digit       = (colour − previous_colour − 1) mod N
```

Consequences:

- **Every data slot differs from the previous one.** The receiver clocks itself
  on colour changes; long same‑colour runs never occur in data, so timing drift
  between phone and board is irrelevant.
- A **hold** (the same colour for ≥ 2 slots) never occurs in data, which makes
  holds available as unambiguous control signals (sync, 5.2).
- `colour == previous_colour` or (robust mode) a colour index ≥ 5 is an invalid
  symbol; the receiver substitutes digit 0 and leaves the fix to Reed–Solomon.

### 4.2 Bytes to digits

| Mode | Digits per byte | Mapping (most significant digit first) |
| --- | --- | --- |
| Robust | 4 (base 4) | `b>>6 & 3, b>>4 & 3, b>>2 & 3, b & 3` |
| Dense | 3 (base 7) | `⌊b/49⌋, ⌊b/7⌋ mod 7, b mod 7` |

In dense mode 7³ = 343 > 256: a digit triple whose value exceeds 255 is invalid
and MAY be treated as a known **erasure** by an errors‑and‑erasures RS decoder.

## 5. Frame format

A frame is a fixed sequence of slots:

```
| SYNC (7) | CAL (7) | HEADER (64) | BODY ((L + 2t) × spb) | GUARD (1) |
```

`spb` = slots per byte = 4 (robust) or 3 (dense).

### 5.1 Lead‑in (optional, once)

When transmission starts, the sender MAY show `K W` alternating for a few
seconds followed by `K`. It lets the receiver set its sensor gain and get a
first estimate of `T`. Receivers MUST NOT depend on it, because they may start
listening at any point of a transmission.

### 5.2 SYNC

`W W W W W K K` — white held for 5 slots, then black held for 2 slots.

- A white hold ≥ 3 T can never appear inside data (4.1), so it marks a frame
  start even if the receiver lost track mid‑frame.
- The 2‑slot black hold gives a first measurement: `T ≈ duration(K hold) / 2`.
  A sync is accepted when `duration(W hold) / T` is between 3.5 and 7.
- The end of the black hold (the first colour change after it) is the phase
  reference for the first slot of CAL.

### 5.3 CAL (calibration)

`R G B C M Y W` — every non‑black colour once, one slot each (black and white
were already shown in SYNC). The receiver averages the central samples of each
slot to obtain the reference vector for each palette entry, which it uses to
classify every following slot of this frame (3.3). CAL is identical in both
modes, so it can be parsed before the header says which mode is in use.
A receiver SHOULD smooth references across frames (e.g. exponential average)
and SHOULD reject a frame whose CAL differs from the expected sequence in more
than 2 slots.

The last CAL colour, W (index 4), is the *previous colour* for the first header
digit.

### 5.4 HEADER

Always sent in **robust mode**, so the receiver can read it before knowing the
frame's mode. 8 information bytes followed by 8 Reed–Solomon parity bytes
(16 bytes → 64 slots); corrects up to 4 wrong bytes.

| Byte | Bits | Field | Meaning |
| --- | --- | --- | --- |
| 0 | 7–6 | version | `1` |
| 0 | 5–4 | mode | `0` robust, `1` dense, 2–3 reserved |
| 0 | 3–2 | reserved | MUST be 0 |
| 0 | 1–0 | type | `0` data frame, `1` XOR parity frame, 2–3 reserved |
| 1 | | session | Session ID (7.4) |
| 2 | | index | Data: chunk number 0…K−1. Parity: parity class 0…P−1 |
| 3 | | K | Number of data frames, 1…255 |
| 4 | | L | Data bytes per frame body, 1…255−2t |
| 5 | 7–4 | P | Number of parity frames, 0…15 |
| 5 | 3–0 | t | Body RS strength: 2t parity bytes, t ∈ 0…15 |
| 6–7 | | body CRC | CRC‑16 of the L body data bytes, big‑endian |

A receiver MUST discard the frame when the header fails RS decoding, has an
unknown version, non‑zero reserved bits, a reserved mode or type, `K = 0`,
`L = 0`, `L + 2t > 255`, or `index ≥ K` (data) / `index ≥ P` (parity).

### 5.5 BODY

`L` data bytes followed by `2t` Reed–Solomon parity bytes, line‑coded in the
frame's mode. The previous colour for the first body digit is the last header
slot's colour (always in 0–4, so valid in both modes).

### 5.6 GUARD

One slot: `K`, or `R` if the last body slot was `K`. It guarantees the white
hold of the next SYNC starts with a colour change, so the body's last slot can
always be measured.

## 6. Forward error correction and integrity

### 6.1 Reed–Solomon

Both codewords use the same family of codes:

- Field GF(2⁸), primitive polynomial `x⁸ + x⁴ + x³ + x² + 1` (0x11D), α = 2.
- Generator `g(x) = ∏_{i=0}^{2t−1} (x − αⁱ)` (first consecutive root 0).
- Systematic: the codeword is the message bytes followed by the remainder of
  `m(x)·x^{2t} mod g(x)`; the first byte sent is the highest‑degree coefficient.
- Shortened codes: any total length ≤ 255.

This is the same code as Python `reedsolo.RSCodec(nsym, prim=0x11d, fcr=0,
generator=2)` and most "RS(255,223)"‑style embedded libraries configured with
fcr = 0. A codeword with `e` wrong bytes and `s` known erasures is
recoverable when `2e + s ≤ 2t`. Receivers MAY implement errors‑only decoding
(the reference decoder does).

Header: `t = 4` (8 parity bytes), fixed. Body: `t` from the header, default 8.

### 6.2 CRC‑16 (per frame)

CRC‑16/CCITT‑FALSE (poly 0x1021, init 0xFFFF, no reflection, no final XOR;
check value `0x29B1` for ASCII `123456789`) over the L body data bytes, stored
in the header. It catches the rare RS *miscorrection* (a codeword with more than
t errors that decodes to a wrong but valid codeword) before a bad chunk enters
the message buffer.

### 6.3 CRC‑32 (per message)

CRC‑32/ISO‑HDLC (zlib/Ethernet; check value `0xCBF43926`) over the message
envelope (7.1). A message is only delivered to the application when this
matches.

### 6.4 Why errors are bursty, and why that is fine

One misread colour corrupts two digits (its own and the next one, because of
the differential code). Those may straddle two bytes, so a single colour error
costs at most 2 RS byte errors. With the default `t = 8` a body survives 4
independent colour errors; the header survives 2.

## 7. Transport: message, chunks, carousel, parity frames

### 7.1 Message envelope

```
| content type (1) | length N (2, little‑endian) | data (N) | CRC‑32 (4, little‑endian) |
```

| Content type | Meaning |
| --- | --- |
| 0 | Binary |
| 1 | UTF‑8 text |
| 2 | Wi‑Fi credentials, UTF‑8, ZXing `WIFI:` syntax: `WIFI:T:WPA;S:<ssid>;P:<password>;H:true;;` with `\ ; , : "` escaped by `\` |
| 3 | JSON (UTF‑8) |
| 4–127 | Reserved |
| 128–255 | Application defined |

### 7.2 Chunking

The envelope (`E = N + 7` bytes) is cut into `K = ⌈E / Lmax⌉` chunks of equal
length `L = ⌈E / K⌉`; the last chunk is zero‑padded. `Lmax` is the configured
chunk size (default 48) capped at `255 − 2t`. `K ≤ 255`, so the maximum message
size is 255 × (255 − 2t) − 7 bytes (≈ 61 KB at t = 8, though the link is far too
slow for that to be practical; see section 10).

### 7.3 XOR parity frames

With `P > 0`, parity frame `j` (0 ≤ j < P) carries the byte‑wise XOR of all data
chunks `i` with `i mod P = j`. Any single missing data frame in a class is
rebuilt as parity ⊕ (all other chunks of that class), so the receiver can finish
in the **same carousel round** in which it lost a frame instead of waiting a
full round for it to come back.

Default: one parity frame per 4 data frames, `P = min(15, ⌈K/4⌉)`, and `P = 0`
when `K = 1` (a single frame is already repeated by the carousel).
Classes are strided (`i mod P`), so a burst that wipes out several consecutive
frames hits different classes and stays recoverable.

### 7.4 Carousel and session

The sender repeats the frames forever in the order
`data 0 … data K−1, parity 0 … parity P−1`, until the user stops it.

The session ID identifies one message. The reference sender derives it from the
message content (`CRC‑32(envelope) XOR (mode << 7)`, low 8 bits), so resending
the same message keeps the receiver's partial progress, while a different
message almost always gets a different ID.

The receiver keys its buffers by `(session, K, L, P)`. A frame with a different
key discards the buffers and starts a new message. Duplicate frames from later
rounds are harmless. The receiver completes when every data chunk is
present (received or rebuilt) and the envelope CRC‑32 matches. If the CRC‑32
fails, it discards everything and keeps listening; the next round replaces the
bad chunk.

## 8. Receiver algorithm

The reference implementation is [`js/receiver.js`](../js/receiver.js)
(segments in, messages out); the sample‑to‑segment front end in 3.3 is
sensor‑specific. The Arduino library
[`arduino/RGBReceiver`](../arduino/RGBReceiver/README.md) ports the same state
machine and adds the front end (classifier, calibration from SYNC and CAL,
segmenter). Any port follows this state machine:

```
state = HUNT; T_est = median of the last 31 segment durations

on segment (colour, dur):
  T_ref = (state is IN_FRAME) ? T : T_est
  if colour == W and dur >= 3 · T_ref:            # sync hold: always (re)starts a frame
      state = SYNC_K; remember dur; return
  switch state:
    HUNT:   ignore
    SYNC_K: if colour == K and 3.5 <= W_dur/(dur/2) <= 7:
                T = dur / 2; symbols = []; state = IN_FRAME
            else state = HUNT
    IN_FRAME:
        n = (dur < 1.75 · T) ? 1 : round(dur / T)     # whole slots in this segment
        if n == 1: refine T (running mean of single-slot segments, seeded by the sync)
        append colour n times to symbols
        if len(symbols) == 7 + 64:                   # CAL + HEADER
            check CAL (≤ 2 mismatches), update colour references
            header = RS_decode(robust_bytes(symbols[7:71], prev=W), nsym=8)
            if bad header → state = HUNT
        if header and len(symbols) == 71 + (L + 2t)·spb:
            body = RS_decode(bytes(symbols[71:], mode, prev=symbols[70]), nsym=2t)
            if body ok and CRC16(body) == header.crc → deliver frame
            state = HUNT
```

`1.75 · T` as the split point lets a slot stretched by a dropped display frame
(up to 1.5 T at T = 2 frames) count as one slot, while two merged slots (a
misread colour equal to its neighbour) still count as two.

### 8.1 Camera test receiver

`receive.html` decodes with a phone or laptop camera instead of a colour
sensor, for testing senders without hardware. Its front end
([`js/sampler.js`](../js/sampler.js)) needs no calibration: because the palette
is exactly the eight on/off combinations of R, G and B, each camera frame's
centre region is averaged and every channel is thresholded halfway between the
lowest and highest value it showed in the last 4 s. Values within ±12 % of the
threshold are treated as "between colours" (a frame exposed across a symbol
change) and skipped, and runs shorter than about one camera frame are folded
into their neighbours. The resulting segments feed the reference decoder
unchanged. Cameras deliver 24–60 frames/s, so the sender needs `T ≥ 100 ms`
for a 30 fps camera (≥ 2.5 camera frames per symbol).

RAM estimate (ATmega328P, defaults): symbol buffer can be avoided by converting
digits to bytes on the fly (≤ 80 bytes body codeword + 16 header), message
buffer K·L bytes, parity buffer P·L bytes, RS decoder ≈ 150 bytes of stack plus
512 bytes of log/antilog tables (or put them in flash with `PROGMEM`).

## 9. Sender requirements

- Fill the whole viewport with the slot colour; nothing else visible except an
  optional status line at the top edge.
- Measure the display refresh period and snap `T` to a whole number of frames.
- Choose the slot to show from **elapsed time** (`slot = ⌊(now − t₀ + frame/2) / T⌋`),
  not by counting callbacks, so a dropped frame lengthens one slot and the next
  slot catches up instead of shifting everything after it.
- Keep the screen awake (Screen Wake Lock API) and go full screen where
  supported.
- Repeat the carousel until the user stops it.
- Offer a slow test pattern (each palette colour for 1 s) for checking the
  sensor and setting its gain.

## 10. Parameters, throughput and test vectors

### 10.1 Defaults

| Parameter | Default | Range |
| --- | --- | --- |
| Mode | robust (0) | 0, 1 |
| T | 50 ms (3 frames at 60 Hz) | 2 frames … 500 ms |
| Chunk size Lmax | 48 bytes | 1 … 255 − 2t |
| Body RS strength t | 8 (16 parity bytes) | 0 … 15 |
| Parity frames | 1 per 4 data frames | 0 … 15 frames |

### 10.2 Frame cost

`slots = 7 + 7 + 64 + (L + 2t)·spb + 1`

### 10.3 Time for one full carousel round (default t = 8, parity 1 per 4)

| Payload | Frames (K + P) | Robust, T = 50 ms | Robust, 33 ms | Dense, 50 ms | Dense, 33 ms |
| --- | --- | --- | --- | --- | --- |
| 20 B (short text) | 1 + 0 | 12.6 s | 8.4 s | 10.4 s | 6.9 s |
| 60 B (Wi‑Fi credentials) | 2 + 1 | 41.9 s | 27.9 s | 34.4 s | 22.9 s |
| 200 B | 5 + 2 | 109 s | 73 s | 89 s | 59 s |
| 1000 B | 21 + 6 | 7.5 min | 5 min | 6.1 min | 4.1 min |

On a clean link a receiver that starts listening at a random moment has the
whole message after at most one round plus one frame. With parity frames it
still finishes within that time when one frame per parity class is lost.

For the shortest wait with short messages, raise the chunk size so the whole
message fits in one frame and set parity to none.

### 10.4 Test vectors

Generated by `npm run vectors` (message `"Hi"`, content type 1, t = 4, default
session ID derivation). Bytes in hex; slots as palette keys.

Robust (mode 0):

```
envelope         01 02 00 48 69 d7 0a 85 5d
header info      40 1c 00 01 09 04 fb df
header codeword  40 1c 00 01 09 04 fb df 97 57 af a5 b5 a3 d3 7b
body codeword    01 02 00 48 69 d7 0a 85 5d 1d 14 26 45 4d 56 cc 9a
slots            WWWWWKKRGBCMYWRGBWKGRGBWKRGBWRGBRBWKGBGRWBGWBGKGWBKGWBRWBGKBKGKWRBRWKWBKRKGRWBWKRBWKRWKRGBKRWKGKBKWRBGBWGKBWRBKGRBWRKGBKGBWGWGWKGWRGRBKGWGRGRGKGKBK
```

Dense (mode 1):

```
envelope         01 02 00 48 69 d7 0a 85 5d
header info      50 9c 00 01 09 04 fb df
header codeword  50 9c 00 01 09 04 fb df 04 fa 83 d3 87 bd 4a 3a
body codeword    01 02 00 48 69 d7 0a 85 5d 1d 14 26 45 4d 56 cc 9a
slots            WWWWWKKRGBCMYWRBWKBKWKRGBWKRGWKRWRGBKRKWGRKGRKRGWKWBRWGBWBGWKWGBKWGRKGWKBRGRWGBWMYKBWCMKWYGWCGCBWMGCBWMCKRMKRWBWGMKBGWRGWGCGWMGWCK
```

## 11. Resilience summary

| Impairment | Effect | Countermeasure |
| --- | --- | --- |
| Phone and board clocks differ | Slot boundaries drift | Self‑clocking: a colour change every slot; T re‑measured every frame |
| Dropped display frames | One slot up to +1 frame long | Wall‑clock scheduling on the sender; 1.75 T split rule on the receiver |
| LCD transition hues, flicker | Short false colours | Ambiguity rule and 0.3 T glitch filter (3.3) |
| Different screens, white points, sensor gains | Colours read differently | Per‑frame calibration sequence; white/black normalisation |
| Ambient light | Black reads grey, colours wash out | Light shield; black reference from SYNC |
| A few misread colours | Wrong bytes | Reed–Solomon per header (t = 4) and body (t configurable) |
| RS miscorrection | Wrong bytes that look right | CRC‑16 per frame, CRC‑32 per message |
| Hand moves, sensor slips, a whole frame lost | Missing chunk | XOR parity frames rebuild it in the same round; otherwise the carousel resends it |
| Receiver starts mid‑message | Partial frame | Hold‑based sync restarts on the next frame; chunks collected in any order |
| Sender switches to another message | Mixed chunks | Session ID, K, L and P key the buffers |
| No return channel | Cannot request retransmission | Endless carousel + parity frames |

## 12. Future extensions

Reserved fields allow these without breaking v1 receivers (which reject
unknown versions, modes and frame types):

- Reed–Solomon across frames (frame type 2) to recover several lost frames per
  class.
- A 4‑level brightness mode for monochrome light sensors.
- Compression (content types ≥ 128 by application agreement until standardised).
- Return channel by an LED on the board and the phone camera, for
  acknowledgement and early stop.
- A camera‑based browser receiver for testing without hardware.
