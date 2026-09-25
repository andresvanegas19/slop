import { installProcessLogging } from "@/lib/process-log";
import { logInfo, logsDirectory } from "@/lib/runtime-log";

/** Node.js-only startup (loaded by instrumentation.ts): process logging and the `application_started` line. */
export function registerNode() {
  installProcessLogging();
  logInfo("application_started", {
    runtime: process.env.NEXT_RUNTIME ?? "nodejs",
    bflConfigured: Boolean(process.env.BFL_API_KEY),
    logLevel: process.env.LOG_LEVEL ?? "info",
    logDir: logsDirectory(),
    pid: process.pid,
  });
}
