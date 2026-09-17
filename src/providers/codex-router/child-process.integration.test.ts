import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AppConfig } from "../../config";
import { bridgeApiToken } from "../../runtime/bridge-runtime";

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback test port"));
        return;
      }
      const port = address.port;
      server.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}

function testConfig(home: string): AppConfig {
  const brokerSocketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\agent-chatgpt-router-${process.pid}-${Date.now()}`
    : join(home, "runtime", "turn-broker.sock");
  return {
    version: 3,
    releaseVersion: "integration-test",
    mode: "browser-only",
    subagentProtocol: "native",
    host: "127.0.0.1",
    port: 1455,
    contextWindow: 128_000,
    appName: "Codex Native2",
    automaticAppName: "Codex Native2",
    manualAppName: "Codex Zero Risk",
    browserHost: "managed-chrome",
    browserInteractionMode: "automatic",
    chromeExecutablePath: process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "/usr/bin/google-chrome",
    storageStatePath: join(home, "storage-state.json"),
    brokerSocketPath,
    headed: false,
    solAvailable: true,
    proAvailable: false,
    experimentalBiggerContext: false,
    zeroRiskProEnabled: false,
    autoApproveToolCalls: false,
    controlToken: "integration_test_control_token_0123456789abcdef",
    runtimeCommand: [process.execPath],
  };
}

async function waitForBridge(baseUrl: string, token: string, child: Bun.Subprocess): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`bridge child exited before becoming ready (code ${child.exitCode})`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
    } catch {
      // Listener may not be bound yet.
    }
    await Bun.sleep(50);
  }
  throw new Error("bridge child did not become ready before timeout");
}

async function runCli(cliPath: string, home: string, port: number, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const child = Bun.spawn([
    process.execPath,
    cliPath,
    "--home",
    home,
    "--bridge-port",
    String(port),
    ...args,
  ], {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`agent-chatgpt ${args.join(" ")} failed (${exitCode}): ${stderr || stdout}`);
  }
  return { stdout, stderr };
}

test("codex-router works through a real child bridge process", async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-chatgpt-router-child-"));
  const config = testConfig(home);
  mkdirSync(join(home, "runtime"), { recursive: true });
  writeFileSync(join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`);

  const responseBodies: any[] = [];
  const router = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "test-provider/test-model", object: "model" }] });
      }
      if (url.pathname.endsWith("/responses") && request.method === "POST") {
        const body = await request.json() as any;
        responseBodies.push(body);
        const turn = responseBodies.length;
        const text = `router child answer ${turn}`;
        const stream = [
          `event: response.output_text.delta\r\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\r\n\r\n`,
          `event: response.completed\r\ndata: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: `resp_child_${turn}`,
              status: "completed",
              output: [],
              usage: { input_tokens: body.input.length, output_tokens: 4, total_tokens: body.input.length + 4 },
            },
          })}\r\n\r\n`,
          "data: [DONE]\r\n\r\n",
        ].join("");
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const bridgePort = await availablePort();
  const baseUrl = `http://127.0.0.1:${bridgePort}/bridge/v1`;
  const token = bridgeApiToken(config);
  const cliPath = resolve(import.meta.dir, "../../cli/index.ts");
  const serverChild = Bun.spawn([
    process.execPath,
    cliPath,
    "--home",
    home,
    "--bridge-port",
    String(bridgePort),
    "serve",
  ], {
    env: {
      ...process.env,
      AGENT_CHATGPT_CODEX_ROUTER_BASE_URL: `http://127.0.0.1:${router.port}/caller-capability/v1`,
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });

  try {
    await waitForBridge(baseUrl, token, serverChild);

    const models = JSON.parse((await runCli(cliPath, home, bridgePort, ["models", "--json"])).stdout);
    expect(models.models).toContain("chatgpt-web/high");
    expect(models.models).toContain("codex-router/test-provider/test-model");

    const created = JSON.parse((await runCli(cliPath, home, bridgePort, [
      "session",
      "create",
      "--name",
      "router-child",
      "--model",
      "codex-router/test-provider/test-model",
      "--json",
    ])).stdout);
    expect(created.id).toBeString();

    const first = JSON.parse((await runCli(cliPath, home, bridgePort, [
      "ask",
      "--session",
      created.id,
      "--json",
      "first child-process question",
    ])).stdout);
    expect(JSON.stringify(first)).toContain("router child answer 1");

    const second = JSON.parse((await runCli(cliPath, home, bridgePort, [
      "ask",
      "--session",
      created.id,
      "--json",
      "second child-process question",
    ])).stdout);
    expect(JSON.stringify(second)).toContain("router child answer 2");

    expect(responseBodies).toHaveLength(2);
    expect(responseBodies[0].input.map((item: any) => item.role)).toEqual(["user"]);
    expect(responseBodies[1].input.map((item: any) => item.role)).toEqual(["user", "assistant", "user"]);

    const stopped = JSON.parse((await runCli(cliPath, home, bridgePort, ["stop", "--json"])).stdout);
    expect(stopped).toBeDefined();
    expect(await serverChild.exited).toBe(0);
  } finally {
    if (serverChild.exitCode === null) {
      serverChild.kill();
      await serverChild.exited.catch(() => undefined);
    }
    router.stop(true);
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
