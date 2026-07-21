import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SOURCE_REVISION_INPUTS,
  computeM5ProjectionRevision,
  computeNoGitSourceRevision,
  createSourceProjection,
  verifySourceProjection,
} from "../src/index.js";

const roots: string[] = [];
const FIXTURE_PROJECTION_INPUTS = ["package.json", ...DEFAULT_SOURCE_REVISION_INPUTS, "apps/target/test/checkout-behavior.test.ts"] as const;

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "roveproof-snapshot-repo-"));
  roots.push(root);
  for (const input of DEFAULT_SOURCE_REVISION_INPUTS) {
    const file = path.join(root, ...input.split("/"));
    if (input.endsWith("/src")) {
      await mkdir(file, { recursive: true });
      await writeFile(path.join(file, "entry.ts"), "export const entry = true;\n");
    } else {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${input}\n`);
    }
  }
  await mkdir(path.join(root, "apps/target/test"), { recursive: true });
  await writeFile(path.join(root, "apps/target/test/checkout-behavior.test.ts"), "export {};\n");
  await writeFile(path.join(root, "package.json"), "{}\n");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("M5 no-Git source snapshots", () => {
  it("binds explicit baseline/evidence/analysis/source hashes and detects projection tamper", async () => {
    const repositoryRoot = await createRepository();
    const sourceRevision = await computeNoGitSourceRevision(repositoryRoot);
    const toolingRevision = await computeM5ProjectionRevision(repositoryRoot, FIXTURE_PROJECTION_INPUTS);
    const projection = await createSourceProjection({
      repositoryRoot,
      baselineRunId: "run-m5-snapshot",
      expectedIndexHash: "a".repeat(64),
      expectedRootHash: "b".repeat(64),
      analysisId: "analysis-m5-snapshot",
      expectedAnalysisHash: "c".repeat(64),
      expectedSourceRevision: sourceRevision,
      expectedToolingRevision: toolingRevision,
      projectionInputs: FIXTURE_PROJECTION_INPUTS,
      temporaryRoot: repositoryRoot,
    });
    expect(projection.snapshot.sourceRevision).toBe(sourceRevision);
    expect(projection.snapshot.files).toEqual([...projection.snapshot.files].sort((left, right) => left.path.localeCompare(right.path)));
    await expect(verifySourceProjection(projection.projectionDirectory, projection.snapshot)).resolves.toEqual(projection.snapshot);

    const target = path.join(projection.projectionDirectory, "apps/target/test/checkout-behavior.test.ts");
    await chmod(target, 0o600);
    await writeFile(target, "tampered\n");
    await expect(verifySourceProjection(projection.projectionDirectory, projection.snapshot)).rejects.toThrow();
  });

  it("rejects a stale or omitted source/tooling anchor and does not infer the default projection", async () => {
    const repositoryRoot = await createRepository();
    const sourceRevision = await computeNoGitSourceRevision(repositoryRoot);
    const toolingRevision = await computeM5ProjectionRevision(repositoryRoot, FIXTURE_PROJECTION_INPUTS);
    await expect(createSourceProjection({
      repositoryRoot,
      baselineRunId: "run-m5-stale",
      expectedIndexHash: "a".repeat(64),
      expectedRootHash: "b".repeat(64),
      analysisId: "analysis-m5-stale",
      expectedAnalysisHash: "c".repeat(64),
      expectedSourceRevision: `sha256:${"d".repeat(64)}`,
      expectedToolingRevision: toolingRevision,
      projectionInputs: FIXTURE_PROJECTION_INPUTS,
      temporaryRoot: repositoryRoot,
    })).rejects.toThrow();
    await expect(createSourceProjection({
      repositoryRoot,
      baselineRunId: "run-m5-stale",
      expectedIndexHash: "a".repeat(64),
      expectedRootHash: "b".repeat(64),
      analysisId: "analysis-m5-stale",
      expectedAnalysisHash: "c".repeat(64),
      expectedSourceRevision: sourceRevision,
      expectedToolingRevision: "d".repeat(64),
      projectionInputs: FIXTURE_PROJECTION_INPUTS,
      temporaryRoot: repositoryRoot,
    })).rejects.toThrow(/tooling revision/i);
    await expect(createSourceProjection({
      repositoryRoot,
      baselineRunId: "run-m5-stale",
      expectedIndexHash: "a".repeat(64),
      expectedRootHash: "b".repeat(64),
      analysisId: "analysis-m5-stale",
      expectedAnalysisHash: "c".repeat(64),
      expectedSourceRevision: sourceRevision,
      expectedToolingRevision: toolingRevision,
      temporaryRoot: repositoryRoot,
    })).rejects.toThrow();
  });
});
