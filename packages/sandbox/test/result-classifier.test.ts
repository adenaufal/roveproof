import { describe, expect, it } from "vitest";
import { classifySandboxObservation } from "../src/index.js";

const base = {
  started: true,
  exitCode: 1,
  signal: null,
  timedOut: false,
  outputLimitExceeded: false,
  resourceLimitExceeded: false,
  setupError: null,
  protocolError: null,
  patchApplyError: null,
  exportViolation: null,
  secretDetected: false,
  infrastructureError: null,
  matchedExpectedFailure: true,
} as const;

describe("M5 result classification", () => {
  it("accepts only the fixed expected mononym failure", () => {
    expect(classifySandboxObservation({ stage: "test-proof", ...base })).toBe("EXPECTED_FAILURE");
    expect(classifySandboxObservation({ stage: "test-proof", ...base, exitCode: 0, matchedExpectedFailure: false })).toBe("TEST_DID_NOT_FAIL");
    expect(classifySandboxObservation({ stage: "test-proof", ...base, matchedExpectedFailure: false })).toBe("TEST_WRONG_FAILURE");
  });

  it("rejects setup, resource, export and infrastructure noise", () => {
    expect(classifySandboxObservation({ stage: "test-proof", ...base, setupError: "setup" })).toBe("TEST_SETUP_FAILURE");
    expect(classifySandboxObservation({ stage: "test-proof", ...base, resourceLimitExceeded: true })).toBe("TEST_RESOURCE_LIMIT");
    expect(classifySandboxObservation({ stage: "test-proof", ...base, exportViolation: "leak" })).toBe("EXPORT_VIOLATION");
    expect(classifySandboxObservation({ stage: "test-proof", ...base, started: false, exitCode: null, matchedExpectedFailure: false })).toBe("INFRASTRUCTURE_UNAVAILABLE");
  });

  it("requires a clean zero exit for the combined candidate stage", () => {
    expect(classifySandboxObservation({ stage: "combined", ...base, exitCode: 0 })).toBe("CANDIDATE_PASS");
    expect(classifySandboxObservation({ stage: "combined", ...base, exitCode: 1 })).toBe("CANDIDATE_TEST_FAILURE");
  });
});
