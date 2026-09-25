export async function register() {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ logInfo, logsDirectory }, { installProcessLogging }] = await Promise.all([import("@/lib/runtime-log"), import("@/lib/process-log")]);
  installProcessLogging();
  logInfo("application_started", {
    runtime: process.env.NEXT_RUNTIME ?? "nodejs",
    bflConfigured: Boolean(process.env.BFL_API_KEY),
    logLevel: process.env.LOG_LEVEL ?? "info",
    logDir: logsDirectory(),
    pid: process.pid,
  });
}
