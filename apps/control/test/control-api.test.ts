import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { isTerminalRunState, type ControlJobView } from "@roveproof/contracts";
import { createGoldenFixtureSnapshot } from "@roveproof/orchestrator";
import { controlStore } from "../src/lib/control-server.js";
import { POST } from "../src/app/api/jobs/route.js";
import { GET as getJob } from "../src/app/api/jobs/[id]/route.js";
import { GET as getEvents } from "../src/app/api/jobs/[id]/events/route.js";
import { GET as getLatest } from "../src/app/api/jobs/latest/route.js";

const roots: string[] = [];
const originalRoot = process.env.ROVEPROOF_REPOSITORY_ROOT;

function postRequest(key = "fixture:api-test-0001", body: unknown = { schemaVersion: 1, mode: "fixture" }, origin = "http://localhost:3000") {
  return new Request("http://localhost:3000/api/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function waitForTerminal(jobId: string): Promise<ControlJobView> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const view = await controlStore().readView(jobId);
    if (isTerminalRunState(view.job.state) && view.snapshot.completion.status === "REHEARSAL_COMPLETE") return view;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("Fixture API worker did not reach its terminal state");
}

beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "roveproof-control-api-"));
  roots.push(root);
  process.env.ROVEPROOF_REPOSITORY_ROOT = root;
});

afterAll(async () => {
  if (originalRoot === undefined) delete process.env.ROVEPROOF_REPOSITORY_ROOT;
  else process.env.ROVEPROOF_REPOSITORY_ROOT = originalRoot;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe.sequential("control job API", () => {
  it("requires a matching origin, idempotency key, and strict fixture body", async () => {
    expect((await POST(postRequest("fixture:api-test-0001", undefined, ""))).status).toBe(403);
    expect((await POST(postRequest("fixture:api-test-0001", undefined, "https://attacker.invalid"))).status).toBe(403);
    expect((await POST(new Request("http://public.example/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "fixture:api-public", Origin: "http://public.example" },
      body: JSON.stringify({ schemaVersion: 1, mode: "fixture" }),
    }))).status).toBe(403);
    expect((await POST(postRequest("bad", { schemaVersion: 1, mode: "fixture" }))).status).toBe(400);
    expect((await POST(postRequest("fixture:api-test-large", { padding: "x".repeat(2_000) }))).status).toBe(413);
    expect((await POST(postRequest("fixture:api-test-0002", { schemaVersion: 1, mode: "real" }))).status).toBe(400);
    expect((await POST(postRequest("fixture:api-test-0003", { schemaVersion: 1, mode: "fixture", targetUrl: "https://example.test" }))).status).toBe(400);
  });

  it("creates, persists, reads, and idempotently replays one fixture job", async () => {
    const createdResponse = await POST(postRequest());
    expect(createdResponse.status).toBe(202);
    expect(createdResponse.headers.get("cache-control")).toBe("no-store");
    const created = await createdResponse.json() as ControlJobView;
    const terminal = await waitForTerminal(created.job.jobId);
    expect(terminal.job.state).toBe("INCONCLUSIVE");

    const replayResponse = await POST(postRequest());
    expect(replayResponse.status).toBe(200);
    expect((await replayResponse.json() as ControlJobView).job.jobId).toBe(created.job.jobId);

    const latestResponse = await getLatest();
    expect(latestResponse.status).toBe(200);
    expect((await latestResponse.json() as ControlJobView).job.jobId).toBe(created.job.jobId);

    const readResponse = await getJob(new Request(`http://localhost:3000/api/jobs/${created.job.jobId}`), {
      params: Promise.resolve({ id: created.job.jobId }),
    });
    expect(readResponse.status).toBe(200);
  }, 15_000);

  it("returns conflict for a second key while the worker is active", async () => {
    const created = await POST(postRequest("fixture:api-active-01"));
    const view = await created.json() as ControlJobView;
    const conflict = await POST(postRequest("fixture:api-active-02"));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "JOB_ALREADY_ACTIVE", jobId: view.job.jobId } });
    await waitForTerminal(view.job.jobId);
  }, 15_000);

  it("replays ordered persisted events over SSE and validates cursors", async () => {
    const created = await POST(postRequest("fixture:api-events-01"));
    const view = await created.json() as ControlJobView;
    await waitForTerminal(view.job.jobId);

    const response = await getEvents(new Request(`http://localhost:3000/api/jobs/${view.job.jobId}/events`, {
      headers: { "Last-Event-ID": "8" },
    }), { params: Promise.resolve({ id: view.job.jobId }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
    const stream = await response.text();
    expect(stream).toContain("id: 9");
    expect(stream).toContain("id: 10");
    expect(stream).not.toContain("id: 8\n");
    expect(stream).toContain('"state":"INCONCLUSIVE"');

    const invalid = await getEvents(new Request(`http://localhost:3000/api/jobs/${view.job.jobId}/events?after=nan`), {
      params: Promise.resolve({ id: view.job.jobId }),
    });
    expect(invalid.status).toBe(400);
  }, 15_000);

  it("resumes a persisted active job through GET after a dead worker owner", async () => {
    const store = controlStore();
    const created = await store.createFixtureJob({
      idempotencyKey: "fixture:api-resume-01",
      jobId: "job-api-resume",
      runId: "run-api-resume",
      snapshot: createGoldenFixtureSnapshot,
    });
    const leasePath = path.join(process.env.ROVEPROOF_REPOSITORY_ROOT!, "var", "roveproof", "leases", "fixture-worker.lock");
    await writeFile(leasePath, JSON.stringify({
      pid: 999_999_999,
      ownerToken: "00000000-0000-4000-8000-000000000000",
      createdAt: "2026-07-18T03:00:00.000Z",
    }) + "\n", "utf8");

    const response = await getJob(new Request("http://localhost:3000/api/jobs/job-api-resume"), {
      params: Promise.resolve({ id: created.view.job.jobId }),
    });
    expect(response.status).toBe(200);
    expect((await waitForTerminal(created.view.job.jobId)).job.state).toBe("INCONCLUSIVE");
  }, 15_000);

  it("refuses to stream a schema-valid fixture APPROVED event corruption", async () => {
    const store = controlStore();
    const created = await store.createFixtureJob({
      idempotencyKey: "fixture:api-corrupt-01",
      jobId: "job-api-corrupt",
      runId: "run-api-corrupt",
      snapshot: createGoldenFixtureSnapshot,
    });
    const [initial] = created.view.events;
    const eventPath = path.join(process.env.ROVEPROOF_REPOSITORY_ROOT!, "var", "roveproof", "events", "job-api-corrupt.jsonl");
    await writeFile(eventPath, [
      initial,
      { ...initial, sequence: 2, state: "APPROVED", occurredAt: "2026-07-18T03:00:01.000Z" },
      { ...initial, sequence: 3, state: "INCONCLUSIVE", occurredAt: "2026-07-18T03:00:02.000Z" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");

    const response = await getEvents(new Request("http://localhost:3000/api/jobs/job-api-corrupt/events"), {
      params: Promise.resolve({ id: "job-api-corrupt" }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("APPROVED");
  });

  it("rejects arbitrary job paths", async () => {
    const response = await getJob(new Request("http://localhost:3000/api/jobs/bad"), {
      params: Promise.resolve({ id: "../../outside" }),
    });
    expect(response.status).toBe(400);
  });
});
