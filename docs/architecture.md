# Nexus Core Architecture

## Phase 1 foundation

Nexus Core starts as a dependency-free Node.js service. The first vertical slice keeps the HTTP, domain, and persistence boundaries separate so each can evolve without changing the public API.

```text
HTTP request
  -> versioned API handler
  -> campaign operations
  -> JSON store
  -> local data directory
```

The public contract is versioned under `/api/v1`. Runtime data is stored outside source control in `core/data` by default and can be relocated with `NEXUS_DATA_DIR` for removable storage, backups, or production deployments.

JSON writes use a temporary file followed by an atomic rename. This prevents a partially written campaign file from replacing the last valid copy if the process is interrupted.

## Current endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/system/status` | Health and version information |
| `GET` | `/api/v1/system/info` | Host, runtime, memory, and storage information |
| `GET` | `/api/v1/systems` | List installed game-system templates |
| `GET` | `/api/v1/packs` | List game packs from Core and the configured expansion repository |
| `POST` | `/api/v1/packs/{pack_id}/install` | Enable an optional game pack |
| `DELETE` | `/api/v1/packs/{pack_id}` | Remove an unused optional expansion pack |
| `GET` | `/api/v1/audio-packs` | List optional expansion audio packs and installation state |
| `POST` | `/api/v1/audio-packs/{pack_id}/install` | Import an optional audio pack into the managed Media Library |
| `DELETE` | `/api/v1/audio-packs/{pack_id}` | Remove imported files for an audio pack |
| `POST` | `/api/v1/systems` | Install a game-system template (Admin) |
| `GET` | `/api/v1/systems/{system_id}` | Read a character-sheet and companion contract |
| `PUT` | `/api/v1/systems/{system_id}` | Replace a game-system template (Admin) |
| `DELETE` | `/api/v1/systems/{system_id}` | Delete an unused custom template (Admin) |
| `GET` | `/api/v1/campaigns` | List campaigns |
| `POST` | `/api/v1/campaigns` | Create a campaign |
| `GET` | `/api/v1/campaigns/{campaign_id}` | Read a campaign |
| `PUT` | `/api/v1/campaigns/{campaign_id}` | Replace editable campaign fields |
| `DELETE` | `/api/v1/campaigns/{campaign_id}` | Delete a campaign |
| `GET` | `/api/v1/campaigns/{campaign_id}/session` | Read shared Game/Battle state |
| `PUT` | `/api/v1/campaigns/{campaign_id}/session` | Publish scene and battle state |
| `POST` | `/api/v1/campaigns/{campaign_id}/session/reset` | Emergency reset all session state (Admin) |
| `GET` | `/api/v1/campaigns/{campaign_id}/events` | Stream live session updates |
| `POST` | `/api/v1/campaigns/{campaign_id}/battle/next` | Advance the active turn |
| `POST` | `/api/v1/campaigns/{campaign_id}/battle/previous` | Return to the previous turn |
| `POST` | `/api/v1/campaigns/{campaign_id}/battle/round/reset` | Reset to round one and the first turn |
| `GET` | `/api/v1/audio/library` | List persistent ambience and effect definitions |
| `GET` | `/api/v1/audio/status` | Read the global playback state and active item |
| `POST` | `/api/v1/audio/play` | Play an ambience item (Admin or GM) |
| `POST` | `/api/v1/audio/pause` | Pause global playback (Admin or GM) |
| `POST` | `/api/v1/audio/stop` | Stop global playback (Admin or GM) |
| `POST` | `/api/v1/audio/volume` | Set global volume from 0–100 (Admin or GM) |
| `POST` | `/api/v1/audio/effects/{item_id}/trigger` | Trigger a one-shot effect event (Admin or GM) |
| `GET/POST` | `/api/v1/audio/folders` | List or create managed audio folders (Admin or GM) |
| `POST` | `/api/v1/audio/files/upload` | Stream an audio upload into a managed folder (Admin or GM) |
| `PUT` | `/api/v1/audio/files/{item_id}` | Move a managed audio file between folders (Admin or GM) |
| `GET` | `/api/v1/audio/files/{item_id}/content` | Stream audio content with byte-range support |
| `GET` | `/api/v1/audio/usb` | Scan configured USB mount roots for supported audio (Admin or GM) |
| `POST` | `/api/v1/audio/usb/play` | Play directly from an allowlisted USB file without importing (Admin or GM) |
| `POST` | `/api/v1/audio/import` | Copy a validated USB audio file into the managed library (Admin or GM) |
| `GET/POST` | `/api/v1/rfid/cards` | List or upsert persistent card-to-audio/function bindings (Admin or GM) |
| `DELETE` | `/api/v1/rfid/cards/{uid}` | Delete a card binding (Admin or GM) |
| `POST` | `/api/v1/rfid/scan` | Process a normalized reader scan and execute its bound action |
| `GET` | `/api/v1/rfid/last-scan` | Read the latest scan, outcome, card, and resulting audio state |
| `POST` | `/api/v1/campaigns/{campaign_id}/battle/reorder` | Set the complete initiative order |
| `POST` | `/api/v1/campaigns/{campaign_id}/battle/end` | End the encounter and clear initiative |
| `POST` | `/api/v1/campaigns/{campaign_id}/battle/combatants` | Add a combatant during an encounter |
| `PATCH` | `/api/v1/campaigns/{campaign_id}/battle/combatants/{combatant_id}` | Edit initiative, health, and conditions |
| `DELETE` | `/api/v1/campaigns/{campaign_id}/battle/combatants/{combatant_id}` | Remove a combatant during an encounter |
| `GET` | `/api/v1/connectivity/status` | Read Wi-Fi and Bluetooth state |
| `GET` | `/api/v1/connectivity/wifi/networks` | Scan Wi-Fi networks (Admin) |
| `POST` | `/api/v1/connectivity/wifi/mode` | Switch Local/Home mode (Admin) |
| `POST` | `/api/v1/connectivity/bluetooth/visibility` | Toggle Bluetooth discovery (Admin) |
| `GET` | `/api/v1/campaigns/{campaign_id}/characters` | List a campaign's characters |
| `POST` | `/api/v1/campaigns/{campaign_id}/characters` | Create a system-neutral character |
| `GET` | `/api/v1/campaigns/{campaign_id}/characters/{character_id}` | Read a character |
| `PUT` | `/api/v1/campaigns/{campaign_id}/characters/{character_id}` | Replace editable character state |
| `DELETE` | `/api/v1/campaigns/{campaign_id}/characters/{character_id}` | Delete a character |
| `POST` | `/api/v1/campaigns/{campaign_id}/characters/{character_id}/resources/health/adjust` | Adjust the paired character's HP and active combatant |
| `POST` | `/api/v1/auth/pair` | Pair an Admin, GM, or Player client |
| `GET` | `/api/v1/auth/me` | Read the current access scope |
| `DELETE` | `/api/v1/auth/session` | Unpair the current client |
| `GET` | `/api/v1/auth/sessions` | List active sessions (Admin) |
| `DELETE` | `/api/v1/auth/sessions/{session_id}` | Revoke a paired client (Admin) |
| `GET` | `/api/v1/auth/pairing` | Read GM pairing information (Admin) |
| `POST` | `/api/v1/auth/gm-pin/rotate` | Rotate the GM PIN and revoke GM sessions (Admin) |
| `GET` | `/api/v1/discovery/campaigns` | Public local campaign picker |
| `GET` | `/api/v1/discovery/campaigns/{campaign_id}/characters` | Public local character picker |

## Browser-first session model

The GM dashboard and player views share one system-neutral session record per campaign. Game Mode publishes scene information. Battle Mode adds ordered combatants, initiative, round, turn, health, and condition state. The GM console builds and revises encounters during play, edits initiative order, navigates turns in either direction, and applies damage, healing, or conditions. The Admin dashboard exposes the same state as a read-only overview; its only session mutation is an explicit emergency reset. Server-sent events push each saved change to scoped Player clients, with polling retained as a fallback. Player sessions can read only their paired character and campaign table state, with one bounded mutation for adjusting their own health resource; Core mirrors that change into the matching active combatant.

## Template model

Game packs are versioned bundles. Core ships only the `custom` pack under `core/packs/custom` so a fresh Nexus always starts with the Custom RPG defaults. Optional game systems live in the configured `SubLim3-Nexus-Expansions` repository under `packs/<pack_id>/`. Each bundle contains a manifest for catalog, licensing, compatibility, availability, and preinstallation metadata plus a system template defining typed fields, tracked resources, success/failure trackers, suggested conditions, page bindings, abstract actions, and optional quick-start presets. Campaigns reference one installed `system_id`; character creation applies that template's defaults and snapshots its `system_id` and `template_version`. Player Controller pages bind only to stable field/resource/tracker IDs, keeping firmware free of game-specific logic. Optional bundles stay dormant until installed, cannot be removed while a campaign references them, and can later be replaced by downloaded and verified marketplace packages without changing the campaign contract.

Custom RPG is deliberately the simple path: its pack exposes eight editable presets covering Warrior, Rogue, Mage, and Healer archetypes with male and female presentations. D&D 5e and the other optional expansion-repo packs use the fully dynamic character editor generated from their field and resource definitions.

Tracker definitions carry their thresholds, critical-result behavior, visibility condition, and resource-reset rule. Concrete progress lives on the character and is copied into battle state, where the existing combatant patch route applies actions and synchronizes the result back to the character. D&D 5e's `death_saves` tracker appears at zero HP, counts natural 1 as two failures, restores one HP on natural 20, and resets when HP becomes positive. Startup migration adds new built-in trackers to existing characters and active encounters without replacing their other values.

## Local dashboard

Nexus Core serves its responsive command dashboard from `/`. The dashboard uses only local assets and the versioned API, so it remains fully functional without internet access. It displays live system information and provides campaign creation and deletion controls.

The Settings page at `/settings/` uses a six-digit recovery PIN for connectivity mutations. Until production provisioning randomizes per-device credentials, fresh installs default the Owner/Admin recovery PIN to `101010`. Nexus Core remains unprivileged; a root-owned helper exposes only validated NetworkManager and BlueZ actions. Failed home Wi-Fi connections restore the Nexus hotspot, and a boot recovery service retries the saved Home Wi-Fi connection before starting Local Mode whenever no Wi-Fi connection is available. The installer adopts an already-active Wi-Fi profile as the Home connection, so OS-created profiles such as netplan connections survive reboot recovery. Local Mode uses `NEXUS_HOTSPOT_ADDRESS`, which defaults to `10.10.10.1/24`. The retry window is controlled by `NEXUS_HOME_RECONNECT_ATTEMPTS` and `NEXUS_HOME_RECONNECT_DELAY_SECONDS`.

System updates use the same allowlisted helper, but repository fetch and fast-forward operations execute as the owner of `/opt/sublim3-nexus`; root is retained only for installation and service management. The installer reconciles legacy mixed repository ownership. Helper failures cross the API boundary as actionable messages, while the Settings client stores the result through the restart, waits for system health, refreshes, scrolls to the top, and restores the success or failure banner.

The updater supplies Git with a repository-local home and configuration path because the Core service deliberately hides user home directories. The installer then re-launches through a short-lived root systemd unit, allowing system files to be replaced without weakening the Core service's read-only filesystem sandbox.

The media suite is fully offline and split by responsibility: `/media/` is the clean GM playback surface, `/rfid/` manages card bindings, and `/library/` owns files, folders, uploads, and USB imports. `/packs/` is the expansion hub; `/game-packs/` manages game-system packs, and `/audio-packs/` manages installable expansion audio packs. A shared left navigation rail connects the media surfaces. Nexus Core owns one persistent audio library, real folder hierarchy, global transport state, volume, and one-shot effect stream through `/api/v1/audio`. Direct USB items are transient and remain distinct from managed files. RFID bindings drive that same audio state with swipe/place, rescan-delay, and second-scan behavior.

On Linux, the platform audio boundary detects `mpv`, renders built-in procedural audio to cached PCM WAV files, and sends ambience, effects, managed files, USB paths, and radio streams to ALSA. The driver owns transport and volume through an isolated mpv IPC socket, so playback continues without an open browser. If mpv is unavailable—or `NEXUS_AUDIO_DRIVER=browser` is configured—the existing browser renderer remains active. `NEXUS_AUDIO_DEVICE` can select a specific mpv/ALSA device. Bluetooth routing, playlists, and a physical RFID reader adapter remain later driver boundaries.

Character records are system-neutral: game-specific values live in flexible `fields` and `resources` objects while conditions and public notes have stable shared shapes. The GM manages campaign rosters on the dashboard. `/player/` combines one character with the campaign's live session, highlights that character's active turn, and provides the first phone/tablet view and the contract future companion hardware will consume.

Production startup enables the access layer. Admin sessions have global control, GM sessions are restricted to one campaign, and Player sessions are restricted to one character with only their bounded health adjustment writable. Access tokens are persisted only as SHA-256 hashes and expire after 90 days. Static pages, system health, and discovery summaries remain available before pairing. See `docs/client-surfaces.md` for the Android wrapper direction.

The Admin dashboard exposes active client sessions and their scopes. Admin can revoke individual clients, reveal the current GM PIN, or rotate it. Rotation is persisted through the same root-owned allowlisted helper used for connectivity; Nexus Core never receives general root access. All existing GM sessions are revoked when the PIN changes.

## Next boundaries

Character, companion, game-system, RFID, and audio modules should use the same store interface during the JSON phase. A future SQLite adapter can then replace JSON persistence without changing HTTP routes or companion clients.
