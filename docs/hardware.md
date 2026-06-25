# Raspberry Pi hardware

Nexus Core supports an MFRC522/RC522 RFID reader and two active-low media
buttons on a Raspberry Pi 4 or 5. The installer enables SPI, installs the
Python GPIO/SPI dependencies, and gives the `nexus` service account GPIO/SPI
access.

## RC522 wiring

The RC522 is a 3.3-volt device. Do not connect it to a 5-volt pin.

| RC522 | Physical pin | BCM function |
| --- | ---: | --- |
| 3.3V | 1 | 3.3V power |
| GND | 6 | Ground |
| IRQ | 18 | GPIO24 (reserved; the driver currently polls) |
| MOSI | 19 | GPIO10 / SPI0 MOSI |
| MISO | 21 | GPIO9 / SPI0 MISO |
| RST | 22 | GPIO25 |
| SCK | 23 | GPIO11 / SPI0 SCLK |
| SDA / SS | 24 | GPIO8 / SPI0 CE0 |

The driver first tries the standard `mfrc522` Python package used by earlier
SubLim3 hardware projects, then falls back to Nexus Core's built-in SPI reader.
It publishes card placement and release events through the existing RFID
service.

## Media buttons

Connect one terminal of each normally-open momentary button to its BCM GPIO and
the other terminal to ground. The driver enables the Raspberry Pi's internal
pull-up resistors, so no external pull-up is required.

| Button | BCM GPIO | Physical pin | Tap | Hold | Double tap |
| --- | ---: | ---: | --- | --- | --- |
| Volume down | 15 | 10 | Volume down | Previous track | Play / pause |
| Volume up | 5 | 29 | Volume up | Next track | Play / pause |

A hold is recognized after about 1 second. Button edges use a 200 ms debounce.
Two taps within 350 ms toggle playback. Single-tap volume changes use the step
and maximum configured on the Settings page. Previous and next wrap through the
managed ambience library.

## Configuration

The default `/etc/default/sublim3-nexus` values are:

```text
NEXUS_HARDWARE_DRIVER=auto
NEXUS_RFID_SPI_BUS=0
NEXUS_RFID_SPI_DEVICE=0
NEXUS_RFID_RESET_GPIO=25
NEXUS_RFID_IRQ_GPIO=24
NEXUS_BUTTON_DOWN_GPIO=15
NEXUS_BUTTON_UP_GPIO=5
```

`auto` starts the helper only when Raspberry Pi hardware is detected. Use
`NEXUS_HARDWARE_DRIVER=disabled` to turn it off, or `raspberry-pi` to force it
on. After changing the wiring configuration, restart the service:

```bash
sudo systemctl restart sublim3-nexus
sudo journalctl -u sublim3-nexus -f
```
