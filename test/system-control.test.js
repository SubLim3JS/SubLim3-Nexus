import assert from "node:assert/strict";
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
