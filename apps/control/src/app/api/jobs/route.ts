import {
  ControlIdempotencyKeySchema,
  ControlJobCreateSchema,
} from "@roveproof/contracts";
import { createGoldenFixtureSnapshot, launchFixtureWorker } from "@roveproof/orchestrator";
import { ActiveJobConflictError, StoreBusyError } from "@roveproof/store";
import {
  apiErrorResponse,
  ControlApiError,
  noStoreHeaders,
  readBoundedJson,
  requireSameOrigin,
} from "../../../lib/control-api";
import { controlStore } from "../../../lib/control-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);
    const idempotencyKey = ControlIdempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
    if (!idempotencyKey.success) {
      throw new ControlApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required");
    }
    ControlJobCreateSchema.parse(await readBoundedJson(request));

    const store = controlStore();
    const result = await store.createFixtureJob({
      idempotencyKey: idempotencyKey.data,
      snapshot: createGoldenFixtureSnapshot,
    });
    launchFixtureWorker({ store, jobId: result.view.job.jobId });

    return Response.json(result.view, {
      status: result.created ? 202 : 200,
      headers: noStoreHeaders({ Location: `/api/jobs/${result.view.job.jobId}` }),
    });
  } catch (error) {
    if (error instanceof ActiveJobConflictError) {
      return Response.json({
        error: {
          code: "JOB_ALREADY_ACTIVE",
          message: "Only one fixture rehearsal can run at a time",
          jobId: error.jobId,
        },
      }, { status: 409, headers: noStoreHeaders() });
    }
    if (error instanceof StoreBusyError) {
      return apiErrorResponse(new ControlApiError(409, "STORE_BUSY", "The fixture control store is busy"));
    }
    return apiErrorResponse(error);
  }
}
