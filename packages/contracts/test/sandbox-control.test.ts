import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SandboxControlSchema, hashSandboxControl } from "../src/index.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const snapshot = [{ path: "apps/target/test/repair-mononym.test.mjs", size: 1, sha256: "a".repeat(64) }];
function control() {
  const base = {
    schemaVersion: 1 as const,
    recordVersion: "sandbox-control-v1" as const,
    stage: "test-proof" as const,
    commandId: "test-regression" as const,
    sourceSnapshotHash: "b".repeat(64),
    snapshotFiles: snapshot,
    testDiffBase64: Buffer.from("test-diff").toString("base64"),
    testDiffHash: hash("test-diff"),
    sourceDiffBase64: null,
    sourceDiffHash: null,
    combinedDiffBase64: null,
    combinedDiffHash: null,
    toolingRevision: "d".repeat(64),
    expectedSeedId: "ID-MONONYM-REQUIRED-LAST-NAME" as const,
    assertionId: "seed.mononym-required-last-name" as const,
    assertionFragment: "required last name" as const,
  };
  return { ...base, controlHash: hashSandboxControl(base) };
}

describe("strict M5 sandbox control", () => {
  it("binds all control bytes and rejects tampering or unknown fields", () => {
    const admitted = SandboxControlSchema.parse(control());
    expect(admitted.controlHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => SandboxControlSchema.parse({ ...admitted, testDiffHash: "c".repeat(64) })).toThrow();
    expect(() => SandboxControlSchema.parse({ ...admitted, unexpected: true })).toThrow();
  });

  it("does not allow a source-bearing test-proof control", () => {
    const admitted = control();
    expect(() => SandboxControlSchema.parse({ ...admitted, sourceDiffBase64: Buffer.from("source").toString("base64"), sourceDiffHash: hash("source") })).toThrow();
  });
});
