export interface BridgeErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
  requestId?: string;
}

export class BridgeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean = false,
    public readonly requestId?: string
  ) {
    super(message);
    this.name = "BridgeError";
  }

  toJSON(): { error: BridgeErrorPayload } {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        requestId: this.requestId,
      },
    };
  }
}
