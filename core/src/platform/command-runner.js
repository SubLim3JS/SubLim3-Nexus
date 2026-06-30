import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class CommandRunner {
  async run(command, args = []) {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    return stdout.trim();
  }

  async runPrivileged(action, args = [], input = "") {
    const helper = process.env.NEXUS_CONNECTIVITY_HELPER ?? "/usr/local/libexec/sublim3-nexus-connectivity";
    return new Promise((resolve, reject) => {
      const child = spawn("sudo", ["-n", helper, action, ...args], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timeout = action === "system-update" ? 10 * 60_000 : 120_000;
      const timer = setTimeout(() => child.kill(), timeout);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout.trim());
        else reject(Object.assign(new Error(stderr.trim() || `Privileged helper exited with code ${code}`), { statusCode: 502 }));
      });
      child.stdin.end(input);
    });
  }
}
