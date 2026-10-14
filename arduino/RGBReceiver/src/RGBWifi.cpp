#include "RGBWifi.h"

#include <string.h>

// Copies one field value up to the next unescaped ';', unescaping backslashes.
static bool readValue(const uint8_t *&p, const uint8_t *end, char *dst, size_t cap) {
  size_t n = 0;
  while (p < end && *p != ';') {
    uint8_t c = *p++;
    if (c == '\\' && p < end) c = *p++;
    if (n + 1 >= cap) return false;
    dst[n++] = (char)c;
  }
  dst[n] = 0;
  if (p < end) p++;  // skip ';'
  return true;
}

bool rgbParseWifi(const uint8_t *data, size_t length, RGBWifiCredentials &out) {
  memset(&out, 0, sizeof(out));
  const uint8_t *p = data, *end = data + length;
  if (length < 5 || memcmp(p, "WIFI:", 5) != 0) return false;
  p += 5;
  char scratch[8];
  while (p < end && *p != ';') {
    // Field name up to ':'.
    const uint8_t *name = p;
    while (p < end && *p != ':') p++;
    if (p >= end) return false;
    size_t nameLen = p - name;
    p++;
    bool ok;
    if (nameLen == 1 && *name == 'S') ok = readValue(p, end, out.ssid, sizeof(out.ssid));
    else if (nameLen == 1 && *name == 'P') ok = readValue(p, end, out.password, sizeof(out.password));
    else if (nameLen == 1 && *name == 'T') ok = readValue(p, end, out.security, sizeof(out.security));
    else if (nameLen == 1 && *name == 'H') {
      ok = readValue(p, end, scratch, sizeof(scratch));
      out.hidden = ok && strcmp(scratch, "true") == 0;
    } else {
      // Unknown field: skip its value.
      while (p < end && *p != ';') p += (*p == '\\' && p + 1 < end) ? 2 : 1;
      if (p < end) p++;
      ok = true;
    }
    if (!ok) return false;
  }
  return out.ssid[0] != 0;
}
