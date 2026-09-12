import { afterEach, expect, test } from "bun:test";
import { SessionManager } from "../../core/session-manager";
import { closeDatabase, initDatabase } from "../../persistence/database";
import { MessageStore } from "../../persistence/message-store";
import { SessionStore } from "../../persistence/session-store";
import { TurnStore } from "../../persistence/turn-store";
import { FakeConversationProvider } from "../../providers/fake/provider";
import { createResponsesApi } from "./routes";

afterEach(() => {
  closeDatabase();
});

function fixture(token?: string) {
  initDatabase(":memory:");
  const provider = new FakeConversationProvider();
  const turnStore = new TurnStore();
  const sm = new SessionManager(
    new SessionStore(),
    new MessageStore(),
    turnStore,
    { fake: provider },
  );
  return {
    sm,
    app: createResponsesApi(sm, {
      apiToken: token,
      defaultProvider: "fake",
      defaultModel: "fake-model",
      listModels: async () => (await provider.capabilities()).models,
      turnStore,
    }),
  };
}

async function post(app: ReturnType<typeof createResponsesApi>, body: Record<string, unknown>, token?: string) {
  return app.request("/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

test("Responses API exposes an OpenAI-style model catalog", async () => {
  const { app } = fixture();
  const response = await app.request("/v1/models");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    object: "list",
    data: [{
      id: "fake-model",
      object: "model",
      created: 0,
      owned_by: "agent-chatgpt-bridge",
    }],
  });
});

test("Responses API creates a response and continues via previous_response_id", async () => {
  const { app, sm } = fixture();
  const first = await post(app, { model: "fake-model", input: "Remember 8427." });
  expect(first.status).toBe(200);
  const firstBody = await first.json() as any;
  expect(firstBody.object).toBe("response");
  expect(firstBody.status).toBe("completed");
  expect(firstBody.id).toMatch(/^resp_turn_/);
  expect(firstBody.output[0].content[0].type).toBe("output_text");
  expect(firstBody.output[0].content[0].text).toBe("This is a fake response.");

  const second = await post(app, {
    model: "fake-model",
    previous_response_id: firstBody.id,
    input: [{ role: "user", content: [{ type: "input_text", text: "What number?" }] }],
  });
  expect(second.status).toBe(200);
  const secondBody = await second.json() as any;
  expect(secondBody.previous_response_id).toBe(firstBody.id);
  expect(secondBody.id).not.toBe(firstBody.id);

  const sessions = await sm.list();
  expect(sessions).toHaveLength(1);
  expect(await sm.transcript(sessions[0]!.id)).toHaveLength(4);
});

test("Responses API emits official text streaming events", async () => {
  const { app } = fixture();
  const response = await post(app, {
    model: "fake-model",
    input: "Stream this.",
    stream: true,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const text = await response.text();
  expect(text).toContain("event: response.created");
  expect(text).toContain("event: response.output_item.added");
  expect(text).toContain("event: response.output_text.delta");
  expect(text).toContain("This is a fake response.");
  expect(text).toContain("event: response.completed");
  expect(text).toContain("data: [DONE]");
});

test("Responses API fails closed on an unknown previous_response_id", async () => {
  const { app } = fixture();
  const response = await post(app, {
    model: "fake-model",
    previous_response_id: "resp_turn_00000000000000000000000000000000",
    input: "continue",
  });
  expect(response.status).toBe(400);
  expect((await response.json() as any).error.code).toBe("invalid_request");
});

test("Responses API enforces local bearer authentication", async () => {
  const { app } = fixture("responses-secret");
  const denied = await post(app, { model: "fake-model", input: "hello" });
  expect(denied.status).toBe(401);

  const deniedModels = await app.request("/v1/models");
  expect(deniedModels.status).toBe(401);

  const allowed = await post(app, { model: "fake-model", input: "hello" }, "responses-secret");
  expect(allowed.status).toBe(200);
});

test("Responses API treats instructions as turn-scoped while accepting JSON schema output", async () => {
  const { app, sm } = fixture();
  const response = await post(app, {
    model: "fake-model",
    instructions: "Return structured output.",
    input: "hello",
    text: {
      format: {
        type: "json_schema",
        name: "answer",
        schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
      },
    },
  });
  expect(response.status).toBe(200);
  const sessions = await sm.list();
  const transcript = await sm.transcript(sessions[0]!.id);
  expect(transcript.map(message => message.role)).toEqual(["user", "assistant"]);
  expect(transcript.some(message => message.content.some(part => part.type === "text" && part.text.includes("structured output"))))
    .toBe(false);
});

test("Responses API rejects unsupported tool execution rather than ignoring it", async () => {
  const { app } = fixture();
  const response = await post(app, {
    model: "fake-model",
    input: "hello",
    tools: [{ type: "function", name: "dangerous" }],
  });
  expect(response.status).toBe(400);
  expect((await response.json() as any).error.message).toContain("tool calling is not enabled");
});
