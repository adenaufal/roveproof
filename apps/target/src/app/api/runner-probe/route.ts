export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const RUNNER_PROBE_BYTES = 450_000 as const;
const RUNNER_PROBE_BODY = "r".repeat(RUNNER_PROBE_BYTES);

/** Fixed-size, identity-encoded response used only to verify the scored network profile. */
export function GET(): Response {
  return new Response(RUNNER_PROBE_BODY, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Encoding": "identity",
      "Content-Length": String(RUNNER_PROBE_BYTES),
      "Content-Type": "text/plain; charset=utf-8",
      "X-Roveproof-Runner-Probe": "network-v1",
    },
  });
}
