/*
 * Logs every ffmpeg / ffprobe / swift child process the server spawns (`proc_done` / `proc_failed`: tool, operation,
 * exit code, durationMs, output file, stderr tail on failure) by wrapping child_process.spawn once at startup
 * (instrumentation.ts). Call sites stay unchanged; the log line carries the trace of the request that spawned it.
 */
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { currentTrace, log, runInTrace } from "@/lib/runtime-log";

const TOOLS = /^(ffmpeg|ffprobe|swift|swiftc)$/;
const STDERR_TAIL = 400;
type Spawn = typeof childProcess.spawn;

/** A short name for what an ffmpeg command line does (frame grab, concat, xfade, psnr…). */
export function ffmpegOperation(tool: string, args: readonly string[]) {
  if (tool === "ffprobe") return "probe";
  if (tool.startsWith("swift")) return `swift:${path.basename(args.find((arg) => arg.endsWith(".swift")) ?? "script")}`;
  const joined = args.join(" ");
  if (/\bpsnr\b/.test(joined)) return "psnr";
  if (/-f concat\b|concat=/.test(joined)) return "concat";
  if (/xfade/.test(joined)) return "xfade";
  if (/-frames:v 1\b|-vframes 1\b/.test(joined)) return "frame_grab";
  if (/-loop 1\b/.test(joined)) return "still_to_video";
  if (/overlay/.test(joined)) return "overlay";
  if (/-t \S+/.test(joined) && /-ss /.test(joined)) return "trim";
  if (/-filter_complex|-lavfi|-vf /.test(joined)) return "filter";
  return "transcode";
}

function outputOf(args: readonly string[]) {
  const last = args[args.length - 1];
  return last && !last.startsWith("-") && last !== "-" ? path.basename(last) : undefined;
}

export function installProcessLogging() {
  const flag = globalThis as { __longformSpawnPatched?: boolean };
  if (flag.__longformSpawnPatched) return;
  flag.__longformSpawnPatched = true;
  const original: Spawn = childProcess.spawn;
  const patched = function spawn(this: unknown, command: string, ...rest: unknown[]) {
    const child = (original as (...args: unknown[]) => ReturnType<Spawn>).call(this, command, ...rest);
    try {
      const tool = path.basename(String(command));
      if (!TOOLS.test(tool)) return child;
      const args = (Array.isArray(rest[0]) ? rest[0] : []).map(String);
      const trace = currentTrace();
      const startedAt = Date.now();
      const operation = ffmpegOperation(tool, args);
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4_000);
      });
      child.once("error", (error) => runInTrace(trace, () => log("warn", "proc_failed", { tool, operation, error: error.message, durationMs: Date.now() - startedAt })));
      child.once("close", (code, signal) => runInTrace(trace, () => {
        const failed = code !== 0;
        log(failed ? "warn" : "debug", failed ? "proc_failed" : "proc_done", {
          tool,
          operation,
          exitCode: code,
          signal: signal ?? undefined,
          output: outputOf(args),
          args: args.length,
          stderr: failed ? stderr.trim().split("\n").slice(-4).join(" | ").slice(-STDERR_TAIL) : undefined,
          durationMs: Date.now() - startedAt,
        });
      }));
    } catch {
      // Never break the spawn itself.
    }
    return child;
  } as unknown as Spawn;
  childProcess.spawn = patched;
  try {
    syncBuiltinESMExports();
  } catch {
    // Older runtimes: the CommonJS export is enough for bundled code.
  }
}
