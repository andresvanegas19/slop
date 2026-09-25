import { logInfo } from "@/lib/runtime-log";

export async function register() {
  logInfo("application_started", {
    runtime: process.env.NEXT_RUNTIME ?? "nodejs",
    bflConfigured: Boolean(process.env.BFL_API_KEY),
  });
}
