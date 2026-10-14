// Parser for Wi-Fi credential messages (content type 2): the ZXing "WIFI:" syntax,
// e.g. WIFI:T:WPA;S:My network;P:secret;H:true;;  with \ ; , : " escaped by a backslash.
#pragma once

#include <stddef.h>
#include <stdint.h>

struct RGBWifiCredentials {
  char ssid[33];       // up to 32 bytes
  char password[64];   // up to 63 bytes
  char security[16];   // "WPA", "WEP", "nopass", ... (empty if not given)
  bool hidden;
};

// Returns false if the text is not a WIFI: string or a field does not fit.
bool rgbParseWifi(const uint8_t *data, size_t length, RGBWifiCredentials &out);
