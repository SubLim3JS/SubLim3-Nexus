export class SystemControlService {
  constructor({ runner, platform = process.platform }) {
    this.runner = runner;
    this.platform = platform;
  }

  ensureSupported() {
    if (this.platform !== "linux") {
      throw Object.assign(new Error("System controls are available when Nexus Core runs on Raspberry Pi."), { statusCode: 503 });
    }
  }

  async shutdown() {
    this.ensureSupported();
    await this.runner.runPrivileged("system-shutdown");
  }

  async reboot() {
    this.ensureSupported();
    await this.runner.runPrivileged("system-reboot");
  }

  async update() {
    this.ensureSupported();
    return this.runner.runPrivileged("system-update");
  }
}
