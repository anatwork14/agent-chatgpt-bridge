import { expect, test } from "bun:test";
import { codexParsedRequestToBridgeTurnRequest } from "./conversion";
import type { CodexParsedRequest } from "../../types";

test("codexParsedRequestToBridgeTurnRequest converts correctly", () => {
  const req: CodexParsedRequest = {
    modelId: "gpt-4",
    context: {
      systemPrompt: ["You are a helpful assistant"],
      messages: [
        {
          role: "user",
          content: "Hello",
          timestamp: 1600000000000,
        },
      ],
      tools: [
        {
          name: "weather",
          description: "Get weather",
          inputSchema: { type: "object" },
        },
      ],
    },
    stream: true,
    options: {},
  };

  const bridge = codexParsedRequestToBridgeTurnRequest(req, "req_1", "ses_1");

  expect(bridge.requestId).toBe("req_1");
  expect(bridge.sessionId).toBe("ses_1");
  expect(bridge.model.model).toBe("gpt-4");
  expect(bridge.stream).toBe(true);
  expect(bridge.messages.length).toBe(2);
  expect(bridge.messages[0].role).toBe("system");
  expect(bridge.messages[1].role).toBe("user");
  expect(bridge.tools?.length).toBe(1);
  expect(bridge.tools?.[0].name).toBe("weather");
});
