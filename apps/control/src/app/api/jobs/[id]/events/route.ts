import { EntityIdSchema, isTerminalRunState } from "@roveproof/contracts";
import { JobNotFoundError } from "@roveproof/store";
import { noStoreHeaders } from "../../../../../lib/control-api";
import { controlStore, resumeFixtureWorker } from "../../../../../lib/control-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const POLL_INTERVAL_MS = 200;
const KEEPALIVE_INTERVAL_MS = 15_000;

function parseSequence(value: string | null): number {
  if (value === null || value === "") return 0;
  if (!/^\d+$/.test(value)) throw new TypeError("Event sequence must be a non-negative integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError("Event sequence is too large");
  return parsed;
}

function sseEvent(sequence: number, data: unknown): Uint8Array {
  return encoder.encode(`id: ${sequence}\nevent: run-event\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const jobId = EntityIdSchema.parse((await params).id);
    const requestedAfter = parseSequence(new URL(request.url).searchParams.get("after"));
    const lastEventId = parseSequence(request.headers.get("last-event-id"));
    const store = controlStore();
    const initialView = await store.readView(jobId);
    resumeFixtureWorker(store, initialView);

    let stopped = false;
    let lastSequence = Math.max(requestedAfter, lastEventId);
    let lastKeepalive = Date.now();
    let wakeAbort: (() => void) | undefined;
    const stop = () => {
      stopped = true;
      wakeAbort?.();
    };
    request.signal.addEventListener("abort", stop, { once: true });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": roveproof fixture stream\n\n"));
        void (async () => {
          try {
            while (!stopped) {
              const events = await store.readEvents(jobId, lastSequence);
              for (const event of events) {
                if (stopped) break;
                controller.enqueue(sseEvent(event.sequence, event));
                lastSequence = event.sequence;
                if (isTerminalRunState(event.state)) {
                  stopped = true;
                  break;
                }
              }
              if (stopped) break;

              const job = await store.readJob(jobId);
              if (isTerminalRunState(job.state)) break;
              if (Date.now() - lastKeepalive >= KEEPALIVE_INTERVAL_MS) {
                controller.enqueue(encoder.encode(": keepalive\n\n"));
                lastKeepalive = Date.now();
              }
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, POLL_INTERVAL_MS);
                wakeAbort = () => {
                  clearTimeout(timer);
                  resolve();
                };
              });
              wakeAbort = undefined;
            }
            controller.close();
          } catch {
            if (!stopped) controller.error(new Error("Persisted event stream became unavailable"));
          } finally {
            request.signal.removeEventListener("abort", stop);
          }
        })();
      },
      cancel() {
        stop();
      },
    });

    return new Response(stream, {
      headers: noStoreHeaders({
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      }),
    });
  } catch (error) {
    const status = error instanceof JobNotFoundError ? 404 : 400;
    return Response.json({
      error: {
        code: status === 404 ? "CONTROL_JOB_NOT_FOUND" : "INVALID_EVENT_REQUEST",
        message: status === 404 ? "The control job was not found" : "The event stream request is invalid",
      },
    }, { status, headers: noStoreHeaders() });
  }
}
