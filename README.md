# SubLim3 Nexus

SubLim3 Nexus is a modular tabletop companion platform designed for music, ambiance, RFID interaction, campaign management, and physical player companion devices.

The project is being rebuilt from scratch with a clean, reliable architecture inspired by previous projects:

* Phoniebox
* SubLim3 JukeBox
* Ambiance Book
* DnD Book
* DnD Player Cubes

SubLim3 Nexus is not designed as a Dungeons & Dragons-only tool. It is designed as a flexible RPG and tabletop platform that can support multiple game systems through templates, configurable resources, companion devices, and a central Nexus Core.

---

## Vision

SubLim3 Nexus is a physical tabletop ecosystem.

It combines:

* RFID music and ambiance playback
* Campaign management
* Game system templates
* Character tracking
* Companion devices
* Player-facing displays
* DM-to-player messaging
* Conditions, resources, and initiative
* Future mobile app support

The long-term goal is to create a universal physical RPG companion platform.

---

## Core Concepts

### Nexus Core

The Nexus Core is the central hub.

Responsibilities:

* Host the web interface
* Store campaign data
* Manage game systems
* Manage characters
* Register companion devices
* Sync companion devices
* Manage music and ambiance
* Handle RFID events
* Provide REST APIs
* Serve local dashboard pages

The clean GM media player is available at `/media/`. RFID card bindings live at
`/rfid/`, while file, folder, upload, and USB management live at `/library/`.
All three surfaces share a left navigation rail and one Core-managed library and
playback state. On Raspberry Pi, Nexus uses `mpv` and ALSA to play procedural
soundscapes, effects, uploaded files, USB audio, and radio without an open browser.
Development machines and Pi installations without `mpv` retain browser playback
as a safe fallback.

The dashboard also manages system-neutral campaign characters. Each character has
a shareable local player view that combines live resources, conditions, GM notes,
scene information, and battle turn state without requiring a cloud connection.

Role-specific entry points are available at `/admin/`, `/gm/`, and `/player/`.
An Owner browser uses the installer-generated recovery PIN once, then keeps a
persistent session across the Command Center and GM workspace. Player devices select a
campaign and character and receive a character-scoped session with a bounded
self-service health adjustment.
The Admin dashboard can inspect and revoke paired clients, rotate the GM PIN, and
monitor a read-only Live Session Overview with an emergency full-session reset.

The GM console now includes a live encounter builder: select campaign characters,
add or remove combatants during play, edit and reorder initiative, move forward or
backward through turns, reset the round, and apply damage, healing, or conditions.
Player views receive those changes immediately and highlight the active character's
turn, while retaining a polling fallback for local-network interruptions.

The first app-onboarding migration is also active: the GM console renders a
campaign-specific Player QR code and share link. Scanning it opens the Player
surface with that campaign selected so the player can choose a character. The
planned printed Quick Start, device-claim, app-download, and short-lived invitation
flows are specified in `docs/onboarding.md`; PINs remain a recovery fallback while
device enrollment is introduced.

Version 1.2 adds the first template contract. Installed game systems define typed
character fields, resources, condition vocabularies, companion pages, and actions.
Campaigns bind to one installed system; new characters receive its defaults and
record the template version that shaped them. Custom RPG and D&D 5e ship as the
first built-in templates, while the Admin dashboard exposes the installed library.

Version 1.3 adds reusable success/failure trackers and uses the first one for D&D
5e death saves. At zero HP, the GM can record successes, failures, natural 1s,
natural 20s, or reset the tracker. Three successes stabilize, three failures mark
the character dead, a natural 20 restores one HP, and healing clears the tracker.
Players see the live read-only result, and existing D&D characters are migrated
when Nexus Core starts.

Version 1.4 introduces the expansion-pack catalog. A fresh Nexus starts with only
Custom RPG enabled: eight editable Warrior, Rogue, Mage, and Healer presets across
male and female presentations. D&D 5e and six original advanced packs remain
optional until an Admin installs them from the local catalog. Installed packs use
a dynamic editor generated from their fields and resources. Pack manifests already
carry availability and licensing metadata; every current optional pack is free.

Version 1.4.1 hardens one-click updates. Git operations run as the repository
owner, the installer repairs mixed ownership left by older releases, and helper
failures are shown in Settings instead of a generic server error. After an update
passes or fails, Settings waits for Nexus Core, refreshes to the top of the page,
and preserves a visible result notification across the restart.

Version 1.4.2 completes the hardened updater path for fresh installations. Git
uses a repository-local configuration environment while the service home is
protected, and installation runs in a short-lived root service outside the
read-only Nexus Core sandbox.

Version 1.5 adds headless Raspberry Pi audio. Nexus automatically installs and
detects `mpv`, renders its built-in procedural sounds to cached WAV files, and
plays ambience, effects, uploads, USB files, and radio through ALSA without an
open browser. Browser playback remains the automatic fallback.

Initial development may use Raspberry Pi hardware.

Long-term production hardware may use either:

* Custom Linux SBC hardware
* ESP32-S3 based embedded hardware
* Hybrid architecture depending on product direction

---

### Nexus Companion

The Nexus Companion is the player-facing physical device.

Previous prototypes were called Player Cubes.

Future hardware target:

* LILYGO T-Display-S3
* ESP32-S3
* 1.9 inch display
* Touch interface
* WiFi
* Optional battery
* Optional haptic feedback
* Optional speaker or buzzer

The companion device should not contain hard-coded D&D logic. It should receive its layout, pages, fields, resources, and actions from the Nexus Core.

---

### Game Systems

Game systems are templates.

Examples:

* Dungeons & Dragons
* Pathfinder
* Call of Cthulhu
* Cyberpunk RED
* Shadowrun
* Savage Worlds
* Custom RPG systems

Each system defines:

* Character fields
* Resources
* Conditions
* Dice rules
* Page layouts
* Default actions
* Optional initiative behavior

---

## Design Principles

1. Build clean from scratch.
2. Avoid hard-coded D&D assumptions.
3. Make all RPG logic template-driven.
4. Keep companion firmware generic.
5. Make APIs simple and stable.
6. Prefer reliable local networking.
7. Keep campaign data portable.
8. Design with future manufacturing in mind.
9. Prioritize reliability over complexity.
10. Make every feature work offline on the local network first.

---

## Planned Architecture

```text
SubLim3 Nexus
├── Nexus Core
│   ├── Web Interface
│   ├── REST API
│   ├── Game System Templates
│   ├── Campaign Manager
│   ├── Character Manager
│   ├── Companion Manager
│   ├── RFID Manager
│   ├── Music / Ambiance Engine
│   └── Local Storage
│
├── Nexus Companion Devices
│   ├── Touch UI
│   ├── Character Display
│   ├── Resource Tracking
│   ├── Conditions
│   ├── DM Messages
│   └── Local Sync Client
│
└── Future Mobile App
    ├── Campaign Tools
    ├── Character Tools
    ├── Companion Setup
    └── Remote Control
```

---

## Data Model

The system should use a generic RPG data model.

### Game System

```json
{
  "system_id": "dnd5e",
  "name": "Dungeons & Dragons 5e",
  "version": "1.0",
  "character_sheet": {
    "fields": [
      { "field_id": "defense", "label": "Armor Class", "type": "number" }
    ],
    "resources": [
      { "resource_id": "health", "label": "Hit Points", "default_current": 10, "default_maximum": 10 }
    ],
    "trackers": [
      { "tracker_id": "death_saves", "label": "Death Saves", "success_target": 3, "failure_target": 3 }
    ],
    "conditions": ["Poisoned", "Prone"],
    "pages": [
      { "page_id": "status", "title": "Status", "bindings": ["health", "defense", "conditions"] }
    ],
    "actions": [
      { "action_id": "damage", "label": "Damage", "kind": "decrement", "target": "health" }
    ]
  }
}
```

---

### Campaign

```json
{
  "campaign_id": "lost_mines",
  "name": "Lost Mines",
  "system_id": "dnd5e",
  "created": "2026-06-21 20:00:00",
  "active": true
}
```

---

### Character

```json
{
  "character_id": "sir_garrick",
  "campaign_id": "lost_mines",
  "player_name": "Jason",
  "character_name": "Sir Garrick",
  "portrait": "sir_garrick.png",
  "resources": {
    "hp": {
      "label": "HP",
      "value": 80,
      "max": 100
    },
    "temp_hp": {
      "label": "Temp HP",
      "value": 5,
      "max": null
    }
  },
  "conditions": [],
  "companion_id": "nexus-c630"
}
```

---

### Companion Device

```json
{
  "companion_id": "nexus-c630",
  "name": "Nexus C630",
  "type": "lilygo_t_display_s3",
  "assigned_character_id": "sir_garrick",
  "last_seen": "2026-06-21 20:10:00",
  "battery": 86,
  "firmware": "0.1.0"
}
```

---

### Companion Page Layout

```json
{
  "pages": [
    {
      "page_id": "health",
      "title": "Health",
      "bindings": [
        "hp",
        "temp_hp"
      ]
    },
    {
      "page_id": "conditions",
      "title": "Conditions",
      "bindings": [
        "conditions"
      ]
    },
    {
      "page_id": "resources",
      "title": "Resources",
      "bindings": [
        "spell_slot_1",
        "spell_slot_2",
        "spell_slot_3"
      ]
    }
  ]
}
```

---

## API Design

All APIs should be versioned.

Base path:

```text
/api/v1/
```

---

### System

```text
GET  /api/v1/system/status
GET  /api/v1/system/info
POST /api/v1/system/restart
POST /api/v1/system/shutdown
POST /api/v1/system/reboot
POST /api/v1/system/update
GET  /api/v1/settings/player
PUT  /api/v1/settings/player
```

---

### Campaigns

```text
GET    /api/v1/campaigns
POST   /api/v1/campaigns
GET    /api/v1/campaigns/{campaign_id}
PUT    /api/v1/campaigns/{campaign_id}
DELETE /api/v1/campaigns/{campaign_id}
POST   /api/v1/campaigns/{campaign_id}/activate
```

---

### Characters

```text
GET    /api/v1/campaigns/{campaign_id}/characters
POST   /api/v1/campaigns/{campaign_id}/characters
GET    /api/v1/characters/{character_id}
PUT    /api/v1/characters/{character_id}
DELETE /api/v1/characters/{character_id}
PATCH  /api/v1/characters/{character_id}/resources
PATCH  /api/v1/characters/{character_id}/conditions
POST   /api/v1/campaigns/{campaign_id}/characters/{character_id}/resources/health/adjust
```

---

### Companion Devices

```text
GET  /api/v1/companions
POST /api/v1/companions/check-in
GET  /api/v1/companions/{companion_id}
POST /api/v1/companions/{companion_id}/assign
POST /api/v1/companions/{companion_id}/unassign
GET  /api/v1/companions/{companion_id}/state
POST /api/v1/companions/{companion_id}/update
```

---

### Messages

```text
GET  /api/v1/companions/{companion_id}/messages
POST /api/v1/companions/{companion_id}/messages
POST /api/v1/characters/{character_id}/messages
```

---

### Initiative

```text
GET  /api/v1/campaigns/{campaign_id}/initiative
POST /api/v1/campaigns/{campaign_id}/initiative
POST /api/v1/campaigns/{campaign_id}/initiative/sort
POST /api/v1/campaigns/{campaign_id}/initiative/next
```

---

### Music and Ambiance

```text
GET  /api/v1/audio/status
GET  /api/v1/audio/library
POST /api/v1/audio/play
POST /api/v1/audio/pause
POST /api/v1/audio/stop
POST /api/v1/audio/volume
POST /api/v1/audio/ambiance
POST /api/v1/audio/effects/{item_id}/trigger
GET  /api/v1/audio/folders
POST /api/v1/audio/folders
POST /api/v1/audio/files/upload
PUT  /api/v1/audio/files/{item_id}
GET  /api/v1/audio/files/{item_id}/content
GET  /api/v1/audio/usb
POST /api/v1/audio/usb/play
POST /api/v1/audio/radio/play
POST /api/v1/audio/import
```

Optional audio should live in the separate
`SubLim3-Nexus-Expansions` repository and be installed into the managed Nexus
audio library without checking large media files into this core repo. Owners can
open `/packs/`, choose Audio Packs, and install or remove available audio packs
from the UI. On Raspberry Pi installs, the installer keeps a best-effort cache
of the expansion repository in the Nexus data directory so the catalog is ready
after a fresh install when the repo is reachable.

Audio packs can be small and scene-focused. For example, separate packs such as
`fantasy-battle-mode`, `fantasy-tavern`, `fantasy-town`, `fantasy-travel`,
`horror-chase`, and `horror-tension` can all install beneath clean Media Library
groups like `Expansion Audio/Fantasy/...` or `Expansion Audio/Horror/...` by
setting `library_folder` in their manifests.

Sound-effect packs use the same audio-pack installer. Packs such as
`dungeon-sfx`, `cave-sfx`, `sea-sfx`, `forest-sfx`, `battle-sfx`, and
`magic-sfx` place their audio under `files/SFX/`, which imports those files as
one-shot effects instead of looping ambience. Installed expansion effects appear
in the Media page's installed-pack tree and can also be assigned to RFID cards.

Current expansion audio packs are free for testing. Their manifests use a
forward-compatible `commerce` block with `model: "free_testing"`,
`label: "Free for testing"`, and `future_label: "Try them"` so paid packs can be
introduced later without changing the install flow.

The command-line importer remains available for maintenance:

```bash
npm run audio:expansions:import
```

The importer clones the expansion repository into the Nexus data directory,
copies supported audio formats into `audio/files/Expansion Audio`, and marks
each library item with source pack metadata so the files remain easy to find,
queue, and assign to RFID cards. Remove imported expansion audio after testing
with:

```bash
npm run audio:expansions:remove
```

---

### RFID

```text
POST /api/v1/rfid/scan
GET  /api/v1/rfid/last-scan
POST /api/v1/rfid/cards
GET  /api/v1/rfid/cards
DELETE /api/v1/rfid/cards/{uid}
```

Cards are upserted by normalized hexadecimal UID. Audio actions accept either an
ambience item or a one-shot effect; function cards can stop, pause, or change the
global volume by the configured step.

```json
{
  "uid": "04:A1:B2:C3",
  "name": "Tavern ambience",
  "action": { "type": "audio", "item_id": "lantern-and-oak" }
}
```

Supported action types are `audio`, `stop`, `pause`, `volume_up`, and
`volume_down`. Reader adapters post `{ "uid": "04:A1:B2:C3" }`; place-mode
readers post the same UID with `"present": false` when a card is removed.

---

## Companion Protocol

The companion should boot, connect to WiFi, and identify itself.

### Check-In Request

```json
{
  "companion_id": "nexus-c630",
  "device_type": "lilygo_t_display_s3",
  "firmware": "0.1.0",
  "battery": 86
}
```

### Check-In Response

```json
{
  "success": true,
  "assigned": true,
  "campaign_id": "lost_mines",
  "character_id": "sir_garrick",
  "layout": {},
  "state": {}
}
```

If unassigned:

```json
{
  "success": true,
  "assigned": false,
  "message": "Open Companion Registration on Nexus Core."
}
```

---

## Companion UI Goals

The touch companion should support:

* Character portrait
* Character name
* Page indicator
* Health/resources
* Conditions
* Initiative status
* DM messages
* Sync status
* Battery status
* WiFi status

The UI should be driven by server-provided layout data.

---

## Future Companion Screens

### Home

```text
Character portrait
Character name
Current status
```

### Resources

```text
HP
Temp HP
Sanity
Mana
Stamina
Ammo
Custom resources
```

### Conditions

```text
Poisoned
Blessed
Invisible
Bleeding
Custom conditions
```

### Messages

```text
Private DM messages
System alerts
Turn notifications
```

### Initiative

```text
Current turn
On deck
Your initiative
```

### Inventory

```text
Items
Charges
Consumables
```

---

## Initial Hardware Targets

### Nexus Core Development Hardware

* Raspberry Pi 4 or Raspberry Pi 5
* Local web server
* RFID reader
* Audio output
* Optional touchscreen
* Local storage

The supported RC522 and physical media-button wiring is documented in
[`docs/hardware.md`](docs/hardware.md). Raspberry Pi installs automatically
enable the SPI/GPIO adapter; other development systems use the hardware-free
path.

### Companion Development Hardware

Primary:

* LILYGO T-Display-S3
* ESP32-S3
* 1.9 inch ST7789 display
* Touch input
* WiFi

Legacy test devices:

* ESP-WROOM-32
* I2C 16x02 LCD
* Rotary encoder

---

## Storage

Development storage may start as JSON files for simplicity.

Recommended long-term path:

```text
Phase 1: JSON files
Phase 2: SQLite
Phase 3: Optional cloud sync
```

Portable local storage is preferred early in development.

---

## Suggested Directory Structure

```text
sublim3-nexus/
├── README.md
├── docs/
│   ├── architecture.md
│   ├── api.md
│   ├── companion-protocol.md
│   ├── hardware.md
│   └── roadmap.md
│
├── core/
│   ├── public/
│   │   ├── index.php
│   │   ├── dashboard.php
│   │   └── assets/
│   │
│   ├── api/
│   │   └── v1/
│   │
│   ├── includes/
│   │   ├── config.php
│   │   ├── storage.php
│   │   ├── response.php
│   │   └── auth.php
│   │
│   └── data/
│       ├── campaigns/
│       ├── systems/
│       ├── companions/
│       └── audio/
│
├── firmware/
│   ├── companion-lilygo-s3/
│   ├── companion-lcd-esp32/
│   └── shared/
│
├── scripts/
│   ├── install.sh
│   ├── update.sh
│   └── backup.sh
│
└── tests/
```

---

## Roadmap

### Phase 0 - Planning

* Define architecture
* Define data model
* Define API contracts
* Define companion protocol
* Define hardware targets

### Phase 1 - Core Foundation

* Create Nexus Core web interface
* Create campaign CRUD
* Create character CRUD
* Create generic resource system
* Create companion registration
* Create companion check-in API
* Create local JSON storage

### Phase 2 - Companion MVP

* LILYGO T-Display-S3 firmware
* WiFi setup
* Companion ID
* Registration screen
* Character assignment
* Resource display
* Resource update
* Sync with Nexus Core

### Phase 3 - RPG Template System

* Game system and character-sheet template contract complete
* Built-in Custom RPG and D&D 5e templates complete
* Template-defined success/failure trackers and D&D death saves complete
* Add custom template editor
* Expand system-specific condition and action tooling

### Phase 4 - Table Features

* DM messages
* Private player notifications
* Inventory
* Quest tracking
* Turn alerts
* Conditions sync

### Phase 5 - Music and Ambiance

* RFID music playback
* Ambiance scenes
* Sound effects
* Campaign audio profiles

### Phase 6 - Production Readiness

* Installer
* Backup/restore
* Firmware update flow
* Stable API versioning
* Hardware abstraction
* Enclosure design
* Manufacturing review

---

## Commercialization Notes

If this becomes a commercial product, avoid depending on hobby-only assumptions.

Important considerations:

* Custom PCB
* Reliable power design
* Battery charging
* FCC/CE certification
* Enclosure design
* Firmware update mechanism
* Factory reset process
* Setup flow
* Documentation
* Support process

The companion device should eventually be a custom ESP32-S3 board.

The Nexus Core may start as Raspberry Pi-based but should remain abstract enough to move to custom hardware later.

---

## Project Status

SubLim3 Nexus is starting from scratch.

### Run the Phase 1 foundation

Nexus Core currently requires Node.js 20 or newer and has no third-party runtime dependencies.

```bash
npm start
```

The API listens on `http://localhost:3000` by default. Configure it with `HOST`, `PORT`, and `NEXUS_DATA_DIR` environment variables.

```bash
npm test
```

The first working slice includes the system status endpoint, campaign CRUD, portable JSON storage, request validation, and API integration tests. See [the architecture notes](docs/architecture.md) for current boundaries and next steps.

Open the local dashboard at `http://<nexus-host>:3000/`. It provides live Core health, host storage and memory details, and campaign management without requiring internet access.

### Install on Raspberry Pi

Clone the repository to `/opt/sublim3-nexus`, then install the managed service:

```bash
cd /opt/sublim3-nexus
sudo ./scripts/install.sh
```

The installer creates a restricted `nexus` service account, stores runtime data under `/var/lib/sublim3-nexus`, and enables Nexus Core at boot. Runtime settings can be changed in `/etc/default/sublim3-nexus`.

The installer also configures the Network Settings helper, generates Admin and GM PINs plus a Local Wi-Fi password, and prints them. Open `/settings/` to switch between the Nexus hotspot and Home Wi-Fi or toggle Bluetooth visibility. Re-run the installer after pulling a release that changes system services or access credentials.

```bash
systemctl status sublim3-nexus
journalctl -u sublim3-nexus -f
```

Current priority:

1. Finalize architecture
2. Create clean GitHub repository
3. Build Core foundation
4. Build generic API
5. Build LILYGO T-Display-S3 companion firmware
6. Avoid carrying forward technical debt from previous projects

---

## Project Philosophy

Build the platform first.

D&D is the first template, not the product.

The product is SubLim3 Nexus.
