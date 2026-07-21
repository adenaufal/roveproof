import {
  SandboxClassificationSchema,
  type SandboxClassification,
  type SandboxResult,
} from "@roveproof/contracts";

export type SandboxObservation = Readonly<{
  stage: "test-proof" | "combined";
  started: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  resourceLimitExceeded: boolean;
  setupError: string | null;
  protocolError: string | null;
  patchApplyError: string | null;
  exportViolation: string | null;
  secretDetected: boolean;
  infrastructureError: string | null;
  matchedExpectedFailure: boolean;
}>;

export function classifySandboxObservation(observation: SandboxObservation): SandboxClassification {
  if (observation.infrastructureError !== null) return "INFRASTRUCTURE_UNAVAILABLE";
  if (observation.secretDetected) return "SECRET_DETECTED";
  if (observation.exportViolation !== null) return "EXPORT_VIOLATION";
  if (observation.patchApplyError !== null) return "PATCH_APPLY_REJECTED";
  if (observation.protocolError !== null) return "PROTOCOL_FAILURE";
  if (!observation.started) return "INFRASTRUCTURE_UNAVAILABLE";
  if (observation.setupError !== null) return observation.stage === "test-proof" ? "TEST_SETUP_FAILURE" : "CANDIDATE_SETUP_FAILURE";
  if (observation.timedOut || observation.signal !== null) return observation.stage === "test-proof" ? "TEST_TIMEOUT" : "CANDIDATE_TIMEOUT";
  if (observation.resourceLimitExceeded) return observation.stage === "test-proof" ? "TEST_RESOURCE_LIMIT" : "CANDIDATE_RESOURCE_LIMIT";
  if (observation.outputLimitExceeded) return observation.stage === "test-proof" ? "TEST_OUTPUT_LIMIT" : "CANDIDATE_OUTPUT_LIMIT";
  if (observation.stage === "test-proof") {
    if (observation.exitCode === 0) return "TEST_DID_NOT_FAIL";
    if (observation.exitCode !== 1 || !observation.matchedExpectedFailure) return "TEST_WRONG_FAILURE";
    return "EXPECTED_FAILURE";
  }
  return observation.exitCode === 0 ? "CANDIDATE_PASS" : "CANDIDATE_TEST_FAILURE";
}

export function resultForClassification(input: Omit<SandboxResult, "resultHash"> & { resultHash: string }): SandboxResult {
  return input;
}

export function isExpectedFailure(classification: SandboxClassification): boolean {
  return SandboxClassificationSchema.parse(classification) === "EXPECTED_FAILURE";
}

export function isCandidatePass(classification: SandboxClassification): boolean {
  return SandboxClassificationSchema.parse(classification) === "CANDIDATE_PASS";
}