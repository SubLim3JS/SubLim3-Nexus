# Client surfaces and Android wrappers

SubLim3 Nexus has three role-specific browser surfaces. These responsive pages are the product interfaces and will later be wrapped by a shared Android WebView project with three product flavors rather than maintained as three unrelated apps.

| Surface | Browser route | Scope |
| --- | --- | --- |
| System Admin | `/admin/` | Full system, settings, campaigns, characters, sessions, devices, and future diagnostics |
| GM / DM | `/gm/` | One paired campaign: scenes, encounter building, initiative, health, conditions, and future companions |
| Player | `/player/` | One selected character with live table state, turn highlighting, and scoped health control |

Admin and GM devices pair with installer-generated PINs. Their bearer tokens are random, stored only as hashes by Nexus Core, persisted across reboots, and expire after 90 days. Five failed PIN attempts temporarily lock pairing.

The Admin Access & Pairing panel lists active devices, their role scopes, and expiration dates. It can revoke a client or rotate the GM PIN; rotation immediately revokes all existing GM sessions.

The Admin Expansion Packs catalog lists optional packs, installation state, creation experience, character-field and resource counts, and Player Controller page counts. Custom RPG is the only fresh-install system and offers eight quick-start character presets. An Admin can enable D&D 5e or another advanced pack when the table needs it; installed packs render editable fields and resources directly from their templates and can be removed only when no campaign uses them. Custom template authoring builds on the versioned `/api/v1/systems` contract.

Settings treats updates as a restart-aware workflow. It disables system actions while work is in progress, polls public health until Nexus Core returns, reloads at the top of the page, and carries a success or failure notice through that reload so the outcome is never stranded below the fold.

The Player flow intentionally asks only for a campaign and character. That selection creates a character-scoped session whose only mutation is a bounded adjustment to that character's health; it is an isolation boundary for the simple local-table experience, not proof of a player's real-world identity. A campaign can add a player PIN later if a game requires stronger privacy.

Template-defined trackers appear only when their visibility rule matches. For D&D 5e, the GM battle card exposes death-save actions at zero HP while the Player surface shows the synchronized success, failure, stabilized, or dead state without mutation controls.

Live encounter changes are delivered with a campaign-scoped server-event stream. Player clients automatically fall back to periodic refreshes if a stream is interrupted, so play continues through brief local-network disruptions.

Android wrappers should store only their role token, load the matching local route, handle Nexus Wi-Fi onboarding, and expose a deliberate “unpair/switch” action. Business logic stays in the web application and versioned Nexus API.
