import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeTargetSourceRevision } from "../src/source-revision";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("target source provenance", () => {
  it("uses a deterministic content hash when a Git commit cannot describe the working tree", async () => {
    const first = await computeTargetSourceRevision(repositoryRoot);
    const second = await computeTargetSourceRevision(repositoryRoot);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });
});
