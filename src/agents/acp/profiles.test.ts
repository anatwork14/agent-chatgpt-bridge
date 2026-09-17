import { expect, test } from "bun:test";
import { ACP_AGENT_PROFILES, customAcpProfile, resolveAcpProfile } from "./profiles";

test("ACP built-in profiles are launch data for Cursor, Gemini, Claude, and Antigravity", () => {
  expect(ACP_AGENT_PROFILES.cursor.command).toEqual(["agent", "acp"]);
  expect(ACP_AGENT_PROFILES.gemini.command).toEqual(["gemini", "--acp"]);
  expect(ACP_AGENT_PROFILES.claude.command).toEqual(["claude-agent-acp"]);
  expect(ACP_AGENT_PROFILES.antigravity.command).toEqual(["agy-acp"]);
  expect(ACP_AGENT_PROFILES.cursor.authMode).toBe("preauthenticated");
  expect(ACP_AGENT_PROFILES.antigravity.authMode).toBe("preauthenticated");
});

test("ACP profile resolution supports custom commands without protocol subclasses", () => {
  const command = ["my-agent", "--acp"];
  const custom = customAcpProfile(command);
  command.push("--caller-should-not-mutate-profile");
  expect(custom.id).toBe("custom");
  expect(custom.command).toEqual(["my-agent", "--acp"]);
  expect(resolveAcpProfile("cursor").command).toEqual(["agent", "acp"]);
  expect(resolveAcpProfile("antigravity").command).toEqual(["agy-acp"]);
  expect(() => resolveAcpProfile("custom")).toThrow("Unknown ACP agent profile");
});
