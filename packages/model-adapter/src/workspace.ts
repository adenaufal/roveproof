import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EVIDENCE_REQUIRED_ARTIFACTS,
  JOURNEY_ID,
  PROFILE_ID,
  SEED_IDS,
  TARGET_ID,
  type AnalysisInputArtifact,
} from "@roveproof/contracts";
import type { AdmittedEvidenceBundle } from "@roveproof/evidence";
import { ModelAdapterError } from "./errors.js";
import type { AnalysisDossier } from "./prompt.js";

const MAX_TOTAL_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_PNG_BYTES = 4 * 1024 * 1024;
const MAX_TRACE_BYTES = 16 * 1024 * 1024;
const TEXT_ARTIFACT_PATHS = [
  "manifest.json",
  "result.json",
  "assertions.json",
  "metrics.json",
  "console.jsonl",
  "requests.jsonl",
  "network.har",
] as const;
const SCREENSHOT_PATHS = [
  "screenshots/00-start.png",
  "screenshots/failure-or-confirmation.png",
] as const;

export type AnalysisWorkspace = Readonly<{
  root: string;
  evidenceDirectory: string;
  schemaPath: string;
  resultPath: string;
  inputArtifacts: readonly AnalysisInputArtifact[];
  imagePaths: readonly string[];
  dossier: AnalysisDossier;
}>;

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function artifactLimit(artifactPath: string): number {
  if (artifactPath.endsWith(".png")) return MAX_PNG_BYTES;
  if (artifactPath === "trace.zip") return MAX_TRACE_BYTES;
  return MAX_TEXT_ARTIFACT_BYTES;
}

export function assertEligibleAnalysisBaseline(bundle: AdmittedEvidenceBundle): void {
  if (!bundle.anchor || bundle.anchor.indexHash !== bundle.indexHash || bundle.anchor.rootHash !== bundle.index.rootHash) {
    throw new ModelAdapterError("MODEL_EVIDENCE_REJECTED", "admission");
  }
  const seedAssertions = bundle.assertions.assertions.filter((assertion) => assertion.seedId !== undefined);
  const failedSeedIds = seedAssertions
    .filter((assertion) => assertion.status === "FAIL")
    .map((assertion) => assertion.seedId);
  if (
    bundle.manifest.kind !== "baseline" ||
    bundle.manifest.mode !== "real" ||
    bundle.manifest.targetId !== TARGET_ID ||
    bundle.manifest.journeyId !== JOURNEY_ID ||
    bundle.manifest.profileId !== PROFILE_ID ||
    !bundle.manifest.runtime.profileVerified ||
    !bundle.manifest.redaction.verified ||
    bundle.manifest.missingArtifacts.length > 0 ||
    bundle.manifest.deviations.length > 0 ||
    bundle.result.verdict !== "FAIL_BLOCKED" ||
    bundle.result.sampleCount !== 1 ||
    bundle.assertions.observedSeedIds.length !== SEED_IDS.length ||
    seedAssertions.length !== SEED_IDS.length ||
    failedSeedIds.length !== SEED_IDS.length ||
    new Set(failedSeedIds).size !== SEED_IDS.length ||
    SEED_IDS.some((seedId, index) =>
      bundle.manifest.seedIds[index] !== seedId ||
      bundle.assertions.observedSeedIds[index] !== seedId ||
      failedSeedIds[index] !== seedId
    )
  ) {
    throw new ModelAdapterError("MODEL_EVIDENCE_REJECTED", "admission");
  }
}

function destinationPath(evidenceDirectory: string, artifactPath: string): string {
  return path.join(evidenceDirectory, ...artifactPath.split("/"));
}

export async function createAnalysisWorkspace(
  bundle: AdmittedEvidenceBundle,
  options: Readonly<{ temporaryRoot?: string }> = {},
): Promise<AnalysisWorkspace> {
  assertEligibleAnalysisBaseline(bundle);
  const temporaryRoot = options.temporaryRoot ?? os.tmpdir();
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(path.join(temporaryRoot, "roveproof-analysis-"));
  const evidenceDirectory = path.join(root, "evidence");
  const controlDirectory = path.join(root, "control");
  const outputDirectory = path.join(root, "output");
  const schemaPath = path.join(controlDirectory, "analysis-output-v1.json");
  const resultPath = path.join(outputDirectory, "final.json");

  try {
    await Promise.all([
      mkdir(evidenceDirectory, { recursive: true, mode: 0o700 }),
      mkdir(controlDirectory, { recursive: true, mode: 0o700 }),
      mkdir(outputDirectory, { recursive: true, mode: 0o700 }),
    ]);
    const indexed = new Map(bundle.index.entries.map((entry) => [entry.path, entry]));
    const expectedPaths = [...EVIDENCE_REQUIRED_ARTIFACTS].sort((left, right) => left.localeCompare(right));
    let totalBytes = 0;
    const inputArtifacts: AnalysisInputArtifact[] = [];

    for (const artifactPath of expectedPaths) {
      const entry = indexed.get(artifactPath);
      if (!entry || entry.size > artifactLimit(artifactPath)) {
        throw new ModelAdapterError("MODEL_INPUT_LIMIT", "workspace");
      }
      totalBytes += entry.size;
      if (totalBytes > MAX_TOTAL_INPUT_BYTES) throw new ModelAdapterError("MODEL_INPUT_LIMIT", "workspace");
      const source = path.join(bundle.directory, ...artifactPath.split("/"));
      const destination = destinationPath(evidenceDirectory, artifactPath);
      const sourceMetadata = await lstat(source);
      if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink() || sourceMetadata.size !== entry.size) {
        throw new ModelAdapterError("MODEL_WORKSPACE_TAMPERED", "workspace");
      }
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
      const destinationMetadata = await lstat(destination);
      if (!destinationMetadata.isFile() || destinationMetadata.isSymbolicLink() || destinationMetadata.size !== entry.size || await sha256File(destination) !== entry.sha256) {
        throw new ModelAdapterError("MODEL_WORKSPACE_TAMPERED", "workspace");
      }
      await chmod(destination, 0o400);
      inputArtifacts.push({ path: artifactPath, size: entry.size, sha256: entry.sha256 });
    }

    const textEntries = await Promise.all(TEXT_ARTIFACT_PATHS.map(async (artifactPath) => [
      artifactPath,
      await readFile(destinationPath(evidenceDirectory, artifactPath), "utf8"),
    ] as const));
    const assertionReferences = bundle.assertions.assertions
      .map(({ id }) => `assertions.json#${id}`)
      .sort((left, right) => left.localeCompare(right));
    const allowedArtifactRefs = [...expectedPaths, ...assertionReferences];
    const dossier: AnalysisDossier = {
      baselineRunId: bundle.manifest.runId,
      fixedScope: {
        targetId: TARGET_ID,
        journeyId: JOURNEY_ID,
        profileId: PROFILE_ID,
        seedIds: [...SEED_IDS],
        sampleCount: 1,
      },
      allowedArtifactRefs,
      inputArtifacts,
      textArtifacts: Object.fromEntries(textEntries),
      binaryEvidence: [
        ...SCREENSHOT_PATHS.map((artifactPath) => ({ path: artifactPath, presentation: "attached-image" as const })),
        { path: "trace.zip", presentation: "hash-and-verifier-assertions" as const },
      ],
    };
    return {
      root,
      evidenceDirectory,
      schemaPath,
      resultPath,
      inputArtifacts,
      imagePaths: SCREENSHOT_PATHS.map((artifactPath) => destinationPath(evidenceDirectory, artifactPath)),
      dossier,
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeAnalysisControlFile(filePath: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > 256 * 1024) throw new ModelAdapterError("MODEL_INPUT_LIMIT", "workspace");
  await writeFile(filePath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export async function assertAnalysisWorkspaceUnchanged(workspace: AnalysisWorkspace): Promise<void> {
  for (const artifact of workspace.inputArtifacts) {
    const filePath = destinationPath(workspace.evidenceDirectory, artifact.path);
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== artifact.size || await sha256File(filePath) !== artifact.sha256) {
      throw new ModelAdapterError("MODEL_WORKSPACE_TAMPERED", "cleanup");
    }
  }
}

export async function removeAnalysisWorkspace(workspace: AnalysisWorkspace): Promise<void> {
  try {
    await rm(workspace.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  } catch {
    throw new ModelAdapterError("MODEL_WORKSPACE_CLEANUP_FAILED", "cleanup");
  }
}
