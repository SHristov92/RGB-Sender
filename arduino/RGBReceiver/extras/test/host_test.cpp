// Host test driver: runs the library's decoder on a PC. Reads lines from stdin:
//   S <color> <duration_us>          a colour segment
//   X <time_us> <r> <g> <b> <c>      a raw sensor reading
//   W <hex>                          parse Wi-Fi credentials, print "WIFI ssid|password|security|hidden"
// and prints one line per message: "MSG <type> <recovered> <hex data>", plus a
// summary of events at the end: "EVENTS sync=.. ok=.. failed=.. calreset=..".
#include <stdio.h>
#include <string.h>

#include "RGBReceiver.h"

static uint8_t buffer[rgbBufferSize(1200, 48, 8, 4)];
static unsigned counts[8];
static unsigned fails[8];

static void onEvent(const RGBEvent &e) {
  counts[e.type]++;
  if (e.type == RGB_EVENT_FRAME_FAILED) fails[e.reason]++;
}

int main() {
  RGBReceiver rx(buffer, sizeof(buffer), 255);
  rx.onEvent(onEvent);
  char line[600];
  while (fgets(line, sizeof(line), stdin)) {
    bool done = false;
    if (line[0] == 'W') {
      uint8_t bytes[256];
      size_t n = 0;
      unsigned v;
      for (const char *p = line + 2; n < sizeof(bytes) && sscanf(p, "%2x", &v) == 1; p += 2) bytes[n++] = (uint8_t)v;
      RGBWifiCredentials w;
      if (rgbParseWifi(bytes, n, w)) printf("WIFI %s|%s|%s|%d\n", w.ssid, w.password, w.security, w.hidden);
      else printf("WIFI invalid\n");
      continue;
    }
    if (line[0] == 'S') {
      unsigned color, dur;
      if (sscanf(line + 1, "%u %u", &color, &dur) == 2) done = rx.pushSegment((uint8_t)color, dur);
    } else if (line[0] == 'X') {
      unsigned t, r, g, b, c;
      if (sscanf(line + 1, "%u %u %u %u %u", &t, &r, &g, &b, &c) == 5) {
        RGBSample s = {(uint16_t)r, (uint16_t)g, (uint16_t)b, (uint16_t)c};
        done = rx.pushSample(s, t);
      }
    }
    if (done) {
      const RGBMessage &m = rx.message();
      printf("MSG %u %u ", m.contentType, m.recovered);
      for (uint16_t i = 0; i < m.length; i++) printf("%02x", m.data[i]);
      printf("\n");
      fflush(stdout);
    }
  }
  printf("EVENTS sync=%u ok=%u failed=%u (cal=%u header=%u body=%u aborted=%u large=%u) corrupt=%u calreset=%u\n",
         counts[RGB_EVENT_SYNC], counts[RGB_EVENT_FRAME_OK], counts[RGB_EVENT_FRAME_FAILED], fails[RGB_FAIL_CALIBRATION],
         fails[RGB_FAIL_HEADER], fails[RGB_FAIL_BODY], fails[RGB_FAIL_ABORTED], fails[RGB_FAIL_TOO_LARGE],
         counts[RGB_EVENT_MESSAGE_CORRUPT], counts[RGB_EVENT_CALIBRATION_RESET]);
  return 0;
}
