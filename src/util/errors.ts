export type ErrorCode =
  | "not_found"
  | "invalid_input"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "bundle_unavailable"
  | "internal";

export class ToolError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ToolError";
  }
}
