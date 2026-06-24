#include <Arduino_GFX_Library.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <Wire.h>

// Nexus Player Cube v0.3 for touch and non-touch LILYGO T-Display-S3 boards.
// Configure only these three values before uploading.
const char *WIFI_SSID = "YOUR_WIFI_NAME";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char *CORE_BASE_URL = "http://sublim3-nexus.local:3000";

constexpr uint16_t C_BLACK = 0x0000;
constexpr uint16_t C_WHITE = 0xFFFF;
constexpr uint16_t C_RED = 0xF800;
constexpr uint16_t C_GREEN = 0x07E0;
constexpr uint16_t C_CYAN = 0x07FF;
constexpr uint16_t C_MAGENTA = 0xF81F;
constexpr uint16_t C_YELLOW = 0xFFE0;
constexpr uint16_t C_MUTED = 0x8410;

constexpr int PIN_POWER_ON = 15;
constexpr int PIN_LCD_BL = 38;
constexpr int PIN_BUTTON_LEFT = 0;
constexpr int PIN_BUTTON_RIGHT = 14;
constexpr int PIN_TOUCH_SDA = 18;
constexpr int PIN_TOUCH_SCL = 17;
constexpr int PIN_TOUCH_INT = 16;
constexpr int PIN_TOUCH_RST = 21;
constexpr uint8_t TOUCH_ADDRESS = 0x15;
constexpr unsigned long SYNC_INTERVAL_MS = 5000;
constexpr size_t MAX_CHOICES = 12;
constexpr size_t MAX_RESOURCES = 8;
constexpr size_t MAX_CONDITIONS = 8;

Arduino_DataBus *bus = new Arduino_ESP32PAR8(
    7, 6, 8, 9, 39, 40, 41, 42, 45, 46, 47, 48);
Arduino_GFX *display = new Arduino_ST7789(
    bus, 5, 1, true, 170, 320, 35, 0, 35, 0);
Preferences preferences;

struct ApiResponse {
  int status;
  String body;
};

struct ResourceValue {
  String id;
  String label;
  float current;
  float maximum;
  String value;
};

String playerToken;
String campaignId;
String characterId;
String characterName = "Player";
String sceneTitle;
String activeName;
String conditions[MAX_CONDITIONS];
ResourceValue resources[MAX_RESOURCES];
size_t conditionCount = 0;
size_t resourceCount = 0;
int battleRound = 0;
bool battleActive = false;
bool myTurn = false;
bool leftWasDown = false;
bool rightWasDown = false;
int currentPage = 0;
unsigned long lastSyncAt = 0;
unsigned long bothPressedAt = 0;
bool touchAvailable = false;
bool touchWasDown = false;
int touchStartX = 0;
int touchStartY = 0;
int touchLastX = 0;
int touchLastY = 0;
unsigned long lastTouchAt = 0;
unsigned long touchStartedAt = 0;

void clearScreen(uint16_t color = C_BLACK) {
  display->fillScreen(color);
  display->setTextWrap(true);
}

void heading(const String &title, uint16_t color = C_CYAN) {
  clearScreen();
  display->setTextColor(color);
  display->setTextSize(2);
  display->setCursor(10, 9);
  display->println(title);
  display->drawFastHLine(10, 31, 300, C_MUTED);
  display->setTextColor(C_WHITE);
}

void statusScreen(const String &title, const String &detail,
                  uint16_t color = C_CYAN) {
  heading(title, color);
  display->setTextSize(2);
  display->setCursor(10, 48);
  display->println(detail);
}

void drawBootScreen(const String &stage, const String &detail = "") {
  clearScreen();
  display->setTextColor(C_GREEN);
  display->setTextSize(3);
  display->setCursor(12, 8);
  display->print("SubLim3 Nexus");
  display->setTextColor(C_WHITE);
  display->setTextSize(1);
  display->setCursor(14, 40);
  display->print("Player Cube");
  display->drawFastHLine(12, 55, 296, C_MUTED);
  display->setTextColor(C_WHITE);
  display->setTextSize(2);
  display->setCursor(12, 74);
  display->println(stage);
  display->setTextColor(C_MUTED);
  display->setTextSize(1);
  display->setCursor(13, 108);
  display->println(detail);
}

void drawBootPulse(unsigned int frame) {
  display->fillRect(268, 142, 42, 14, C_BLACK);
  for (int index = 0; index < 3; index++) {
    uint16_t color = index == (int)(frame % 3) ? C_CYAN : C_MUTED;
    display->fillCircle(276 + index * 13, 149, 3, color);
  }
}

bool readTouchPoint(bool &pressed, int &rawX, int &rawY) {
  Wire.beginTransmission(TOUCH_ADDRESS);
  Wire.write(0x02);  // Finger count, X high/low, Y high/low.
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(TOUCH_ADDRESS, (uint8_t)5) != 5) return false;

  uint8_t fingers = Wire.read();
  uint8_t xHigh = Wire.read();
  uint8_t xLow = Wire.read();
  uint8_t yHigh = Wire.read();
  uint8_t yLow = Wire.read();
  pressed = fingers > 0;
  if (pressed) {
    rawX = ((xHigh & 0x0F) << 8) | xLow;
    rawY = ((yHigh & 0x0F) << 8) | yLow;
  }
  return true;
}

bool beginTouch() {
  Wire.begin(PIN_TOUCH_SDA, PIN_TOUCH_SCL);
  pinMode(PIN_TOUCH_INT, INPUT_PULLUP);
  pinMode(PIN_TOUCH_RST, OUTPUT);
  digitalWrite(PIN_TOUCH_RST, LOW);
  delay(8);
  digitalWrite(PIN_TOUCH_RST, HIGH);
  delay(60);

  Wire.beginTransmission(TOUCH_ADDRESS);
  return Wire.endTransmission() == 0;
}

// Tap: +/-1. Swipe: +/-2. Long press: +/-3. Sign indicates screen side/direction.
int pollTouchAction() {
  if (!touchAvailable || millis() - lastTouchAt < 120) return 0;
  bool pressed = false;
  int rawX = touchLastX;
  int rawY = touchLastY;
  if (!readTouchPoint(pressed, rawX, rawY)) return 0;

  // The panel reports portrait coordinates. The display uses rotation 1.
  int screenX = constrain(rawY, 0, 319);
  int screenY = constrain(169 - rawX, 0, 169);
  if (pressed) {
    if (!touchWasDown) {
      touchStartX = screenX;
      touchStartY = screenY;
      touchStartedAt = millis();
    }
    touchLastX = rawX;
    touchLastY = rawY;
    touchWasDown = true;
    return 0;
  }

  if (!touchWasDown) return 0;
  touchWasDown = false;
  lastTouchAt = millis();
  int endX = constrain(touchLastY, 0, 319);
  int endY = constrain(169 - touchLastX, 0, 169);
  int deltaX = endX - touchStartX;
  int deltaY = endY - touchStartY;

  if (abs(deltaX) > 45 && abs(deltaX) > abs(deltaY)) {
    return deltaX < 0 ? 2 : -2;  // Swipe left advances; swipe right goes back.
  }
  int side = endX < 160 ? -1 : 1;
  return millis() - touchStartedAt >= 650 ? side * 3 : side;
}

String deviceName() {
  uint64_t chip = ESP.getEfuseMac();
  char suffix[9];
  snprintf(suffix, sizeof(suffix), "%08lX", (unsigned long)(chip & 0xFFFFFFFF));
  return "Nexus Cube " + String(suffix);
}

bool connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return true;

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(true);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);

  for (int attempt = 1; attempt <= 3; attempt++) {
    drawBootScreen("Joining table network", "Connection attempt " + String(attempt) + " of 3");
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    unsigned long started = millis();
    unsigned int frame = 0;
    while (WiFi.status() != WL_CONNECTED && millis() - started < 20000) {
      drawBootPulse(frame++);
      delay(250);
    }
    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("[wifi] connected as " + WiFi.localIP().toString());
      return true;
    }
    WiFi.disconnect(false, false);
    delay(1000);
  }

  drawBootScreen("Connection unavailable", "Retrying automatically");
  return false;
}

ApiResponse apiRequest(const char *method, const String &path,
                       const String &body = "", bool authorized = true) {
  if (WiFi.status() != WL_CONNECTED) return {-1000, "wifi_offline"};

  HTTPClient http;
  http.setTimeout(7000);
  http.useHTTP10(true);
  if (!http.begin(String(CORE_BASE_URL) + path)) return {-1001, "invalid_url"};
  http.addHeader("Accept", "application/json");
  if (body.length()) http.addHeader("Content-Type", "application/json");
  if (authorized && playerToken.length()) {
    http.addHeader("Authorization", "Bearer " + playerToken);
  }

  int status = http.sendRequest(method, body);
  String responseBody = status > 0 ? http.getString() : http.errorToString(status);
  Serial.printf("[core] %s %s -> %d\n", method, path.c_str(), status);
  http.end();
  return {status, responseBody};
}

bool parseChoices(const String &path, const char *idKey, const char *labelKey,
                  String ids[], String labels[], size_t &count) {
  ApiResponse response = apiRequest("GET", path, "", false);
  if (response.status != 200) {
    statusScreen("CORE ERROR", "HTTP " + String(response.status) + "\n" + response.body, C_RED);
    return false;
  }

  JsonDocument document;
  if (deserializeJson(document, response.body)) {
    statusScreen("DATA ERROR", "Invalid discovery response", C_RED);
    return false;
  }

  count = 0;
  for (JsonObject item : document["data"].as<JsonArray>()) {
    if (count >= MAX_CHOICES) break;
    ids[count] = item[idKey].as<String>();
    labels[count] = item[labelKey].as<String>();
    count++;
  }
  return count > 0;
}

String chooseItem(const String &title, String ids[], String labels[], size_t count) {
  size_t selected = 0;
  while (digitalRead(PIN_BUTTON_LEFT) == LOW || digitalRead(PIN_BUTTON_RIGHT) == LOW) delay(20);

  while (true) {
    heading(title, C_MAGENTA);
    display->setTextSize(2);
    display->setCursor(10, 48);
    display->println(labels[selected]);
    display->setTextColor(C_MUTED);
    display->setTextSize(1);
    display->setCursor(10, 137);
    display->print(touchAvailable ? "TAP LEFT: next   RIGHT: choose" :
                                    "LEFT: next       RIGHT: choose");

    int touchAction = 0;
    while (digitalRead(PIN_BUTTON_LEFT) == HIGH &&
           digitalRead(PIN_BUTTON_RIGHT) == HIGH && !touchAction) {
      touchAction = pollTouchAction();
      delay(20);
    }
    if (touchAction > 0) return ids[selected];
    if (touchAction < 0) {
      selected = (selected + 1) % count;
      continue;
    }
    if (digitalRead(PIN_BUTTON_RIGHT) == LOW) {
      while (digitalRead(PIN_BUTTON_RIGHT) == LOW) delay(20);
      return ids[selected];
    }
    if (digitalRead(PIN_BUTTON_LEFT) == LOW) {
      while (digitalRead(PIN_BUTTON_LEFT) == LOW) delay(20);
      selected = (selected + 1) % count;
    }
  }
}

bool selectAssignment() {
  String ids[MAX_CHOICES];
  String labels[MAX_CHOICES];
  size_t count = 0;
  if (!parseChoices("/api/v1/discovery/campaigns", "campaign_id", "name", ids, labels, count)) {
    statusScreen("NO CAMPAIGNS", "Create a campaign in Nexus Core", C_YELLOW);
    return false;
  }
  campaignId = chooseItem("SELECT CAMPAIGN", ids, labels, count);

  count = 0;
  String path = "/api/v1/discovery/campaigns/" + campaignId + "/characters";
  if (!parseChoices(path, "character_id", "character_name", ids, labels, count)) {
    statusScreen("NO CHARACTERS", "Add a character to this campaign", C_YELLOW);
    return false;
  }
  characterId = chooseItem("SELECT CHARACTER", ids, labels, count);

  preferences.putString("campaign", campaignId);
  preferences.putString("character", characterId);
  preferences.remove("token");
  playerToken = "";
  return true;
}

bool pairPlayer() {
  if (!campaignId.length() || !characterId.length()) return false;
  String body = "{\"role\":\"player\",\"campaign_id\":\"" + campaignId +
                "\",\"character_id\":\"" + characterId +
                "\",\"device_name\":\"" + deviceName() + "\"}";
  statusScreen("PAIRING", "Registering Player Cube", C_YELLOW);
  ApiResponse response = apiRequest("POST", "/api/v1/auth/pair", body, false);
  if (response.status != 201) {
    statusScreen("PAIRING FAILED", "HTTP " + String(response.status), C_RED);
    return false;
  }

  JsonDocument document;
  if (deserializeJson(document, response.body)) return false;
  playerToken = document["token"].as<String>();
  if (!playerToken.length()) return false;
  preferences.putString("token", playerToken);
  return true;
}

bool ensureAuthorized() {
  if (!playerToken.length()) return pairPlayer();
  ApiResponse response = apiRequest("GET", "/api/v1/auth/me");
  if (response.status == 200) return true;
  if (response.status == 401) {
    playerToken = "";
    preferences.remove("token");
    return pairPlayer();
  }
  return false;
}

bool fetchCharacter() {
  String path = "/api/v1/campaigns/" + campaignId + "/characters/" + characterId;
  ApiResponse response = apiRequest("GET", path);
  if (response.status == 401 && pairPlayer()) response = apiRequest("GET", path);
  if (response.status != 200) return false;

  JsonDocument document;
  if (deserializeJson(document, response.body)) return false;
  JsonObject character = document["data"];
  characterName = character["character_name"] | "Player";

  resourceCount = 0;
  for (JsonPair item : character["resources"].as<JsonObject>()) {
    if (resourceCount >= MAX_RESOURCES) break;
    JsonObject resource = item.value().as<JsonObject>();
    resources[resourceCount].id = item.key().c_str();
    resources[resourceCount].label = resource["label"] | item.key().c_str();
    resources[resourceCount].current = resource["current"].as<float>();
    resources[resourceCount].maximum = resource["maximum"].as<float>();
    resources[resourceCount].value = String(resources[resourceCount].current, 0) + "/" +
                                     String(resources[resourceCount].maximum, 0);
    resourceCount++;
  }

  conditionCount = 0;
  for (JsonVariant condition : character["conditions"].as<JsonArray>()) {
    if (conditionCount >= MAX_CONDITIONS) break;
    conditions[conditionCount++] = condition.as<String>();
  }
  return true;
}

bool fetchSession() {
  ApiResponse response = apiRequest("GET", "/api/v1/campaigns/" + campaignId + "/session");
  if (response.status != 200) return false;

  JsonDocument document;
  if (deserializeJson(document, response.body)) return false;
  JsonObject session = document["data"];
  sceneTitle = session["scene"]["title"] | "";
  battleActive = String(session["mode"] | "game") == "battle";
  battleRound = session["battle"]["round"] | 0;
  activeName = "";
  myTurn = false;

  JsonArray combatants = session["battle"]["combatants"].as<JsonArray>();
  int turnIndex = session["battle"]["turn_index"] | 0;
  if (battleActive && turnIndex >= 0 && turnIndex < (int)combatants.size()) {
    JsonObject active = combatants[turnIndex];
    activeName = active["name"] | "";
    myTurn = String(active["character_id"] | "") == characterId;
  }
  return true;
}

void renderOverview() {
  heading(characterName, myTurn ? C_GREEN : C_CYAN);
  display->setTextSize(2);
  display->setCursor(10, 43);
  if (myTurn) {
    display->setTextColor(C_GREEN);
    display->println("YOUR TURN");
  } else if (battleActive) {
    display->setTextColor(C_YELLOW);
    display->println("Turn: " + activeName);
  } else {
    display->println(sceneTitle.length() ? sceneTitle : "Ready at the table");
  }
  display->setTextColor(C_WHITE);
  if (resourceCount) {
    display->setCursor(10, 82);
    display->print(resources[0].label + ": ");
    display->setTextColor(C_GREEN);
    display->println(resources[0].value);
  }
}

void renderResources() {
  heading("RESOURCES", C_MAGENTA);
  display->setTextSize(2);
  int y = 42;
  if (!resourceCount) {
    display->setCursor(10, y);
    display->println("None configured");
  }
  for (size_t index = 0; index < resourceCount && index < (touchAvailable ? 2 : 4); index++) {
    display->setCursor(10, y);
    display->setTextColor(C_WHITE);
    display->print(resources[index].label + ": ");
    display->setTextColor(C_GREEN);
    display->println(resources[index].value);
    y += 28;
  }
  bool hasHealth = false;
  for (size_t index = 0; index < resourceCount; index++) {
    if (resources[index].id == "health") hasHealth = true;
  }
  if (touchAvailable && hasHealth) {
    display->drawRect(10, 104, 140, 38, C_RED);
    display->drawRect(170, 104, 140, 38, C_GREEN);
    display->setTextSize(2);
    display->setTextColor(C_RED);
    display->setCursor(57, 115);
    display->print("- HP");
    display->setTextColor(C_GREEN);
    display->setCursor(215, 115);
    display->print("+ HP");
  }
}

void renderConditions() {
  heading("CONDITIONS", C_YELLOW);
  display->setTextSize(2);
  display->setCursor(10, 42);
  if (!conditionCount) {
    display->setTextColor(C_GREEN);
    display->println("None");
    return;
  }
  display->setTextColor(C_WHITE);
  for (size_t index = 0; index < conditionCount && index < 4; index++) {
    display->println("- " + conditions[index]);
  }
}

void renderTable() {
  heading("TABLE OVERVIEW", C_CYAN);
  display->setTextSize(2);
  display->setCursor(10, 42);
  display->println(sceneTitle.length() ? sceneTitle : "No active scene");
  display->setCursor(10, 82);
  if (battleActive) {
    display->println("Round " + String(battleRound));
    display->setTextColor(myTurn ? C_GREEN : C_YELLOW);
    display->println(myTurn ? "YOUR TURN" : activeName);
  } else {
    display->setTextColor(C_MUTED);
    display->println("Game mode");
  }
}

void renderPage() {
  if (currentPage == 0) renderOverview();
  else if (currentPage == 1) renderResources();
  else if (currentPage == 2) renderConditions();
  else renderTable();
  display->setTextColor(C_MUTED);
  display->setTextSize(1);
  display->setCursor(10, 157);
  if (touchAvailable && currentPage == 1) display->print("TAP: 1  HOLD: 5  SWIPE: pages");
  else display->print(touchAvailable ? "SWIPE or tap screen sides" :
                                       "LEFT: previous     RIGHT: next");
}

bool syncAll() {
  // Rate-limit retries too; an offline Core should not be hammered every loop.
  lastSyncAt = millis();
  if (!fetchCharacter()) return false;
  if (!fetchSession()) return false;
  renderPage();
  return true;
}

void adjustHealth(int delta) {
  int healthIndex = -1;
  for (size_t index = 0; index < resourceCount; index++) {
    if (resources[index].id == "health") healthIndex = index;
  }
  if (healthIndex < 0) {
    statusScreen("HP UNAVAILABLE", "No health resource", C_YELLOW);
    delay(700);
    renderPage();
    return;
  }

  ResourceValue &health = resources[healthIndex];
  health.current = max(0.0f, min(health.maximum, health.current + delta));
  health.value = String(health.current, 0) + "/" + String(health.maximum, 0);
  renderPage();

  String path = "/api/v1/campaigns/" + campaignId + "/characters/" + characterId +
                "/resources/health/adjust";
  ApiResponse response = apiRequest("POST", path, "{\"delta\":" + String(delta) + "}");
  if (response.status != 200) {
    statusScreen("HP UPDATE FAILED", "HTTP " + String(response.status), C_RED);
    delay(800);
  }
  syncAll();
}

void clearAssignment() {
  preferences.clear();
  playerToken = "";
  campaignId = "";
  characterId = "";
  statusScreen("UNPAIRED", "Restarting setup", C_YELLOW);
  delay(700);
  if (selectAssignment() && pairPlayer()) syncAll();
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_POWER_ON, OUTPUT);
  digitalWrite(PIN_POWER_ON, HIGH);
  pinMode(PIN_LCD_BL, OUTPUT);
  digitalWrite(PIN_LCD_BL, HIGH);
  pinMode(PIN_BUTTON_LEFT, INPUT_PULLUP);
  pinMode(PIN_BUTTON_RIGHT, INPUT_PULLUP);
  display->begin();
  touchAvailable = beginTouch();

  preferences.begin("nexus-cube", false);
  campaignId = preferences.getString("campaign", "");
  characterId = preferences.getString("character", "");
  playerToken = preferences.getString("token", "");

  drawBootScreen("Starting Player Cube", touchAvailable ? "Touch interface ready" :
                                                          "Button interface ready");
  drawBootPulse(0);
  delay(600);
  if (!connectWiFi()) return;
  drawBootScreen("Finding Nexus Core", "Checking the local table service");
  drawBootPulse(1);
  if ((!campaignId.length() || !characterId.length()) && !selectAssignment()) return;
  if (!ensureAuthorized()) return;
  drawBootScreen("Syncing character", "Loading the latest table state");
  drawBootPulse(2);
  if (!syncAll()) drawBootScreen("Core unavailable", "Retrying automatically");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    drawBootScreen("Connection interrupted", "Rejoining the table network");
    if (connectWiFi() && ensureAuthorized()) syncAll();
    delay(500);
    return;
  }

  if (!campaignId.length() || !characterId.length()) {
    if (millis() - lastSyncAt >= SYNC_INTERVAL_MS) {
      lastSyncAt = millis();
      if (selectAssignment() && pairPlayer()) syncAll();
    }
    delay(100);
    return;
  }

  bool leftDown = digitalRead(PIN_BUTTON_LEFT) == LOW;
  bool rightDown = digitalRead(PIN_BUTTON_RIGHT) == LOW;
  int touchAction = pollTouchAction();

  if (leftDown && rightDown) {
    if (!bothPressedAt) bothPressedAt = millis();
    if (millis() - bothPressedAt > 3000) {
      bothPressedAt = 0;
      clearAssignment();
      while (digitalRead(PIN_BUTTON_LEFT) == LOW || digitalRead(PIN_BUTTON_RIGHT) == LOW) delay(20);
    }
  } else {
    bothPressedAt = 0;
    if (leftDown && !leftWasDown) {
      currentPage = (currentPage + 3) % 4;
      renderPage();
    }
    if (rightDown && !rightWasDown) {
      currentPage = (currentPage + 1) % 4;
      renderPage();
    }
    if (currentPage == 1 && (abs(touchAction) == 1 || abs(touchAction) == 3)) {
      int amount = abs(touchAction) == 3 ? 5 : 1;
      adjustHealth(touchAction < 0 ? -amount : amount);
    } else if (touchAction < 0) {
      currentPage = (currentPage + 3) % 4;
      renderPage();
    } else if (touchAction > 0) {
      currentPage = (currentPage + 1) % 4;
      renderPage();
    }
  }

  leftWasDown = leftDown;
  rightWasDown = rightDown;

  if (millis() - lastSyncAt >= SYNC_INTERVAL_MS) {
    if (!syncAll()) drawBootScreen("Core unavailable", "Retrying automatically");
  }
  delay(25);
}
