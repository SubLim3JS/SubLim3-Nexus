# SubLim3 Nexus expansion repository

Optional content should live outside the core Nexus application repo. The core
repo should stay focused on the engine, device support, UI, updater, installer,
Custom RPG, and tiny built-in system sounds.

Use `SubLim3-Nexus-Expansions` for downloadable game systems and audio packs.

## Recommended layout

```text
SubLim3-Nexus-Expansions/
  README.md
  catalog.json

  packs/
    dnd5e/
      manifest.json
      system.json
      audio/
        Battle Mode/
          cover.jpg
          initiative-rise.mp3
          boss-fight-loop.ogg
        Tavern/
          busy-inn.mp3
        Dungeon/
          dripping-cavern.flac
        SFX/
          sword-clash.wav

    scifi-dice-pool/
      manifest.json
      system.json
      audio/
        Battle Mode/
        Starship/
        SFX/

  audio-packs/
    fantasy-core/
      manifest.json
      files/
        Battle Mode/
        Travel/
        Tavern/
        SFX/

    horror-core/
      manifest.json
      files/
        Tension/
        Chase/
        SFX/
```

## Where to put audio files

Put game-specific audio inside the game pack:

```text
packs/<pack_id>/audio/<folder>/<file>
```

Example:

```text
packs/dnd5e/audio/Battle Mode/initiative-rise.mp3
packs/dnd5e/audio/Battle Mode/cover.jpg
packs/dnd5e/audio/Tavern/busy-inn.mp3
packs/dnd5e/audio/SFX/critical-hit.wav
```

Put shared audio that can be used by multiple systems inside an audio pack:

```text
audio-packs/<audio_pack_id>/files/<folder>/<file>
```

Example:

```text
audio-packs/fantasy-core/files/Battle Mode/battle-drums.ogg
audio-packs/fantasy-core/files/Battle Mode/cover.jpg
audio-packs/fantasy-core/files/Dungeon/deep-cavern.flac
audio-packs/fantasy-core/files/SFX/door-open.wav
```

Add `cover.jpg`, `cover.jpeg`, `cover.png`, or `cover.webp` to any audio
folder to use it as the Media player album art for tracks imported from that
folder. Child folders inherit the nearest parent cover.

## Folder names become GM queues

Nexus preserves the folder structure as managed library folders. A GM can pick a
folder such as `Expansion Audio/Dnd5e/Battle Mode`, and the Media page will use
the ambience tracks inside that folder as the active scene queue.

Recommended folder names:

- `Battle Mode`
- `Tavern`
- `Dungeon`
- `Travel`
- `Town`
- `Tension`
- `Boss Fight`
- `SFX`

Files inside folders named `SFX`, `FX`, `Effect`, or `Effects` are imported as
one-shot effects. Other audio files are imported as looping ambience by default.

## Installing into Nexus

Owners can open `/packs/`, choose **Audio Packs**, and install or remove audio
packs from the Nexus UI. Installed files are copied into the managed Media
Library under `Expansion Audio/<pack name>/...`; they can then be queued in the
Media player or assigned to RFID cards.

The Pi installer keeps a best-effort local cache of this repository under the
Nexus data directory so a fresh install can show available audio packs as soon
as the expansion repository is reachable. Configure alternate sources with
`NEXUS_EXPANSIONS_REPO`, `NEXUS_EXPANSIONS_REF`, or `NEXUS_EXPANSIONS_DIR`.

## Command-line import

From the core repo:

```bash
npm run audio:expansions:import
```

To remove imported expansion audio after testing:

```bash
npm run audio:expansions:remove
```

The importer defaults to:

```text
https://github.com/SubLim3JS/SubLim3-Nexus-Expansions.git
```

Override the repo or branch/tag when needed:

```bash
node scripts/import-expansion-audio.mjs --repo <git-url> --ref <branch-or-tag>
```
