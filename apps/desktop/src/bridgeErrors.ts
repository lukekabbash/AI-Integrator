export function formatBridgeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown };
    const message = typeof value.message === "string" ? value.message.trim() : "";
    const code = typeof value.code === "string" ? value.code.trim() : "";
    if (message && code) return `${message} (${code})`;
    if (message) return message;
  }
  return fallback;
}

export function isMissingCodexThreadError(error: unknown): boolean {
  const message = formatBridgeError(error, "").toLowerCase();
  return (
    message.includes("no rollout found for thread id") ||
    message.includes("no longer the active resumable session") ||
    /(?:thread|rollout).*(?:not found|does not exist|unknown)/i.test(message)
  );
}

export function isStaleProviderResumeError(error: unknown): boolean {
  const message = formatBridgeError(error, "").toLowerCase();
  return (
    message.includes("no saved provider session") ||
    message.includes("predates the current mcp configuration") ||
    message.includes("no longer the active resumable session") ||
    message.includes("does not match this task and workspace")
  );
}

export function isCodexConnectionError(error: unknown): boolean {
  const message = formatBridgeError(error, "").toLowerCase();
  return /provider-disconnected|transport (?:closed|failed)|broken pipe|app-server.*(?:closed|exited)/i.test(
    message,
  );
}

export function isAcpConnectionError(error: unknown): boolean {
  const message = formatBridgeError(error, "").toLowerCase();
  return (
    message.includes("provider-disconnected") ||
    /transport (?:closed|failed)|broken pipe|acp agent (?:exited|disconnected|stopped reading)/i.test(
      message,
    )
  );
}

export function isDefinitivePreSubmitDisconnect(error: unknown): boolean {
  return formatBridgeError(error, "").toLowerCase().includes("provider-disconnected");
}
