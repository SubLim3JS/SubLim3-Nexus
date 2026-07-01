function unavailableStatus() {
  return {
    supported: false,
    wifi: { mode: "unavailable", interface: null, connection: null, ssid: null, addresses: [] },
    bluetooth: { available: false, powered: false, visible: false, pairable: false, connected_devices: [] },
  };
}

function parseBluetooth(output) {
  const value = (label) => new RegExp(`^\\s*${label}:\\s*(.+)$`, "mi").exec(output)?.[1]?.trim();
  return {
    available: Boolean(output),
    powered: value("Powered") === "yes",
    blocked: /PowerState:\s*off-blocked/mi.test(output),
    visible: value("Discoverable") === "yes",
    pairable: value("Pairable") === "yes",
  };
}

const BLUETOOTH_ADDRESS = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

function parseBluetoothDeviceRows(output) {
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [address, name, paired, trusted, connected] = line.split("\t");
    return {
      address,
      name: name || address,
      paired: paired === "true",
      trusted: trusted === "true",
      connected: connected === "true",
    };
  }).filter((device) => BLUETOOTH_ADDRESS.test(device.address));
}

function validateBluetoothAddress(address) {
  const normalized = String(address ?? "").trim();
  if (!BLUETOOTH_ADDRESS.test(normalized)) throw Object.assign(new Error("A valid Bluetooth device address is required"), { statusCode: 422 });
  return normalized.toUpperCase();
}

function splitNmcli(line) {
  const fields = [];
  let field = "";
  let escaped = false;
  for (const character of line) {
    if (escaped) { field += character; escaped = false; }
    else if (character === "\\") escaped = true;
    else if (character === ":") { fields.push(field); field = ""; }
    else field += character;
  }
  fields.push(field);
  return fields;
}

export class ConnectivityService {
  constructor({ runner, platform = process.platform, wifiInterface = "wlan0", hotspotConnection = "sublim3-hotspot" }) {
    this.runner = runner;
    this.platform = platform;
    this.wifiInterface = wifiInterface;
    this.hotspotConnection = hotspotConnection;
  }

  async status() {
    if (this.platform !== "linux") return unavailableStatus();
    try {
      const [connection, addresses, bluetoothOutput, connectedOutput] = await Promise.all([
        this.runner.run("nmcli", ["-g", "GENERAL.CONNECTION", "device", "show", this.wifiInterface]),
        this.runner.run("nmcli", ["-g", "IP4.ADDRESS", "device", "show", this.wifiInterface]),
        this.runner.run("bluetoothctl", ["show"]).catch(() => ""),
        this.runner.run("bluetoothctl", ["devices", "Connected"]).catch(() => ""),
      ]);
      const activeConnection = connection && connection !== "--" ? connection : null;
      let ssid = null;
      if (activeConnection) {
        ssid = await this.runner.run("nmcli", ["-g", "802-11-wireless.ssid", "connection", "show", activeConnection]).catch(() => null);
      }
      const bluetooth = parseBluetooth(bluetoothOutput);
      bluetooth.connected_devices = connectedOutput.split(/\r?\n/).filter(Boolean).map((line) => {
        const match = /^Device\s+(\S+)\s+(.+)$/.exec(line);
        return match ? { address: match[1], name: match[2] } : null;
      }).filter(Boolean);
      return {
        supported: true,
        wifi: {
          mode: activeConnection === this.hotspotConnection ? "local" : activeConnection ? "home" : "disconnected",
          interface: this.wifiInterface,
          connection: activeConnection,
          ssid: ssid || null,
          addresses: addresses.split(/\r?\n/).filter(Boolean),
        },
        bluetooth,
      };
    } catch (error) {
      return { ...unavailableStatus(), error: error.message };
    }
  }

  async scanWifi() {
    if (this.platform !== "linux") return [];
    const output = await this.runner.runPrivileged("wifi-scan");
    const unique = new Map();
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const [ssid, signal, security] = splitNmcli(line);
      if (ssid && (!unique.has(ssid) || Number(signal) > unique.get(ssid).signal)) unique.set(ssid, { ssid, signal: Number(signal) || 0, security: security || "Open" });
    }
    return [...unique.values()].sort((left, right) => right.signal - left.signal);
  }

  async switchWifi({ mode, ssid = "", password = "" }) {
    if (this.platform !== "linux") throw Object.assign(new Error("Wi-Fi control is only available on the Raspberry Pi"), { statusCode: 409 });
    if (mode === "local") return this.runner.runPrivileged("wifi-local");
    if (mode !== "home" || !ssid.trim() || ssid.length > 32 || ssid.startsWith("-") || /[\u0000-\u001f\u007f]/.test(ssid) || password.length > 64) throw Object.assign(new Error("Valid home Wi-Fi mode, SSID, and password are required"), { statusCode: 422 });
    return this.runner.runPrivileged("wifi-home", [ssid.trim()], `${password}\n`);
  }

  async setBluetoothVisible(visible) {
    if (this.platform !== "linux") throw Object.assign(new Error("Bluetooth control is only available on the Raspberry Pi"), { statusCode: 409 });
    return this.runner.runPrivileged("bluetooth-visible", [visible ? "on" : "off"]);
  }

  async bluetoothDevices() {
    if (this.platform !== "linux") return [];
    const output = await this.runner.runPrivileged("bluetooth-devices");
    return parseBluetoothDeviceRows(output);
  }

  async scanBluetooth() {
    if (this.platform !== "linux") return [];
    const output = await this.runner.runPrivileged("bluetooth-scan");
    return parseBluetoothDeviceRows(output);
  }

  async pairBluetooth(address) {
    if (this.platform !== "linux") throw Object.assign(new Error("Bluetooth pairing is only available on the Raspberry Pi"), { statusCode: 409 });
    const output = await this.runner.runPrivileged("bluetooth-pair", [validateBluetoothAddress(address)]);
    return parseBluetoothDeviceRows(output);
  }

  async connectBluetooth(address) {
    if (this.platform !== "linux") throw Object.assign(new Error("Bluetooth speaker control is only available on the Raspberry Pi"), { statusCode: 409 });
    const output = await this.runner.runPrivileged("bluetooth-connect", [validateBluetoothAddress(address)]);
    return parseBluetoothDeviceRows(output);
  }

  async disconnectBluetooth(address) {
    if (this.platform !== "linux") throw Object.assign(new Error("Bluetooth speaker control is only available on the Raspberry Pi"), { statusCode: 409 });
    const output = await this.runner.runPrivileged("bluetooth-disconnect", [validateBluetoothAddress(address)]);
    return parseBluetoothDeviceRows(output);
  }

  async forgetBluetooth(address) {
    if (this.platform !== "linux") throw Object.assign(new Error("Bluetooth speaker control is only available on the Raspberry Pi"), { statusCode: 409 });
    const output = await this.runner.runPrivileged("bluetooth-forget", [validateBluetoothAddress(address)]);
    return parseBluetoothDeviceRows(output);
  }

  async ping(target) {
    const normalizedTarget = String(target ?? "").trim();
    if (!normalizedTarget || normalizedTarget.length > 253 || normalizedTarget.startsWith("-") || !/^[a-zA-Z0-9_.:-]+$/.test(normalizedTarget)) {
      throw Object.assign(new Error("A valid hostname or IP address is required"), { statusCode: 422 });
    }
    if (this.platform !== "linux") {
      return { target: normalizedTarget, ok: false, output: "Network diagnostics are available when Nexus Core runs on Raspberry Pi." };
    }
    try {
      const output = await this.runner.runPrivileged("diagnostic-ping", [normalizedTarget]);
      return { target: normalizedTarget, ok: true, output };
    } catch (error) {
      return { target: normalizedTarget, ok: false, output: error.message || "Ping failed" };
    }
  }
}

export const connectivityInternals = { parseBluetoothDeviceRows };
