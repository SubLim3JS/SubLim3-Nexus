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

## Local dashboard

Nexus Core serves its responsive command dashboard from `/`. The dashboard uses only local assets and the versioned API, so it remains fully functional without internet access. It displays live system information and provides campaign creation and deletion controls.

## Next boundaries

Character, companion, game-system, RFID, and audio modules should use the same store interface during the JSON phase. A future SQLite adapter can then replace JSON persistence without changing HTTP routes or companion clients.
