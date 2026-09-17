import { expect, test } from "bun:test";
import { FakeConversationProvider } from "./fake/provider";
import type { BridgeTurnRequest } from "../core/domain";

test("FakeConversationProvider runs a turn and emits events", async () => {
  const provider = new FakeConversationProvider();
  
  const events: any[] = [];
  const req: BridgeTurnRequest = {
    requestId: "req_1",
    sessionId: "ses_1",
    source: "internal",
    model: { provider: "fake", model: "fake-model" },
    messages: [{ id: "m_1", role: "user", content: [{ type: "text", text: "Hello" }], createdAt: "" }],
    stream: false,
  };

  const result = await provider.runTurn(req, {
    emit: (event) => events.push(event),
  });

  expect(result.status).toBe("completed");
  expect(result.text).toBe("This is a fake response.");
  expect(events.length).toBe(3);
  expect(events[0].type).toBe("turn.started");
  expect(events[1].type).toBe("text.delta");
  expect(events[2].type).toBe("turn.completed");
});
