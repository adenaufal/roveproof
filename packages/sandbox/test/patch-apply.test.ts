import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SourceSnapshotSchema } from "@roveproof/contracts";
import {
  DiffPolicyError,
  applyParsedDiff,
  combineAuthoringDiffs,
  createSandboxControl,
  parseSourceAuthoringDiff,
  parseTestAuthoringDiff,
} from "../src/index.js";

const roots: string[] = [];
const testPath = "apps/target/test/repair-mononym.test.mjs";
const sourcePath = "apps/target/src/lib/seeds/identity.ts";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value !== null && typeof value === "object" ? `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "roveproof-apply-test-"));
  roots.push(root);
  const testContent = "import assert from \"node:assert/strict\";\n";
  const sourceContent = "export const value = false;\n";
  await mkdir(path.join(root, ...path.dirname(testPath).split("/")), { recursive: true });
  await mkdir(path.join(root, ...path.dirname(sourcePath).split("/")), { recursive: true });
  await writeFile(path.join(root, ...testPath.split("/")), testContent);
  await writeFile(path.join(root, ...sourcePath.split("/")), sourceContent);
  const withoutHash = {
    schemaVersion: 1 as const,
    recordVersion: "source-snapshot-v1" as const,
    sourceRevision: `sha256:${"a".repeat(64)}`,
    projectionRevision: "e".repeat(64),
    toolingRevision: "e".repeat(64),
    toolingFiles: [
      { path: sourcePath, size: Buffer.byteLength(sourceContent), sha256: hash(sourceContent) },
      { path: testPath, size: Buffer.byteLength(testContent), sha256: hash(testContent) },
    ],
    baselineRunId: "run-apply-test",
    expectedIndexHash: "b".repeat(64),
    expectedRootHash: "c".repeat(64),
    analysisId: "analysis-apply-test",
    expectedAnalysisHash: "d".repeat(64),
    files: [
      { path: sourcePath, size: Buffer.byteLength(sourceContent), sha256: hash(sourceContent) },
      { path: testPath, size: Buffer.byteLength(testContent), sha256: hash(testContent) },
    ],
  };
  const snapshot = SourceSnapshotSchema.parse({ ...withoutHash, snapshotHash: hash(canonical(withoutHash)) });
  return { root, snapshot, testContent, sourceContent };
}

const testDiffText = () => `--- a/${testPath}\n+++ b/${testPath}\n@@ -1,1 +1,4 @@\n import assert from "node:assert/strict";\n+test("ID-MONONYM-REQUIRED-LAST-NAME seed.mononym-required-last-name: required last name", () => {\n+  assert.equal(validateBaselineLegalName("Sari").valid, true);\n+});\n`;
const sourceDiffText = `--- a/${sourcePath}\n+++ b/${sourcePath}\n@@ -1,1 +1,1 @@\n-export const value = false;\n+export const value = true;\n`;

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("trusted M5 diff application and control", () => {
  it("applies exact hunks only after snapshot base hashes match", async () => {
    const { root, snapshot } = await fixture();
    const parsed = parseTestAuthoringDiff({ schemaVersion: 1, operation: "test-only", unifiedDiff: testDiffText() });
    await expect(applyParsedDiff({ workspaceDirectory: root, snapshot, parsedDiff: parsed })).resolves.toMatchObject({ diffHash: parsed.diffHash });
    await expect(readFile(path.join(root, ...testPath.split("/")), "utf8")).resolves.toContain("seed.mononym-required-last-name");
    await expect(applyParsedDiff({ workspaceDirectory: root, snapshot, parsedDiff: parsed })).rejects.toThrow(/base hash mismatch/);
  });

  it("binds stage, bytes, snapshot and fixed command in control", async () => {
    const { root, snapshot } = await fixture();
    const testDiff = parseTestAuthoringDiff({ schemaVersion: 1, operation: "test-only", unifiedDiff: testDiffText() });
    const sourceDiff = parseSourceAuthoringDiff({ schemaVersion: 1, operation: "source-only", unifiedDiff: sourceDiffText });
    const combined = combineAuthoringDiffs(testDiff, sourceDiff);
    const control = createSandboxControl({ stage: "combined", snapshot, testDiff, sourceDiff, combinedDiff: combined });
    expect(control.commandId).toBe("candidate-check");
    expect(control.combinedDiffHash).toBe(combined.hash);
    expect(() => createSandboxControl({ stage: "test-proof", snapshot, testDiff, sourceDiff, combinedDiff: combined })).toThrow();
    await rm(root, { recursive: true, force: true });
  });

  it("enforces the combined 250-line budget across both operations", async () => {
    const { snapshot } = await fixture();
    const testDiff = parseTestAuthoringDiff({ schemaVersion: 1, operation: "test-only", unifiedDiff: testDiffText() });
    const sourceDiff = parseSourceAuthoringDiff({ schemaVersion: 1, operation: "source-only", unifiedDiff: sourceDiffText });
    const oversized = { ...sourceDiff, metadata: { ...sourceDiff.metadata, additions: 247, changedLines: 247 } };
    expect(() => combineAuthoringDiffs(testDiff, oversized)).toThrow(/combined changed-line budget/i);
    void snapshot;
  });

  it("rejects path traversal before any workspace write", async () => {
    const { root } = await fixture();
    expect(() => parseTestAuthoringDiff({ schemaVersion: 1, operation: "test-only", unifiedDiff: testDiffText().replace(testPath, "../escape.ts") })).toThrow(DiffPolicyError);
    await expect(readFile(path.join(root, "escape.ts"))).rejects.toThrow();
  });
});
