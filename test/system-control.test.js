import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { SystemControlService } from "../core/src/platform/system-control.js";

test("delegates system actions to the restricted privileged helper", async () => {
  const actions = [];
  const service = new SystemControlService({
    platform: "linux",
    runner: { runPrivileged: async (action) => { actions.push(action); return "ok"; } },
  });

  await service.shutdown();
  await service.reboot();
  assert.equal(await service.update(), "ok");
  await service.tone("failure");
  assert.deepEqual(actions, ["system-shutdown", "system-reboot", "system-update", "system-tone"]);
});

test("rejects system controls on unsupported platforms", async () => {
  const service = new SystemControlService({ platform: "win32", runner: {} });
  await assert.rejects(() => service.shutdown(), /Raspberry Pi/);
});

test("surfaces privileged update failures to the Settings client", async () => {
  const service = new SystemControlService({
    platform: "linux",
    runner: { runPrivileged: async () => { throw new Error("repository is not writable"); } },
  });
  await assert.rejects(
    service.update(),
    (error) => error.statusCode === 502 && error.message === "Update failed: repository is not writable",
  );
});

test("runs updates with an isolated Git environment outside the Core sandbox", async () => {
  const [helper, installer, server] = await Promise.all([
    readFile(new URL("../scripts/connectivity-helper.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/install.sh", import.meta.url), "utf8"),
    readFile(new URL("../core/src/server.js", import.meta.url), "utf8"),
  ]);
  assert.match(helper, /runuser -u "\$\{repository_owner\}" -- env/);
  assert.match(helper, /HOME="\$\{APP_DIR\}"/);
  assert.match(helper, /XDG_CONFIG_HOME="\$\{APP_DIR\}\/\.git\/\.config"/);
  assert.match(helper, /GIT_CONFIG_GLOBAL=\/dev\/null/);
  assert.match(helper, /git_as_repository_owner fetch/);
  assert.match(helper, /git_as_repository_owner merge --ff-only FETCH_HEAD/);
  assert.match(helper, /play_update_tone success/);
  assert.match(helper, /play_update_tone failure/);
  assert.match(helper, /play_update_tone reboot/);
  assert.match(helper, /play_update_tone shutdown/);
  assert.match(helper, /"ready" ==|ready/);
  assert.match(helper, /system-tone\)/);
  assert.match(helper, /System tone must be ready, reboot, shutdown, success, or failure\./);
  assert.match(helper, /restart_core\(\)/);
  assert.match(helper, /systemctl restart --no-block sublim3-nexus\.service/);
  assert.match(helper, /wifi-local\).*start_hotspot; restart_core/);
  assert.match(server, /audio\.triggerEffect\("system-boot-ready"\)/);
  assert.match(installer, /NEXUS_INSTALL_TRANSIENT/);
  assert.match(installer, /systemd-run --quiet --wait --pipe --collect/);
  assert.match(installer, /--unit=sublim3-nexus-install/);
  assert.match(installer, /bluez-alsa-utils/);
  assert.match(installer, /bluealsa\.service/);
  assert.match(installer, /chown -R "\$\{repository_owner\}:\$\{repository_group\}" "\$\{APP_DIR\}"/);
  assert.match(installer, /generate_six_digit_pin\(\)/);
  assert.match(installer, /owner_pin="101010"/);
  assert.match(installer, /recovery_pin="\$\(generate_six_digit_pin\)"/);
  assert.match(installer, /replace_setting_if_value NEXUS_SETTINGS_PIN 101010 "\$\{recovery_pin\}"/);
  assert.match(installer, /replace_setting_if_value NEXUS_BLUETOOTH_AUDIO_DEVICE auto alsa\/bluealsa/);
  assert.match(installer, /ensure_setting NEXUS_SETTINGS_PIN "\$\{recovery_pin\}"/);
  assert.match(installer, /ensure_setting NEXUS_BLUETOOTH_AUDIO_DEVICE alsa\/bluealsa/);
  assert.match(installer, /ensure_setting NEXUS_ADMIN_PIN "\$\{owner_pin\}"/);
  assert.match(installer, /Owner PIN:/);
  assert.doesNotMatch(installer, /Admin PIN:/);
  assert.match(installer, /Recovery PIN:/);
});

test("allows the privileged helper to persist runtime network settings", async () => {
  const service = await readFile(new URL("../deploy/systemd/sublim3-nexus.service", import.meta.url), "utf8");
  assert.match(service, /ProtectSystem=full/);
  assert.match(service, /ReadWritePaths=.*\/var\/lib\/sublim3-nexus.*\/etc\/default/);
});
