import { noStoreHeaders } from "../../../../lib/control-api";
import { controlStore, resumeFixtureWorker } from "../../../../lib/control-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const store = controlStore();
    const view = await store.readLatestView();
    if (!view) {
      return Response.json({ error: { code: "NO_CONTROL_JOB", message: "No control job has been created" } }, {
        status: 404,
        headers: noStoreHeaders(),
      });
    }
    resumeFixtureWorker(store, view);
    return Response.json(view, { headers: noStoreHeaders() });
  } catch {
    return Response.json({ error: { code: "CONTROL_STORE_UNAVAILABLE", message: "The persisted control job could not be read" } }, {
      status: 500,
      headers: noStoreHeaders(),
    });
  }
}
