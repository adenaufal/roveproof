import { EntityIdSchema } from "@roveproof/contracts";
import { JobNotFoundError } from "@roveproof/store";
import { noStoreHeaders } from "../../../../lib/control-api";
import { controlStore, resumeFixtureWorker } from "../../../../lib/control-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const jobId = EntityIdSchema.parse((await params).id);
    const store = controlStore();
    const view = await store.readView(jobId);
    resumeFixtureWorker(store, view);
    return Response.json(view, { headers: noStoreHeaders() });
  } catch (error) {
    const status = error instanceof JobNotFoundError ? 404 : 400;
    return Response.json({
      error: {
        code: status === 404 ? "CONTROL_JOB_NOT_FOUND" : "INVALID_JOB_ID",
        message: status === 404 ? "The control job was not found" : "The control job ID is invalid",
      },
    }, { status, headers: noStoreHeaders() });
  }
}
