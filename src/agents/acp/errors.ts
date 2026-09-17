import { BridgeError } from "../../core/errors";

export class AcpProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpProcessError";
  }
}

export function acpError(
  code: BridgeError["code"],
  message: string,
): BridgeError {
  return new BridgeError(code, message, false);
}

export function mapAcpError(error: unknown, phase: "initialize" | "prompt" | "close"): BridgeError {
  if (error instanceof BridgeError) return error;
  if (error instanceof AcpProcessError) {
    return acpError("agent_adapter_failed", "The ACP agent process exited unexpectedly");
  }
  if (phase === "prompt" && error instanceof Error && /permission/i.test(error.message)) {
    return acpError("agent_permission_denied", "The ACP agent permission interaction was denied");
  }
  if (phase === "close") return acpError("agent_adapter_failed", "The ACP agent failed during shutdown");
  return acpError(
    phase === "initialize" ? "agent_protocol_invalid" : "agent_adapter_failed",
    phase === "initialize" ? "The ACP agent failed protocol initialization" : "The ACP agent turn failed",
  );
}
