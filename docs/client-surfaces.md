# Client surfaces and Android wrappers

SubLim3 Nexus has one persistent Owner experience plus a scoped Player surface. The Command Center and focused GM workspace share the Owner credential and navigation shell; moving between them never requires another PIN.

| Surface | Browser route | Scope |
| --- | --- | --- |
| Owner Console | `/admin/` | Full system, settings, campaigns, characters, sessions, devices, and future diagnostics |
| GM workspace | `/gm/` | Owner campaign selection, scenes, encounter building, initiative, health, and conditions |
| Player | `/player/` | One selected character with live table state, turn highlighting, and scoped health control |

An Owner browser uses the installer-generated recovery PIN once. Its random bearer token is stored only as a hash by Nexus Core, persists across reboots, and expires after 90 days. Routine navigation never asks for the PIN again, and transient page-loading failures do not discard the credential. A GM PIN remains only as a recovery path for pairing a separate guest GM device to one campaign.

The Admin Access & Pairing panel lists active devices, their role scopes, and expiration dates. It can revoke a client or rotate the GM PIN; rotation immediately revokes all existing GM sessions.

The Admin Expansion Packs hub at `/packs/` lets the Owner choose Game Packs or Audio Packs. Game Packs list optional systems, installation state, creation experience, character-field and resource counts, and Player Controller page counts. Custom RPG is the only fresh-install system and offers eight quick-start character presets. An Admin can enable D&D 5e or another advanced pack when the table needs it; installed packs render editable fields and resources directly from their templates and can be removed only when no campaign uses them. Audio Packs list expansion soundscapes and SFX from the configured expansion repository cache and install them into the managed Media Library with folder queues and cover art. Custom template authoring builds on the versioned `/api/v1/systems` contract.

Settings treats updates as a restart-aware workflow. It disables system actions while work is in progress, polls public health until Nexus Core returns, reloads at the top of the page, and carries a success or failure notice through that reload so the outcome is never stranded below the fold.

The Player flow intentionally asks only for a campaign and character. That selection creates a character-scoped session whose only mutation is a bounded adjustment to that character's health; it is an isolation boundary for the simple local-table experience, not proof of a player's real-world identity. A campaign can add a player PIN later if a game requires stronger privacy.

Template-defined trackers appear only when their visibility rule matches. For D&D 5e, the GM battle card exposes death-save actions at zero HP while the Player surface shows the synchronized success, failure, stabilized, or dead state without mutation controls.

Live encounter changes are delivered with a campaign-scoped server-event stream. Player clients automatically fall back to periodic refreshes if a stream is interrupted, so play continues through brief local-network disruptions.

Android wrappers should store only their role token, load the matching local route, handle Nexus Wi-Fi onboarding, and expose a deliberate “unpair/switch” action. Business logic stays in the web application and versioned Nexus API.
