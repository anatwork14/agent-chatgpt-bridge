#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { loadConfig } from "../config";
import { findInstalledLauncherExecutable } from "../dev-chat/profile";
import {
  bridgeApiToken,
  createBridgeRuntime,
  resolveBridgePort,
} from "../runtime/bridge-runtime";
import { composePrompt } from "./prompt";

const HELP = `agent-chatgpt

Universal Agent -> ChatGPT Web bridge.

Usage:
  agent-chatgpt app
  agent-chatgpt serve
  agent-chatgpt stop [--json]
  agent-chatgpt status [--json]
  agent-chatgpt models [--json]
  agent-chatgpt login
  agent-chatgpt doctor [--json]
  agent-chatgpt browser-smoke
  agent-chatgpt mcp
  agent-chatgpt session create [--name NAME] [--model MODEL] [--effort EFFORT] [--json]
  agent-chatgpt session list [--json]
  agent-chatgpt session show SESSION [--json]
  agent-chatgpt session transcript SESSION [--json]
  agent-chatgpt session cancel SESSION [--json]
  agent-chatgpt session close SESSION [--json]
  agent-chatgpt ask [--session SESSION] [--stdin] [--prompt-prefix TEXT]
                    [--quiet-session] [--json] [MESSAGE]
  agent-chatgpt run --objective TEXT --agent-command PATH [--session SESSION]
                    [--max-rounds N] [--max-wall-clock-ms N] [--json]
  agent-chatgpt run list [--json]
  agent-chatgpt run show RUN_ID [--json]
  agent-chatgpt run cancel RUN_ID [--json]

Global:
  --home PATH                 Override ~/.codex-chatgpt-web
  --bridge-port PORT          Override bridge port (default 8765)
  -h, --help
`;

interface ClientConfig {
  baseUrl: string;
  token: string;
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function numericOption(args: string[], name: string): number | undefined {
  const value = takeOption(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be numeric`);
  return parsed;
}

function assertNoArgs(args: string[]): void {
  if (args.length > 0) throw new Error(`Unknown arguments: ${args.join(" ")}`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function legacyCliEntrypoint(): string {
  const current = process.argv[1];
  if (!current) throw new Error("Could not resolve the agent-chatgpt runtime entrypoint");
  const currentDir = dirname(resolve(current));

  const packaged = join(currentDir, "cli.js");
  if (existsSync(packaged)) return packaged;

  const source = resolve(currentDir, "..", "cli.ts");
  if (existsSync(source)) return source;

  throw new Error("Could not locate the inherited codex-chatgpt-web CLI runtime");
}

async function runLegacyCli(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, legacyCliEntrypoint(), ...args], {
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exitCode = exitCode;
}

function appCommand(): void {
  const executable = findInstalledLauncherExecutable();
  const child = spawn(executable, [], {
    detached: true,
    env: process.env,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  stdout.write(`Opened Codex Web GPT: ${executable}\n`);
}

function clientConfig(portOverride?: number): ClientConfig {
  const config = loadConfig();
  const port = resolveBridgePort(portOverride);
  return {
    baseUrl: `http://127.0.0.1:${port}/bridge/v1`,
    token: bridgeApiToken(config),
  };
}

async function requestJson(
  client: ClientConfig,
  path: string,
  init: RequestInit = {},
): Promise<any> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${client.token}`);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${client.baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let payload: any;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: { code: "invalid_response", message: text || `HTTP ${response.status}` } };
  }
  if (!response.ok) {
    const message = payload?.error?.message || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function print(value: unknown, json: boolean): void {
  if (json || typeof value !== "string") {
    stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    stdout.write(`${value}\n`);
  }
}

async function serveCommand(portOverride?: number): Promise<void> {
  const config = loadConfig();
  let requestStop!: () => void;
  const stopRequested = new Promise<void>(resolveStop => {
    requestStop = resolveStop;
  });
  const runtime = await createBridgeRuntime(config, {
    port: portOverride,
    requestShutdown: requestStop,
  });
  const server = Bun.serve({
    hostname: runtime.host,
    port: runtime.port,
    fetch: runtime.api.fetch,
    idleTimeout: 0,
  });

  stdout.write(
    `agent-chatgpt bridge listening on ${runtime.baseUrl}\n`
      + `default model: ${runtime.defaultModel}\n`
      + `available models: ${runtime.models.join(", ")}\n`
      + (runtime.recoveredInterruptedTurns > 0
        ? `recovered interrupted turns: ${runtime.recoveredInterruptedTurns}\n`
        : ""),
  );

  const signalStop = () => requestStop();
  process.once("SIGINT", signalStop);
  process.once("SIGTERM", signalStop);
  try {
    await stopRequested;
    const results = await Promise.allSettled([
      server.stop(false),
      runtime.close(),
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(result => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "agent-chatgpt shutdown failed");
    }
  } finally {
    process.off("SIGINT", signalStop);
    process.off("SIGTERM", signalStop);
  }
}

async function sessionCommand(args: string[], client: ClientConfig, json: boolean): Promise<void> {
  const action = args.shift();
  if (action === "create") {
    const name = takeOption(args, "--name");
    const model = takeOption(args, "--model");
    const effort = takeOption(args, "--effort");
    assertNoArgs(args);
    print(await requestJson(client, "/sessions", {
      method: "POST",
      body: JSON.stringify({ name, model, effort }),
    }), json);
    return;
  }
  if (action === "list") {
    assertNoArgs(args);
    print(await requestJson(client, "/sessions"), json);
    return;
  }
  if (action === "show") {
    const session = args.shift();
    if (!session) throw new Error("session show requires SESSION");
    assertNoArgs(args);
    print(await requestJson(client, `/sessions/${encodeURIComponent(session)}`), json);
    return;
  }
  if (action === "transcript") {
    const session = args.shift();
    if (!session) throw new Error("session transcript requires SESSION");
    assertNoArgs(args);
    print(await requestJson(client, `/sessions/${encodeURIComponent(session)}/messages`), json);
    return;
  }
  if (action === "cancel") {
    const session = args.shift();
    if (!session) throw new Error("session cancel requires SESSION");
    assertNoArgs(args);
    print(await requestJson(client, `/sessions/${encodeURIComponent(session)}/cancel`, { method: "POST" }), json);
    return;
  }
  if (action === "close") {
    const session = args.shift();
    if (!session) throw new Error("session close requires SESSION");
    assertNoArgs(args);
    print(await requestJson(client, `/sessions/${encodeURIComponent(session)}`, { method: "DELETE" }), json);
    return;
  }
  throw new Error("session command must be one of: create, list, show, transcript, cancel, close");
}

async function askCommand(args: string[], client: ClientConfig, json: boolean): Promise<void> {
  let sessionId = takeOption(args, "--session");
  const promptPrefix = takeOption(args, "--prompt-prefix");
  const fromStdin = takeFlag(args, "--stdin");
  const quietSession = takeFlag(args, "--quiet-session");
  const message = fromStdin ? await readStdin() : args.join(" ").trim();
  if (fromStdin) assertNoArgs(args);
  const prompt = composePrompt(message, promptPrefix);
  if (!prompt.trim()) throw new Error("ask requires MESSAGE, --stdin, or --prompt-prefix");

  if (!sessionId) {
    const session = await requestJson(client, "/sessions", {
      method: "POST",
      body: JSON.stringify({}),
    });
    sessionId = session.id;
  }

  const result = await requestJson(
    client,
    `/sessions/${encodeURIComponent(sessionId!)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        content: [{ type: "text", text: prompt }],
        stream: false,
      }),
    },
  );
  if (json) print(result, true);
  else {
    const text = result?.message?.content?.find((part: any) => part?.type === "text")?.text;
    if (typeof text === "string") stdout.write(`${text}\n`);
    else print(result, true);
    if (!quietSession) process.stderr.write(`session: ${sessionId}\n`);
  }
}

async function runCommand(args: string[], client: ClientConfig, json: boolean): Promise<void> {
  const action = args[0];
  if (action === "list") {
    args.shift();
    assertNoArgs(args);
    print(await requestJson(client, "/runs"), json);
    return;
  }
  if (action === "show" || action === "cancel") {
    args.shift();
    const runId = args.shift();
    if (!runId) throw new Error(`run ${action} requires RUN_ID`);
    assertNoArgs(args);
    print(await requestJson(
      client,
      `/runs/${encodeURIComponent(runId)}${action === "cancel" ? "/cancel" : ""}`,
      action === "cancel" ? { method: "POST" } : {},
    ), json);
    return;
  }

  const objective = takeOption(args, "--objective");
  const agentCommand = takeOption(args, "--agent-command");
  const sessionId = takeOption(args, "--session");
  const maxRounds = numericOption(args, "--max-rounds");
  const maxWallClockMs = numericOption(args, "--max-wall-clock-ms");
  const maxConsecutiveFailures = numericOption(args, "--max-consecutive-failures");
  if (!objective) throw new Error("run requires --objective TEXT");
  if (!agentCommand) throw new Error("run requires --agent-command PATH");
  assertNoArgs(args);

  print(await requestJson(client, "/runs", {
    method: "POST",
    body: JSON.stringify({
      objective,
      agent_adapter: {
        type: "subprocess-jsonl",
        command: [agentCommand],
      },
      chatgpt: sessionId ? { session_id: sessionId } : {},
      budget: {
        max_rounds: maxRounds,
        max_wall_clock_ms: maxWallClockMs,
        max_consecutive_failures: maxConsecutiveFailures,
      },
    }),
  }), json);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const home = takeOption(args, "--home");
  if (home) process.env.CODEX_CHATGPT_WEB_HOME = home;
  const portOverride = numericOption(args, "--bridge-port");
  const json = takeFlag(args, "--json");
  if (takeFlag(args, "--help") || takeFlag(args, "-h")) {
    stdout.write(HELP);
    return;
  }

  const command = args.shift() ?? "help";
  if (command === "help") {
    stdout.write(HELP);
    return;
  }
  if (command === "app") {
    assertNoArgs(args);
    appCommand();
    return;
  }
  if (command === "serve") {
    assertNoArgs(args);
    await serveCommand(portOverride);
    return;
  }
  if (command === "login") {
    assertNoArgs(args);
    await runLegacyCli(["login"]);
    return;
  }
  if (command === "doctor") {
    assertNoArgs(args);
    await runLegacyCli(["doctor", ...(json ? ["--json"] : [])]);
    return;
  }
  if (command === "browser-smoke") {
    assertNoArgs(args);
    await runLegacyCli(["browser", "check"]);
    return;
  }
  if (command === "mcp") {
    assertNoArgs(args);
    const runtime = await createBridgeRuntime(loadConfig(), { port: portOverride });
    try {
      await runtime.mcp.run();
    } finally {
      await runtime.close();
    }
    return;
  }

  const client = clientConfig(portOverride);
  if (command === "stop") {
    assertNoArgs(args);
    print(await requestJson(client, "/shutdown", { method: "POST" }), json);
    return;
  }
  if (command === "status") {
    assertNoArgs(args);
    print(await requestJson(client, "/healthz"), json);
    return;
  }
  if (command === "models") {
    assertNoArgs(args);
    print(await requestJson(client, "/models"), json);
    return;
  }
  if (command === "session") {
    await sessionCommand(args, client, json);
    return;
  }
  if (command === "ask") {
    await askCommand(args, client, json);
    return;
  }
  if (command === "run") {
    await runCommand(args, client, json);
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

main().catch(error => {
  process.stderr.write(`agent-chatgpt: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});