import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PlayerSettingsService } from "../core/src/player-settings.js";
import { JsonStore } from "../core/src/storage/json-store.js";

test("persists validated playback and RFID preferences", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nexus-player-settings-"));
  try {
    const service = new PlayerSettingsService({ store:new JsonStore(directory) });
    await service.initialize();
    const defaults = await service.get();
    assert.equal(defaults.maximum_volume, 100);
    assert.equal(defaults.rfid_rescan_delay_seconds, 2);
    assert.equal(defaults.audio_output_device, "pi");

    const updated = await service.update({ maximum_volume:75, startup_volume:50, rfid_second_scan:"restart", function_cards_bypass_delay:false, audio_output_device:"browser" });
    assert.equal(updated.maximum_volume, 75);
    assert.equal(updated.rfid_second_scan, "restart");
    assert.equal(updated.function_cards_bypass_delay, false);
    assert.equal(updated.audio_output_device, "browser");
    await assert.rejects(() => service.update({ startup_volume:90 }), /cannot exceed maximum/);
    await assert.rejects(() => service.update({ volume_step:7 }), /Volume step is invalid/);
    await assert.rejects(() => service.update({ function_cards_bypass_delay:"false" }), /must be true or false/);
    await assert.rejects(() => service.update({ audio_output_device:"speaker" }), /Audio output device is invalid/);
  } finally { await rm(directory, { recursive:true, force:true }); }
});
