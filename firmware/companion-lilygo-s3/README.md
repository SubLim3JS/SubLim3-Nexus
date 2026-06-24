# LILYGO T-Display-S3 Player Cube

This Arduino sketch is the first Nexus Player Cube client for both the touch and non-touch 1.9-inch ST7789 T-Display-S3. It probes the touch controller at startup and selects touch or button navigation automatically.

Boot and reconnection use a branded, animated connection-state screen rather than exposing IP addresses or HTTP errors. Detailed request results remain available over the 115200-baud Serial monitor. Wi-Fi power saving remains enabled after association to reduce idle power and heat.

## Arduino IDE dependencies

- `esp32` board package by Espressif Systems
- `GFX Library for Arduino`
- `ArduinoJson` by Benoit Blanchon

Use the `ESP32S3 Dev Module` target with USB CDC enabled, 16 MB flash, and OPI PSRAM.

## Configure and upload

Open `companion-lilygo-s3.ino` and set `WIFI_SSID`, `WIFI_PASSWORD`, and `CORE_BASE_URL`. Do not append a trailing slash to the Core URL.

The first boot discovers campaigns and characters from Nexus Core:

- Left/BOOT button: move to the next choice
- Right/IO14 button: confirm a choice
- Touch model: tap the left side to move to the next choice and the right side to confirm
- Both buttons for three seconds while running: clear the assignment and pair again

The selected campaign, character, and scoped Player token are stored in ESP32 preferences. During normal use, swipe left/right or tap the screen edges on a Touch board; the physical buttons remain available on both models. Navigation moves through Overview, Resources, Conditions, and Table pages. Character and session state refresh every five seconds.

On the Touch Resources page, tap the left or right control to subtract or add one HP. Hold a control for 650 ms to subtract or add five HP. Swipes still change pages. Core authorizes the paired Player token against the selected character, clamps HP to its valid range, and mirrors the adjustment into an active encounter.

The Touch version uses the onboard CST816 controller at address `0x15` with SDA 18, SCL 17, interrupt 16, and reset 21. No additional touch library is required.

This is an interim Player client built on the existing v1 Player API. A future hardware enrollment flow will replace public character selection before production use.
