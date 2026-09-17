import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export type OwnedAgentProcess = ChildProcessByStdio<Writable, Readable, null>;

export interface OwnedAgentProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
}

const SAFE_ENVIRONMENT_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TMP", "TEMP",
  "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
];

export function safeEnvironment(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("LC_") && value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

export function spawnOwnedAgentProcess(
  command: readonly string[],
  options: OwnedAgentProcessOptions = {},
): OwnedAgentProcess {
  const executable = command[0];
  if (!executable?.trim()) throw new Error("Agent command must contain a non-empty executable");
  return spawn(executable, command.slice(1), {
    cwd: options.cwd ?? process.cwd(),
    env: safeEnvironment(options.env),
    stdio: ["pipe", "pipe", "inherit"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
}

export function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
}

function processExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function terminateProcessTreeAndWait(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (processExited(child)) return;
  terminateProcessTree(child);
  await waitForProcessExit(child, timeoutMs);
  if (processExited(child)) return;

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid ?? ""), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
  } else {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Fall through to the direct-child fallback below.
    }
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  await waitForProcessExit(child, timeoutMs);
}

export async function waitForProcessExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (processExited(child)) return true;
  return await new Promise<boolean>(resolve => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("close", onClose);
      resolve(exited);
    };
    const onClose = () => finish(true);
    const timeout = setTimeout(() => finish(processExited(child)), Math.max(1, timeoutMs));
    child.once("close", onClose);
  });
}
