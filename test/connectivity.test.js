import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ConnectivityService } from "../core/src/platform/connectivity.js";

class FakeRunner {
  constructor(outputs = new Map(), privilegedOutputs = new Map()) { this.outputs = outputs; this.privilegedOutputs = privilegedOutputs; this.privileged = []; }
  async run(command, args) { const key = `${command} ${args.join(" ")}`; if (!this.outputs.has(key)) throw new Error(`Unexpected command: ${key}`); return this.outputs.get(key); }
  async runPrivileged(action, args = [], input = "") { this.privileged.push({ action, args, input }); return this.privilegedOutputs.get(action) ?? "ok"; }
}

test("reports Raspberry Pi Wi-Fi and Bluetooth state", async () => {
  const runner = new FakeRunner(new Map([
    ["nmcli -g GENERAL.CONNECTION device show wlan0", "sublim3-hotspot"],
    ["nmcli -g IP4.ADDRESS device show wlan0", "10.10.10.1/24"],
    ["nmcli -g 802-11-wireless.ssid connection show sublim3-hotspot", "SubLim3-Nexus"],
    ["bluetoothctl show", "Powered: yes\nDiscoverable: yes\nPairable: yes"],
    ["bluetoothctl devices Connected", "Device AA:BB:CC:DD:EE:FF Table Speaker"],
  ]));
  const service = new ConnectivityService({ runner, platform: "linux" });
  const status = await service.status();
  assert.equal(status.wifi.mode, "local");
  assert.equal(status.wifi.ssid, "SubLim3-Nexus");
  assert.equal(status.bluetooth.visible, true);
  assert.equal(status.bluetooth.connected_devices[0].name, "Table Speaker");
});

test("connectivity helper migrates legacy hotspot addresses to the recovery subnet", async () => {
  const helper = await readFile(new URL("../scripts/connectivity-helper.sh", import.meta.url), "utf8");
  const installer = await readFile(new URL("../scripts/install.sh", import.meta.url), "utf8");
  assert.match(installer, /replace_setting_if_value NEXUS_HOTSPOT_ADDRESS 10\.42\.0\.1\/24 10\.10\.10\.1\/24/);
  assert.match(helper, /HOTSPOT_ADDRESS.*10\.42\.0\.1\/24/);
  assert.match(helper, /set_config_value NEXUS_HOTSPOT_ADDRESS "\$\{HOTSPOT_ADDRESS\}"/);
});

test("reports blocked Bluetooth power state", async () => {
  const runner = new FakeRunner(new Map([
    ["nmcli -g GENERAL.CONNECTION device show wlan0", "sublim3-hotspot"],
    ["nmcli -g IP4.ADDRESS device show wlan0", "10.10.10.1/24"],
    ["nmcli -g 802-11-wireless.ssid connection show sublim3-hotspot", "SubLim3-Nexus"],
    ["bluetoothctl show", "Powered: no\nPowerState: off-blocked\nDiscoverable: no\nPairable: no"],
    ["bluetoothctl devices Connected", ""],
  ]));
  const status = await new ConnectivityService({ runner, platform: "linux" }).status();
  assert.equal(status.bluetooth.available, true);
  assert.equal(status.bluetooth.powered, false);
  assert.equal(status.bluetooth.blocked, true);
  assert.equal(status.bluetooth.visible, false);
});

test("connectivity helper waits for Bluetooth visibility changes", async () => {
  const helper = await readFile(new URL("../scripts/connectivity-helper.sh", import.meta.url), "utf8");
  assert.match(helper, /for attempt in 1 2 3 4 5; do[\s\S]*bluetoothctl power on/);
  assert.match(helper, /Discoverable: yes/);
  assert.match(helper, /Discoverable: no/);
});

test("delegates only validated connectivity mutations", async () => {
  const runner = new FakeRunner();
  const service = new ConnectivityService({ runner, platform: "linux" });
  await service.switchWifi({ mode: "home", ssid: "Table WiFi", password: "secret-pass" });
  await service.setBluetoothVisible(true);
  const ping = await service.ping("192.168.1.1");
  assert.deepEqual(runner.privileged, [
    { action: "wifi-home", args: ["Table WiFi"], input: "secret-pass\n" },
    { action: "bluetooth-visible", args: ["on"], input: "" },
    { action: "diagnostic-ping", args: ["192.168.1.1"], input: "" },
  ]);
  assert.equal(ping.ok, true);
  await assert.rejects(() => service.switchWifi({ mode: "home", ssid: "", password: "" }), /Valid home Wi-Fi/);
  await assert.rejects(() => service.ping("-bad"), /valid hostname/);
});

test("surfaces privileged Wi-Fi failures to callers", async () => {
  const service = new ConnectivityService({
    runner: { runPrivileged: async () => { throw Object.assign(new Error("hotspot activation failed"), { statusCode: 502 }); } },
    platform: "linux",
  });
  await assert.rejects(
    () => service.switchWifi({ mode: "local" }),
    (error) => error.statusCode === 502 && error.message === "hotspot activation failed",
  );
});

test("parses and orders escaped Wi-Fi scan results", async () => {
  const runner = new FakeRunner(new Map(), new Map([["wifi-scan", "Cafe\\:Table:72:WPA2\nGuest:30:"]]));
  const service = new ConnectivityService({ runner, platform: "linux" });
  assert.deepEqual(await service.scanWifi(), [
    { ssid: "Cafe:Table", signal: 72, security: "WPA2" },
    { ssid: "Guest", signal: 30, security: "Open" },
  ]);
});

test("disables hardware controls away from Linux", async () => {
  const service = new ConnectivityService({ runner: new FakeRunner(), platform: "win32" });
  assert.equal((await service.status()).supported, false);
  await assert.rejects(() => service.switchWifi({ mode: "local" }), /Raspberry Pi/);
});
