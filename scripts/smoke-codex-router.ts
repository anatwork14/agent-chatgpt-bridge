import { randomUUID } from "node:crypto";
import { BridgeError } from "../src/core/errors";
import {
  CodexRouterConversationProvider,
  codexRouterProviderOptionsFromEnv,
} from "../src/providers/codex-router/provider";

const options = codexRouterProviderOptionsFromEnv();
if (!options) {
  throw new BridgeError(
    "invalid_request",
    "AGENT_CHATGPT_CODEX_ROUTER_BASE_URL is required for the live codex-router smoke",
    false,
  );
}

const provider = new CodexRouterConversationProvider(options);
const capabilities = await provider.capabilities();
if (capabilities.models.length === 0) {
  throw new BridgeError(
    "model_unavailable",
    "Codex Router returned no models for the live smoke",
    false,
  );
}

const requestedModel = process.env.AGENT_CHATGPT_CODEX_ROUTER_SMOKE_MODEL?.trim();
const model = requestedModel || capabilities.models[0]!;
if (!capabilities.models.includes(model)) {
  throw new BridgeError(
    "model_unavailable",
    `Requested smoke model is not exposed by Codex Router: ${model}`,
    false,
  );
}

const suffix = randomUUID().replaceAll("-", "");
const requestId = `turn_router_smoke_${suffix}`;
const sessionId = `session_router_smoke_${suffix}`;
const result = await provider.runTurn(
  {
    requestId,
    sessionId,
    source: "internal",
    model: { provider: provider.name, model },
    messages: [{
      id: `msg_router_smoke_${suffix}`,
      role: "user",
      content: [{
        type: "text",
        text: "This is a transport smoke test. Reply with a short acknowledgement.",
      }],
      createdAt: new Date().toISOString(),
    }],
    stream: true,
  },
  { emit: () => undefined },
);

if (result.status !== "completed") {
  throw new BridgeError(
    result.error?.code || "provider_failed",
    result.error?.message || `Codex Router smoke ended with status ${result.status}`,
    result.error?.retryable ?? false,
  );
}
if (!result.text.trim()) {
  throw new BridgeError(
    "provider_protocol_invalid",
    "Codex Router smoke completed without assistant text",
    false,
  );
}

const usage = result.usage
  ? ` input=${result.usage.inputTokens ?? "?"} output=${result.usage.outputTokens ?? "?"}`
  : "";
process.stdout.write(`CODEX_ROUTER_SMOKE_OK model=${model} chars=${result.text.length}${usage}\n`);
