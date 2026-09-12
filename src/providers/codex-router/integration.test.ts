import { afterEach, expect, test } from "bun:test";
import { generateId } from "../../core/ids";
import { SessionManager } from "../../core/session-manager";
import { closeDatabase, initDatabase } from "../../persistence/database";
import { MessageStore } from "../../persistence/message-store";
import { SessionStore } from "../../persistence/session-store";
import { TurnStore } from "../../persistence/turn-store";
import { ModelRouterConversationProvider, ProviderRegistry } from "../registry";
import { CodexRouterConversationProvider } from "./provider";

afterEach(() => closeDatabase());

test("bridge session history remains canonical across codex-router turns", async () => {
  initDatabase(":memory:");
  const responseBodies: any[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: "deepseek/deepseek-v4-pro" }] });
    }
    if (url.endsWith("/responses")) {
      const body = JSON.parse(String(init?.body));
      responseBodies.push(body);
      const turn = responseBodies.length;
      return Response.json({
        id: `resp_router_${turn}`,
        object: "response",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: `router answer ${turn}` }],
        }],
        usage: { input_tokens: body.input.length, output_tokens: 3, total_tokens: body.input.length + 3 },
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const concrete = new CodexRouterConversationProvider({
    baseUrl: "http://127.0.0.1:4202/_codex-router/test-capability/v1",
    fetchImpl,
  });
  const registry = new ProviderRegistry([concrete]);
  const modelRouter = new ModelRouterConversationProvider(registry);
  const manager = new SessionManager(
    new SessionStore(),
    new MessageStore(),
    new TurnStore(),
    { [modelRouter.name]: modelRouter, [concrete.name]: concrete },
  );

  const session = await manager.create({
    provider: modelRouter.name,
    model: "codex-router/deepseek/deepseek-v4-pro",
  });

  const first = await manager.send(session.id, {
    source: "internal",
    model: { provider: modelRouter.name, model: session.model },
    messages: [{
      id: generateId("msg"),
      role: "user",
      content: [{ type: "text", text: "first question" }],
      createdAt: new Date().toISOString(),
    }],
    stream: false,
  }, { emit: () => undefined });
  expect(first.status).toBe("completed");
  expect(first.text).toBe("router answer 1");
  expect(first.providerMetadata?.routedProvider).toBe("codex-router");

  const second = await manager.send(session.id, {
    source: "internal",
    model: { provider: modelRouter.name, model: session.model },
    messages: [{
      id: generateId("msg"),
      role: "user",
      content: [{ type: "text", text: "second question" }],
      createdAt: new Date().toISOString(),
    }],
    stream: false,
  }, { emit: () => undefined });
  expect(second.status).toBe("completed");
  expect(second.text).toBe("router answer 2");

  expect(responseBodies).toHaveLength(2);
  expect(responseBodies[0].input).toHaveLength(1);
  expect(responseBodies[1].input).toHaveLength(3);
  expect(responseBodies[1].input.map((item: any) => item.role)).toEqual([
    "user",
    "assistant",
    "user",
  ]);
  expect((await manager.transcript(session.id)).map(message => message.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
});
