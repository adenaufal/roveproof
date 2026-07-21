import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EVIDENCE_REQUIRED_ARTIFACTS,
  JOURNEY_ID,
  PROFILE_ID,
  SEED_IDS,
  TARGET_ID,
  type AnalysisModelOutput,
} from "@roveproof/contracts";
import type { AdmittedEvidenceBundle } from "@roveproof/evidence";
import type { BoundedProcessRequest, BoundedProcessResult, CodexProcessRunner } from "../src/index.js";

function hash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export const validModelOutput: AnalysisModelOutput = {
  schemaVersion: 1,
  hypotheses: SEED_IDS.map((code, index) => ({
    rank: index + 1,
    code,
    explanation: `Evidence explanation ${index + 1}`,
    artifactRefs: [index === 0 ? "assertions.json#seed.mononym-required-last-name" : index === 1 ? "screenshots/failure-or-confirmation.png" : "metrics.json"],
    falsifier: `Falsifier ${index + 1}`,
  })),
  recommendedRegressionAssertion: "The fixed checkout completes once within budget.",
  uncertainty: ["One deterministic sample."],
};

export async function createSyntheticAdmittedBundle(root: string, runId = "run-analysis-001"): Promise<AdmittedEvidenceBundle> {
  const directory = path.join(root, "runs", runId);
  await mkdir(directory, { recursive: true });
  const entries = [];
  for (const artifactPath of [...EVIDENCE_REQUIRED_ARTIFACTS].sort((left, right) => left.localeCompare(right))) {
    const content = artifactPath.endsWith(".png")
      ? Buffer.from(`png:${artifactPath}`)
      : artifactPath === "trace.zip"
        ? Buffer.from("trace")
        : Buffer.from(artifactPath.endsWith(".jsonl") ? "" : JSON.stringify({ artifactPath }));
    const filePath = path.join(directory, ...artifactPath.split("/"));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
    entries.push({
      path: artifactPath,
      size: content.length,
      sha256: hash(content),
      mediaType: artifactPath.endsWith(".png") ? "image/png" : "application/json",
    });
  }
  const indexHash = "a".repeat(64);
  const rootHash = "b".repeat(64);
  return {
    directory,
    indexHash,
    anchor: { schemaVersion: 1, runId, indexHash, rootHash, createdAt: "2026-07-18T00:00:00.000Z" },
    index: {
      schemaVersion: 1,
      runId,
      hashAlgorithm: "sha256",
      indexPolicy: "sha256-tree-v1; artifact-index.json is metadata and is self-excluded",
      rootHash,
      entries,
    },
    manifest: {
      runId,
      kind: "baseline",
      mode: "real",
      targetId: TARGET_ID,
      journeyId: JOURNEY_ID,
      profileId: PROFILE_ID,
      seedIds: [...SEED_IDS],
      runtime: { profileVerified: true },
      redaction: { verified: true },
      missingArtifacts: [],
      deviations: [],
    },
    result: { verdict: "FAIL_BLOCKED", sampleCount: 1 },
    assertions: {
      observedSeedIds: [...SEED_IDS],
      assertions: SEED_IDS.map((seedId, index) => ({
        id: ["seed.mononym-required-last-name", "seed.phone-plus62-normalization", "seed.mobile-heavy-checkout-bundle"][index],
        status: "FAIL",
        seedId,
        message: `Failure ${index + 1}`,
        artifactRefs: ["assertions.json"],
      })),
    },
    metrics: {},
  } as unknown as AdmittedEvidenceBundle;
}

function result(overrides: Partial<BoundedProcessResult> = {}): BoundedProcessResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    timedOut: false,
    outputLimitExceeded: false,
    spawnErrorCode: null,
    ioErrorCode: null,
    terminationFailed: false,
    ...overrides,
  };
}

export function jsonlFor(output: AnalysisModelOutput = validModelOutput): string {
  return [
    { type: "thread.started", thread_id: "123e4567-e89b-42d3-a456-426614174000" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item-1", type: "agent_message", text: JSON.stringify(output) } },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 40, reasoning_output_tokens: 10 } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n";
}

export function createFakeRunner(options: Readonly<{
  output?: AnalysisModelOutput;
  execResult?: BoundedProcessResult;
  beforeExecReturn?: (request: BoundedProcessRequest) => Promise<void>;
  calls?: BoundedProcessRequest[];
}> = {}): CodexProcessRunner {
  return async (request) => {
    options.calls?.push(request);
    if (request.args.length === 1 && request.args[0] === "--version") {
      return result({ stdout: "codex-cli 0.139.0\n" });
    }
    if (request.args[0] === "login") return result({ stdout: "Logged in using ChatGPT\n" });
    const output = options.output ?? validModelOutput;
    const resultIndex = request.args.indexOf("--output-last-message");
    if (resultIndex < 0 || !request.args[resultIndex + 1]) throw new Error("Missing result path in test invocation");
    await writeFile(request.args[resultIndex + 1], JSON.stringify(output));
    await options.beforeExecReturn?.(request);
    return options.execResult ?? result({ stdout: jsonlFor(output), stderr: "safe diagnostic" });
  };
}
