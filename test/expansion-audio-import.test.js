import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

test("imports and removes optional expansion audio", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "nexus-expansion-audio-"));
  try {
    const source = path.join(temporaryDirectory, "source");
    const data = path.join(temporaryDirectory, "data");
    await mkdir(path.join(source, "packs", "dnd5e", "audio", "Battle Mode"), { recursive: true });
    await mkdir(path.join(source, "audio-packs", "fantasy-sfx", "files", "SFX"), { recursive: true });
    await writeFile(path.join(source, "audio-packs", "fantasy-sfx", "manifest.json"), JSON.stringify({ pack_id: "fantasy-sfx", name: "Fantasy: SFX", library_folder: "Fantasy", tags: ["Fantasy"] }));
    await writeFile(path.join(source, "packs", "dnd5e", "audio", "Battle Mode", "initiative-rise.mp3"), Buffer.from("battle ambience"));
    await writeFile(path.join(source, "packs", "dnd5e", "audio", "Battle Mode", "cover.jpg"), Buffer.from("cover image"));
    await writeFile(path.join(source, "audio-packs", "fantasy-sfx", "files", "SFX", "door-open.wav"), Buffer.from("door effect"));

    await execFile(process.execPath, ["scripts/import-expansion-audio.mjs", "--source", source, "--data-dir", data]);

    const libraryDirectory = path.join(data, "audio", "library");
    const records = await Promise.all((await readdir(libraryDirectory)).map(async (file) => JSON.parse(await readFile(path.join(libraryDirectory, file), "utf8"))));
    const battle = records.find((item) => item.name === "initiative rise");
    const effect = records.find((item) => item.name === "door open");

    assert.equal(records.length, 2);
    assert.equal(battle.kind, "ambience");
    assert.equal(battle.folder_path, "Expansion Audio/Dnd5e/Battle Mode");
    assert.equal(battle.pack_id, "dnd5e");
    assert.equal(battle.source.imported_from, "sublim3-nexus-expansions");
    assert.equal(battle.artwork.relative_path, "Expansion Audio/Dnd5e/Battle Mode/cover.jpg");
    assert.equal(battle.artwork.content_type, "image/jpeg");
    assert.ok(battle.tags.includes("Battle Mode"));
    assert.equal(effect.kind, "effect");
    assert.equal(effect.folder_path, "Expansion Audio/Fantasy/SFX");
    assert.equal(effect.loop, false);
    await stat(path.join(data, "audio", "files", ...battle.source.relative_path.split("/")));
    await stat(path.join(data, "audio", "files", ...battle.artwork.relative_path.split("/")));

    await execFile(process.execPath, ["scripts/import-expansion-audio.mjs", "--remove", "--data-dir", data]);
    assert.deepEqual(await readdir(libraryDirectory), []);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
