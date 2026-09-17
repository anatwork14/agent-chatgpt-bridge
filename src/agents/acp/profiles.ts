import type { AcpAgentProfile } from "./types";

export type { AcpAgentProfile } from "./types";

export const ACP_AGENT_PROFILES: Readonly<Record<"cursor" | "gemini" | "claude" | "antigravity", AcpAgentProfile>> = {
  cursor: {
    id: "cursor",
    command: ["agent", "acp"],
    authMode: "preauthenticated",
  },
  gemini: {
    id: "gemini",
    command: ["gemini", "--acp"],
    authMode: "preauthenticated",
  },
  claude: {
    id: "claude",
    command: ["claude-agent-acp"],
    authMode: "preauthenticated",
  },
  antigravity: {
    id: "antigravity",
    command: ["agy-acp"],
    authMode: "preauthenticated",
  },
};

export function customAcpProfile(
  command: string[],
  options?: AcpAgentProfile["options"],
): AcpAgentProfile {
  return {
    id: "custom",
    command: [...command],
    authMode: "preauthenticated",
    options,
  };
}

export function resolveAcpProfile(
  profileId: string,
  command?: string[],
  options?: AcpAgentProfile["options"],
): AcpAgentProfile {
  if (command) return customAcpProfile(command, options);
  const profile = ACP_AGENT_PROFILES[profileId as keyof typeof ACP_AGENT_PROFILES];
  if (!profile) throw new Error(`Unknown ACP agent profile: ${profileId}`);
  return {
    ...profile,
    command: [...profile.command],
    options: { ...profile.options, ...options },
  };
}
