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
| `GET` | `/api/v1/campaigns` | List campaigns |
| `POST` | `/api/v1/campaigns` | Create a campaign |
| `GET` | `/api/v1/campaigns/{campaign_id}` | Read a campaign |
| `PUT` | `/api/v1/campaigns/{campaign_id}` | Replace editable campaign fields |
| `DELETE` | `/api/v1/campaigns/{campaign_id}` | Delete a campaign |
| `GET` | `/api/v1/campaigns/{campaign_id}/session` | Read shared Game/Battle state |
| `PUT` | `/api/v1/campaigns/{campaign_id}/session` | Publish scene and battle state |
| `GET` | `/api/v1/campaigns/{campaign_id}/events` | Stream live session updates |
| `POST` | `/api/v1/campaigns/{campaign_id}/battle/next` | Advance the active turn |
| `POST` | `/api/v1/campaigns/{campaign_id}/battle/end` | End the encounter and clear initiative |
| `PATCH` | `/api/v1/campaigns/{campaign_id}/battle/combatants/{combatant_id}` | Apply health and condition changes |
| `GET` | `/api/v1/connectivity/status` | Read Wi-Fi and Bluetooth state |
| `GET` | `/api/v1/connectivity/wifi/networks` | Scan Wi-Fi networks (Admin) |
| `POST` | `/api/v1/connectivity/wifi/mode` | Switch Local/Home mode (Admin) |
| `POST` | `/api/v1/connectivity/bluetooth/visibility` | Toggle Bluetooth discovery (Admin) |
| `GET` | `/api/v1/campaigns/{campaign_id}/characters` | List a campaign's characters |
| `POST` | `/api/v1/campaigns/{campaign_id}/characters` | Create a system-neutral character |
| `GET` | `/api/v1/campaigns/{campaign_id}/characters/{character_id}` | Read a character |
| `PUT` | `/api/v1/campaigns/{campaign_id}/characters/{character_id}` | Replace editable character state |
| `DELETE` | `/api/v1/campaigns/{campaign_id}/characters/{character_id}` | Delete a character |
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

The GM dashboard and player views share one system-neutral session record per campaign. Game Mode publishes scene information. Battle Mode adds ordered combatants, initiative, round, turn, health, and condition state. The GM console builds encounters from campaign characters and NPCs, advances turns, and applies damage, healing, or conditions. Server-sent events push each saved change to scoped Player clients, with polling retained as a fallback. Player sessions can read only their paired character and campaign table state.

## Local dashboard

Nexus Core serves its responsive command dashboard from `/`. The dashboard uses only local assets and the versioned API, so it remains fully functional without internet access. It displays live system information and provides campaign creation and deletion controls.

The Settings page at `/settings/` uses a six-digit installer-generated PIN for connectivity mutations. Nexus Core remains unprivileged; a root-owned helper exposes only validated NetworkManager and BlueZ actions. Failed home Wi-Fi connections restore the Nexus hotspot, and a boot recovery service starts Local Mode whenever no Wi-Fi connection is available.

The media proof of concept at `/media/` is browser-first and fully offline. Its procedural Web Audio soundscapes and effects play through the device viewing the page. Raspberry Pi audio output, Bluetooth routing, persistent libraries, playlists, and RFID triggers remain later media-service boundaries.

Character records are system-neutral: game-specific values live in flexible `fields` and `resources` objects while conditions and public notes have stable shared shapes. The GM manages campaign rosters on the dashboard. `/player/` combines one character with the campaign's live session, highlights that character's active turn, and provides the first phone/tablet view and the contract future companion hardware will consume.

Production startup enables the access layer. Admin sessions have global control, GM sessions are restricted to one campaign, and Player sessions are read-only and restricted to one character. Access tokens are persisted only as SHA-256 hashes and expire after 90 days. Static pages, system health, and discovery summaries remain available before pairing. See `docs/client-surfaces.md` for the Android wrapper direction.

The Admin dashboard exposes active client sessions and their scopes. Admin can revoke individual clients, reveal the current GM PIN, or rotate it. Rotation is persisted through the same root-owned allowlisted helper used for connectivity; Nexus Core never receives general root access. All existing GM sessions are revoked when the PIN changes.

## Next boundaries

Character, companion, game-system, RFID, and audio modules should use the same store interface during the JSON phase. A future SQLite adapter can then replace JSON persistence without changing HTTP routes or companion clients.
