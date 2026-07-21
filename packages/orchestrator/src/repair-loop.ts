import {
  M5CandidateEnvelopeSchema,
  SourceSnapshotSchema,
  TestFailureProofSchema,
  type M5CandidateEnvelope,
  type SourceSnapshot,
  type TestFailureProof,
} from "@roveproof/contracts";

export type RepairLoopStage = "admission" | "snapshot" | "preflight" | "test-authoring" | "test-policy" | "test-proof" | "source-authoring" | "source-policy" | "combined" | "sandbox-gating" | "cleanup";
export type RepairLoopOutcome = "PASS" | "REJECTED" | "INCONCLUSIVE";
export type RepairLoopTrace = readonly string[];

export type RepairLoopDependencies = Readonly<{
  admit: () => Promise<void>;
  snapshot: () => Promise<SourceSnapshot>;
  preflight: () => Promise<void>;
  authorTest: () => Promise<unknown>;
  persistTestAttempt: (attempt: unknown) => Promise<void>;
  testPolicy: (authoring: unknown) => Promise<unknown>;
  runTestSandbox: (authoring: unknown) => Promise<unknown>;
  makeProof: (authoring: unknown, sandbox: unknown, snapshot: SourceSnapshot) => Promise<TestFailureProof>;
  persistProof: (proof: TestFailureProof, authoring: unknown, sandbox: unknown) => Promise<void>;
  readProof: (binding: Readonly<{ baselineRunId: string; sourceSnapshotHash: string; testDiffHash: string }>) => Promise<unknown>;
  authorSource: (proof: TestFailureProof, snapshot: SourceSnapshot) => Promise<unknown>;
  persistSourceAttempt: (attempt: unknown) => Promise<void>;
  sourcePolicy: (authoring: unknown) => Promise<unknown>;
  runCombinedSandbox: (testAuthoring: unknown, sourceAuthoring: unknown) => Promise<unknown>;
  publish: (input: Readonly<{ snapshot: SourceSnapshot; testAuthoring: unknown; sourceAuthoring: unknown; testPolicy: unknown; sourcePolicy: unknown; proof: TestFailureProof; testSandbox: unknown; combinedSandbox: unknown }>) => Promise<M5CandidateEnvelope>;
  cleanup: () => Promise<void>;
  onStage?: (stage: RepairLoopStage, outcome: RepairLoopOutcome, message: string) => Promise<void>;
  classifyError?: (error: unknown) => RepairLoopOutcome;
  baselineRunId: string;
}>;

export type RepairLoopResult = Readonly<{
  outcome: RepairLoopOutcome;
  stage: RepairLoopStage;
  trace: RepairLoopTrace;
  envelope: M5CandidateEnvelope | null;
}>;

async function stageNotice(deps: RepairLoopDependencies, trace: string[], stage: RepairLoopStage, outcome: RepairLoopOutcome, message: string): Promise<void> {
  trace.push(`${stage}:${outcome}`);
  await deps.onStage?.(stage, outcome, message);
}

export function classifyRepairLoopError(error: unknown): RepairLoopOutcome {
  const value = error as { outcome?: unknown; name?: unknown; code?: unknown } | null;
  if (value?.outcome === "REJECTED" || value?.outcome === "INCONCLUSIVE") return value.outcome;
  if (value?.name === "DiffPolicyError" || value?.code === "AUTHORING_POLICY_REJECTED" || value?.code === "AUTHORING_TEST_PROOF_REQUIRED" || value?.code === "AUTHORING_SANDBOX_REJECTED") return "REJECTED";
  return "INCONCLUSIVE";
}

/**
 * Trusted ordering seam for the M5 one-seed loop. It accepts injected side
 * effects so tests can prove that a source call is unreachable before proof
 * persistence/read-back; all candidate execution remains owned by callers.
 */
export async function runRepairLoop(deps: RepairLoopDependencies): Promise<RepairLoopResult> {
  const trace: string[] = [];
  let currentStage: RepairLoopStage = "admission";
  let cleaned = false;
  let snapshot: SourceSnapshot | null = null;
  let proof: TestFailureProof | null = null;
  let testAuthoring: unknown;
  let sourceAuthoring: unknown;
  let testPolicy: unknown;
  let sourcePolicy: unknown;
  let testSandbox: unknown;
  let combinedSandbox: unknown;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    await deps.cleanup();
    cleaned = true;
  };
  try {
    currentStage = "admission";
    await deps.admit();
    await stageNotice(deps, trace, currentStage, "PASS", "explicit provenance admitted");
    currentStage = "snapshot";
    snapshot = SourceSnapshotSchema.parse(await deps.snapshot());
    await stageNotice(deps, trace, currentStage, "PASS", "immutable source projection admitted");
    currentStage = "preflight";
    await deps.preflight();
    await stageNotice(deps, trace, currentStage, "PASS", "Codex preflight passed");
    currentStage = "test-authoring";
    testAuthoring = await deps.authorTest();
    await deps.persistTestAttempt(testAuthoring);
    await stageNotice(deps, trace, currentStage, "PASS", "one test-only author call completed");
    currentStage = "test-policy";
    testPolicy = await deps.testPolicy(testAuthoring);
    await stageNotice(deps, trace, currentStage, "PASS", "test-only policy admitted");
    currentStage = "test-proof";
    testSandbox = await deps.runTestSandbox(testAuthoring);
    proof = TestFailureProofSchema.parse(await deps.makeProof(testAuthoring, testSandbox, snapshot));
    await deps.persistProof(proof, testAuthoring, testSandbox);
    const proofReadBack = TestFailureProofSchema.parse(await deps.readProof({ baselineRunId: deps.baselineRunId, sourceSnapshotHash: snapshot.snapshotHash, testDiffHash: proof.testDiffHash }));
    if (proofReadBack.proofHash !== proof.proofHash || proofReadBack.sandboxEvidenceHash !== proof.sandboxEvidenceHash || proofReadBack.sandboxResultHash !== proof.sandboxResultHash) throw new Error("expected-failure proof read-back binding mismatch");
    await stageNotice(deps, trace, currentStage, "PASS", "immutable expected-failure proof read back");
    currentStage = "source-authoring";
    sourceAuthoring = await deps.authorSource(proofReadBack, snapshot);
    await deps.persistSourceAttempt(sourceAuthoring);
    await stageNotice(deps, trace, currentStage, "PASS", "one source-only author call completed after proof");
    currentStage = "source-policy";
    sourcePolicy = await deps.sourcePolicy(sourceAuthoring);
    await stageNotice(deps, trace, currentStage, "PASS", "source-only policy admitted");
    currentStage = "combined";
    combinedSandbox = await deps.runCombinedSandbox(testAuthoring, sourceAuthoring);
    await stageNotice(deps, trace, currentStage, "PASS", "combined candidate sandbox completed");
    currentStage = "cleanup";
    await cleanup();
    await stageNotice(deps, trace, currentStage, "PASS", "disposable workspaces removed before publication");
    currentStage = "sandbox-gating";
    const envelope = M5CandidateEnvelopeSchema.parse(await deps.publish({ snapshot, testAuthoring, sourceAuthoring, testPolicy, sourcePolicy, proof: proofReadBack, testSandbox, combinedSandbox }));
    await stageNotice(deps, trace, currentStage, "PASS", "hash-bound SANDBOX_GATING envelope published");
    return { outcome: "PASS", stage: currentStage, trace, envelope };
  } catch (error) {
    const message = error instanceof Error ? error.message : "repair loop rejected";
    const outcome = deps.classifyError?.(error) ?? classifyRepairLoopError(error);
    await stageNotice(deps, trace, currentStage, outcome, message);
    if (!cleaned) {
      try {
        await cleanup();
        await stageNotice(deps, trace, "cleanup", "PASS", "disposable workspaces removed after terminal failure");
      } catch (cleanupError) {
        await stageNotice(deps, trace, "cleanup", "INCONCLUSIVE", cleanupError instanceof Error ? cleanupError.message : "cleanup failed");
        return { outcome: "INCONCLUSIVE", stage: "cleanup", trace, envelope: null };
      }
    }
    return { outcome, stage: currentStage, trace, envelope: null };
  }
}