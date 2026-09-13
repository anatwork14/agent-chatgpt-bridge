import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

export type AcpPermissionMode = "deny" | "allow_readonly" | "delegate";

export type AcpPermissionResolver = (
  request: RequestPermissionRequest,
) => RequestPermissionResponse | Promise<RequestPermissionResponse>;

export interface AcpAuditEvent {
  eventType:
    | "agent.acp.started"
    | "agent.acp.initialized"
    | "agent.acp.session.created"
    | "agent.acp.prompt.started"
    | "agent.acp.prompt.completed"
    | "agent.acp.permission.requested"
    | "agent.acp.permission.resolved"
    | "agent.acp.cancelled"
    | "agent.acp.closed"
    | "agent.acp.failed";
  runId?: string;
  payload?: Record<string, unknown>;
}

export interface AcpAgentAdapterOptions {
  cwd?: string;
  timeoutMs?: number;
  cancelGraceMs?: number;
  closeTimeoutMs?: number;
  maxProtocolBytes?: number;
  env?: Record<string, string>;
  permissionMode?: AcpPermissionMode;
  permissionResolver?: AcpPermissionResolver;
  audit?: (event: AcpAuditEvent) => void;
}

export interface AcpAgentProfile {
  id: string;
  command: string[];
  authMode: "preauthenticated";
  options?: AcpAgentAdapterOptions;
}
