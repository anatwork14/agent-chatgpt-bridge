import { expect, test } from "bun:test";
import { defaultConfig, providerConfig } from "../../config";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptTurnSessions } from "../../adapters/chatgpt-web/turn-execution";
import { ChatGPTWebConversationProvider } from "./provider";

test("ChatGPT bridge cancellation retires only the exact native session and turn", async () => {
  chatGptTurnSessions.clear();
  const cancelled: string[] = [];
  const runtime = (label: string) => {
    let rejectBrowser!: (error: Error) => void;
    const browser = new Promise<string>((_resolve, reject) => { rejectBrowser = reject; });
    return {
      mode: "read-only" as const,
      browser,
      physicalSettlement: browser.then(() => undefined, () => undefined),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: (reason?: Error) => {
        cancelled.push(label);
        rejectBrowser(reason ?? new Error("cancelled"));
      },
    };
  };
  chatGptTurnSessions.getOrCreate(
    "bridge-execution-1",
    () => runtime("target"),
    "trace-target",
    "owner-target",
    "bridge-turn-1",
    "bridge-session-1",
  );
  chatGptTurnSessions.getOrCreate(
    "bridge-execution-2",
    () => runtime("other"),
    "trace-other",
    "owner-other",
    "bridge-turn-2",
    "bridge-session-2",
  );

  const provider = new ChatGPTWebConversationProvider(providerConfig(defaultConfig()));
  await provider.cancelTurn!("bridge-session-1", "bridge-turn-1");

  expect(cancelled).toEqual(["target"]);
  expect(chatGptTurnSessions.find("bridge-execution-1")).toBeUndefined();
  expect(chatGptTurnSessions.find("bridge-execution-2")).toBeDefined();
  chatGptTurnSessions.clear();
});
