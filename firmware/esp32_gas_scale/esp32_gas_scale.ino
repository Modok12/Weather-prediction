// Smart gas cylinder scale: ESP32 + HX711 + load cell.
//
// The cylinder stands on a platform over a load cell. The ESP32 starts its own
// Wi-Fi hotspot ("GasScale"), so it works without home Wi-Fi or internet.
// Connect your phone to it, then open http://192.168.4.1
//
//   GET /        simple page showing gas level
//   GET /weight  JSON: {"grossKg":20.55,"gasKg":6.05,"percent":48.4}
//   GET /tare    zero the scale (run once with the platform EMPTY)
//
// Libraries (Arduino Library Manager): "HX711" by Bogdan Necula.
// Board: any ESP32 dev board (Tools > Board > ESP32 Dev Module).

#include <WiFi.h>
#include <WebServer.h>
#include <Preferences.h>
#include "HX711.h"

// ---- Settings: edit these for your cylinder ----
const float CYLINDER_CAPACITY_KG = 12.5;  // 3, 5, 6, 12.5, 25 or 50
const float CYLINDER_TARE_KG = 14.5;      // "TW" stamped on the cylinder collar
// Found by calibration: put a known weight on the scale and adjust until it reads right.
const float CALIBRATION_FACTOR = 21500.0;
const int LOW_PERCENT = 20;

const char *AP_SSID = "GasScale";
const char *AP_PASSWORD = "cookgas123";  // at least 8 characters

const int HX711_DOUT = 16;
const int HX711_SCK = 4;
const int LED_PIN = 2;  // blinks when gas is low
// -----------------------------------------------

HX711 scale;
WebServer server(80);
Preferences prefs;
float lastGrossKg = 0;

float readGrossKg() {
  if (!scale.wait_ready_timeout(1000)) return lastGrossKg;
  float kg = scale.get_units(10);
  return kg < 0 ? 0 : kg;
}

float gasKg(float gross) {
  float g = gross - CYLINDER_TARE_KG;
  if (g < 0) g = 0;
  if (g > CYLINDER_CAPACITY_KG) g = CYLINDER_CAPACITY_KG;
  return g;
}

float percentOf(float gas) {
  return gas / CYLINDER_CAPACITY_KG * 100.0;
}

void sendCors() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Cache-Control", "no-store");
}

void handleWeight() {
  lastGrossKg = readGrossKg();
  float gas = gasKg(lastGrossKg);
  String json = "{\"grossKg\":" + String(lastGrossKg, 2) +
                ",\"gasKg\":" + String(gas, 2) +
                ",\"percent\":" + String(percentOf(gas), 1) + "}";
  sendCors();
  server.send(200, "application/json", json);
}

void handleTare() {
  scale.tare(20);
  prefs.putLong("offset", scale.get_offset());
  sendCors();
  server.send(200, "text/plain", "Scale zeroed. Now place the cylinder on it.");
}

void handleRoot() {
  float gas = gasKg(lastGrossKg);
  int pct = (int)round(percentOf(gas));
  String color = pct <= 5 ? "#dc2626" : pct <= LOW_PERCENT ? "#ea580c" : pct <= 50 ? "#ca8a04" : "#15803d";
  String html =
      "<!doctype html><html><head><meta charset='utf-8'>"
      "<meta name='viewport' content='width=device-width,initial-scale=1'>"
      "<meta http-equiv='refresh' content='10'><title>Gas Scale</title>"
      "<style>body{font-family:system-ui,sans-serif;text-align:center;padding:24px;background:#f4f6f5}"
      ".bar{height:28px;background:#dde3e0;border-radius:14px;overflow:hidden;margin:16px auto;max-width:320px}"
      ".bar div{height:100%;background:" + color + ";width:" + String(pct) + "%}"
      "h1{font-size:3rem;margin:8px 0}</style></head><body>"
      "<p>Cooking gas remaining</p><h1>" + String(pct) + "%</h1>"
      "<div class='bar'><div></div></div>"
      "<p>" + String(gas, 1) + " of " + String(CYLINDER_CAPACITY_KG, 1) + " kg</p>"
      "<p style='color:#5f6b66'>Cylinder weight: " + String(lastGrossKg, 2) + " kg</p>"
      "</body></html>";
  server.send(200, "text/html", html);
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);

  scale.begin(HX711_DOUT, HX711_SCK);
  scale.set_scale(CALIBRATION_FACTOR);
  prefs.begin("gasscale", false);
  if (prefs.isKey("offset")) {
    scale.set_offset(prefs.getLong("offset"));
  } else {
    // First boot: assume the platform is empty.
    scale.tare(20);
    prefs.putLong("offset", scale.get_offset());
  }

  WiFi.softAP(AP_SSID, AP_PASSWORD);
  Serial.print("Connect to Wi-Fi '");
  Serial.print(AP_SSID);
  Serial.print("' and open http://");
  Serial.println(WiFi.softAPIP());

  server.on("/", handleRoot);
  server.on("/weight", handleWeight);
  server.on("/tare", handleTare);
  server.begin();
}

unsigned long lastSample = 0;

void loop() {
  server.handleClient();

  if (millis() - lastSample > 5000) {
    lastSample = millis();
    lastGrossKg = readGrossKg();
    Serial.printf("gross %.2f kg, gas %.2f kg\n", lastGrossKg, gasKg(lastGrossKg));
  }

  // Blink the LED while gas is low.
  bool low = percentOf(gasKg(lastGrossKg)) <= LOW_PERCENT && lastGrossKg > 1;
  digitalWrite(LED_PIN, low && (millis() / 500) % 2);
}
