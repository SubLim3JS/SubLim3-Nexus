# Client surfaces and Android wrappers

SubLim3 Nexus has three role-specific browser surfaces. These responsive pages are the product interfaces and will later be wrapped by a shared Android WebView project with three product flavors rather than maintained as three unrelated apps.

| Surface | Browser route | Scope |
| --- | --- | --- |
| System Admin | `/admin/` | Full system, settings, campaigns, characters, sessions, devices, and future diagnostics |
| GM / DM | `/gm/` | One paired campaign: table state, battles, characters, media, and future companions |
| Player | `/player/` | One selected campaign and character with read-only public table state |

Admin and GM devices pair with installer-generated PINs. Their bearer tokens are random, stored only as hashes by Nexus Core, persisted across reboots, and expire after 90 days. Five failed PIN attempts temporarily lock pairing.

The Admin Access & Pairing panel lists active devices, their role scopes, and expiration dates. It can revoke a client or rotate the GM PIN; rotation immediately revokes all existing GM sessions.

The Player flow intentionally asks only for a campaign and character. That selection creates a character-scoped read-only session; it is an isolation boundary for the simple local-table experience, not proof of a player's real-world identity. A campaign can add a player PIN later if a game requires stronger privacy.

Android wrappers should store only their role token, load the matching local route, handle Nexus Wi-Fi onboarding, and expose a deliberate “unpair/switch” action. Business logic stays in the web application and versioned Nexus API.
