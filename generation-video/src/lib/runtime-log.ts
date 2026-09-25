type LogValue = string | number | boolean | undefined;

function write(level: "INFO" | "ERROR", event: string, details: Record<string, LogValue> = {}) {
  const fields = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  console[level === "ERROR" ? "error" : "info"](`[longform] ${level} event=${event}${fields ? ` ${fields}` : ""}`);
}

export function logInfo(event: string, details?: Record<string, LogValue>) {
  write("INFO", event, details);
}

export function logError(event: string, details?: Record<string, LogValue>) {
  write("ERROR", event, details);
}

// Prints the one-line event plus the full error object (stack trace and `cause` chain) to the server terminal.
export function logException(event: string, error: unknown, details?: Record<string, LogValue>) {
  write("ERROR", event, details);
  console.error(error);
}
