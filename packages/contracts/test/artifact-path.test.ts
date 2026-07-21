import { describe, expect, it } from "vitest";
import { assertSafeArtifactPath, isSafeArtifactPath } from "../src/artifact-path.js";

describe("artifact path policy", () => {
  it("accepts and returns the exact canonical bundle-relative input", () => {
    const path = "runs/run-001/screenshots/checkout.png";
    expect(isSafeArtifactPath(path)).toBe(true);
    expect(assertSafeArtifactPath(path)).toBe(path);
  });

  it.each([
    "/", "\\", "C:\\", "C:/", "/etc/passwd", "C:\\Windows\\system.ini",
    "C:drive-relative", "../secret", "runs/../../secret", "runs\\..\\secret",
    "\\\\server\\share", "runs/", "runs//report.json",
  ])("rejects unsafe path %s", (path) => {
    expect(isSafeArtifactPath(path)).toBe(false);
    expect(() => assertSafeArtifactPath(path)).toThrow(/Unsafe artifact path/);
  });

  it.each([
    "con", "con.json", "runs/prn.txt", "aux", "nul.png",
    "com1", "com9.log", "lpt1", "lpt9.txt",
  ])("rejects the Windows reserved device basename %s", (path) => {
    expect(isSafeArtifactPath(path)).toBe(false);
  });

  it.each(["result.", "runs/result.json.", "result ", "runs/result.json "])(
    "rejects path segments with a trailing dot or space: %s",
    (path) => {
      expect(isSafeArtifactPath(path)).toBe(false);
    },
  );

  it.each([
    ["runs/report.json", "runs\\report.json"],
    ["runs/report.json", "runs/Report.json"],
    ["runs/report.json", "Runs/report.json"],
  ])("accepts canonical %s but rejects separator/case alias %s", (canonicalPath, alias) => {
    expect(isSafeArtifactPath(canonicalPath)).toBe(true);
    expect(isSafeArtifactPath(alias)).toBe(false);
    expect(assertSafeArtifactPath(canonicalPath)).toBe(canonicalPath);
    expect(() => assertSafeArtifactPath(alias)).toThrow(/Unsafe artifact path/);
  });

  it.each([
    ["artifact", "artifact."],
    ["runs/report.json", "runs/report.json "],
    ["runs/file.txt", "runs/nul.txt"],
    ["runs/conclusion.txt", "runs/con.txt"],
  ])("prevents Windows canonicalization aliases while retaining safe path %s", (safePath, unsafeAlias) => {
    expect(isSafeArtifactPath(safePath)).toBe(true);
    expect(isSafeArtifactPath(unsafeAlias)).toBe(false);
  });
});
