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
  assert.deepEqual(actions, ["system-shutdown", "system-reboot", "system-update"]);
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

test("runs updater Git operations as the repository owner and repairs legacy ownership", async () => {
  const [helper, installer] = await Promise.all([
    readFile(new URL("../scripts/connectivity-helper.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/install.sh", import.meta.url), "utf8"),
  ]);
  assert.match(helper, /runuser -u "\$\{repository_owner\}" -- git/);
  assert.match(helper, /git_as_repository_owner fetch/);
  assert.match(helper, /git_as_repository_owner merge --ff-only FETCH_HEAD/);
  assert.match(installer, /chown -R "\$\{repository_owner\}:\$\{repository_group\}" "\$\{APP_DIR\}"/);
});
