import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { M5_TEST_COMMAND_ARGV_DIGEST } from "@roveproof/contracts";
import { runRepairLoop } from "../src/index.js";

const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object" ? `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value);
const snapshotWithoutHash = {
  schemaVersion: 1 as const,
  recordVersion: "source-snapshot-v1" as const,
  sourceRevision: `sha256:${"a".repeat(64)}`,
  projectionRevision: "e".repeat(64),
  toolingRevision: "e".repeat(64),
  toolingFiles: [{ path: "apps/target/test/repair-mononym.test.mjs", size: 1, sha256: "e".repeat(64) }],
  baselineRunId: "run-repair-order",
  expectedIndexHash: "b".repeat(64),
  expectedRootHash: "c".repeat(64),
  analysisId: "analysis-repair-order",
  expectedAnalysisHash: "d".repeat(64),
  files: [{ path: "apps/target/test/repair-mononym.test.mjs", size: 1, sha256: "e".repeat(64) }],
};
const snapshot = { ...snapshotWithoutHash, snapshotHash: createHash("sha256").update(canonical(snapshotWithoutHash)).digest("hex") };
const proofBase = {

  schemaVersion: 1 as const,
  recordVersion: "test-failure-proof-v1" as const,
  baselineRunId: "run-repair-order",
  sourceSnapshotHash: "f".repeat(64),
  testDiffHash: "1".repeat(64),
  sourceRevision: `sha256:${"a".repeat(64)}`,
  toolingRevision: "e".repeat(64),
  commandId: "test-regression" as const,
  argvDigest: M5_TEST_COMMAND_ARGV_DIGEST,
  controlHash: "3".repeat(64),
  sandboxResultHash: "4".repeat(64),
  sandboxEvidenceHash: "5".repeat(64),
  exitCode: 1 as const,
  signal: null,
  classification: "EXPECTED_FAILURE" as const,
  expectedSeedId: "ID-MONONYM-REQUIRED-LAST-NAME" as const,
  assertionId: "seed.mononym-required-last-name" as const,
  assertionFragment: "required last name" as const,
  observedFailureHash: "6".repeat(64),
};
const proof = { ...proofBase, proofHash: createHash("sha256").update(canonical(proofBase)).digest("hex") };

function deps(events: string[], sourceCalls: { count: number }) {
  return {
    baselineRunId: "run-repair-order",
    admit: async () => { events.push("admission"); },
    snapshot: async () => { events.push("snapshot"); return snapshot; },
    preflight: async () => { events.push("preflight"); },
    authorTest: async () => { events.push("author-test"); return { attempt: { ok: true }, diff: { ok: true } }; },
    persistTestAttempt: async () => { events.push("persist-test-attempt"); },
    testPolicy: async () => { events.push("test-policy"); return { ok: true }; },
    runTestSandbox: async () => { events.push("test-sandbox"); return { ok: true }; },
    makeProof: async () => { events.push("make-proof"); return proof; },
    persistProof: async () => { events.push("persist-proof"); },
    readProof: async () => { events.push("read-proof"); return proof; },
    authorSource: async () => { sourceCalls.count += 1; events.push("author-source"); return { attempt: { ok: true } }; },
    persistSourceAttempt: async () => { events.push("persist-source-attempt"); },
    sourcePolicy: async () => { events.push("source-policy"); return { ok: true }; },
    runCombinedSandbox: async () => { events.push("combined"); return { ok: true }; },
    publish: async () => { events.push("publish"); return {} as never; },
    cleanup: async () => { events.push("cleanup"); },
  };
}

describe("M5 repair ordering seam", () => {
  it("does not call source author before proof persistence and read-back", async () => {
    const events: string[] = [];
    const sourceCalls = { count: 0 };
    const result = await runRepairLoop(deps(events, sourceCalls));
    expect(result.outcome).toBe("INCONCLUSIVE");
    expect(sourceCalls.count).toBe(1);
    expect(events.indexOf("read-proof")).toBeLessThan(events.indexOf("author-source"));
  });

  it("stops all downstream authoring and candidate calls when preflight fails", async () => {
    const events: string[] = [];
    const sourceCalls = { count: 0 };
    const value = deps(events, sourceCalls);
    value.preflight = async () => { events.push("preflight"); throw new Error("preflight unavailable"); };
    const result = await runRepairLoop(value);
    expect(result.outcome).toBe("INCONCLUSIVE");
    expect(sourceCalls.count).toBe(0);
    expect(events).not.toContain("author-test");
    expect(events).not.toContain("combined");
  });

  it("stops before source author when proof read-back fails", async () => {
    const events: string[] = [];
    const sourceCalls = { count: 0 };
    const value = deps(events, sourceCalls);
    value.readProof = async () => { events.push("read-proof"); throw new Error("tampered proof"); };
    const result = await runRepairLoop(value);
    expect(result.outcome).toBe("INCONCLUSIVE");
    expect(sourceCalls.count).toBe(0);
    expect(events).not.toContain("author-source");
  });
});
