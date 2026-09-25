export async function register() {
  // Next also compiles this file for the Edge runtime. Node-only code lives in instrumentation-node.ts behind this
  // check, which the Edge build removes (an early return is not removed and warns about process.pid).
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    registerNode();
  }
}
