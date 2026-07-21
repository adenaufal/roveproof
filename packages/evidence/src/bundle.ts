import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  ArtifactIndexSchema,
  assertSafeArtifactPath,
  EvidenceAnchorSchema,
  EVIDENCE_REQUIRED_ARTIFACTS,
  EvidenceManifestSchema,
  EvidenceMetricsSchema,
  EvidenceResultSchema,
  EvidenceRunIdSchema,
  JourneyAssertionsSchema,
  type ArtifactIndex,
  type EvidenceAnchor,
  type EvidenceManifest,
  type EvidenceMetrics,
  type EvidenceResult,
  type JourneyAssertions,
} from "@roveproof/contracts";
import { assertFileContainsNoSensitiveData, assertTraceContainsNoSensitiveData } from "./sensitive-scan.js";

const INDEX_POLICY = "sha256-tree-v1; artifact-index.json is metadata and is self-excluded" as const;
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const TEXT_ARTIFACT = /\.(?:har|json|jsonl|txt)$/;

export type EvidenceRecords = Readonly<{
  manifest: EvidenceManifest;
  result: EvidenceResult;
  assertions: JourneyAssertions;
  metrics: EvidenceMetrics;
}>;

export type AdmittedEvidenceBundle = EvidenceRecords & Readonly<{
  directory: string;
  index: ArtifactIndex;
  indexHash: string;
  anchor: EvidenceAnchor | null;
}>;

export type EvidenceAdmissionOptions = Readonly<{
  expectedIndexHash?: string;
}>;

type InternalAdmissionOptions = EvidenceAdmissionOptions & Readonly<{ requireAnchor: boolean }>;

function jsonBytes(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function mediaType(relativePath: string): string {
  if (relativePath.endsWith(".png")) return "image/png";
  if (relativePath.endsWith(".zip")) return "application/zip";
  if (relativePath.endsWith(".har")) return "application/json";
  if (relativePath.endsWith(".jsonl")) return "application/x-ndjson";
  if (relativePath.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function listPayloadFiles(directory: string, relativeDirectory = ""): Promise<string[]> {
  const absoluteDirectory = relativeDirectory ? path.join(directory, ...relativeDirectory.split("/")) : directory;
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    assertSafeArtifactPath(relativePath);
    if (entry.isSymbolicLink()) throw new Error(`Evidence bundles cannot contain symbolic links: ${relativePath}`);
    if (entry.isDirectory()) {
      files.push(...await listPayloadFiles(directory, relativePath));
      continue;
    }
    if (!entry.isFile()) throw new Error(`Evidence bundles may contain regular files only: ${relativePath}`);
    if (relativePath !== "artifact-index.json") files.push(relativePath);
  }

  return files;
}

async function buildArtifactIndex(directory: string, runId: string): Promise<ArtifactIndex> {
  const paths = (await listPayloadFiles(directory)).sort((left, right) => left.localeCompare(right));
  let bundleSize = 0;
  const entries: ArtifactIndex["entries"] = [];

  for (const relativePath of paths) {
    const absolutePath = path.join(directory, ...relativePath.split("/"));
    const fileStats = await lstat(absolutePath);
    if (!fileStats.isFile() || fileStats.isSymbolicLink()) throw new Error(`Invalid evidence artifact: ${relativePath}`);
    if (fileStats.size > MAX_ARTIFACT_BYTES) throw new Error(`Evidence artifact exceeds size policy: ${relativePath}`);
    bundleSize += fileStats.size;
    if (bundleSize > MAX_BUNDLE_BYTES) throw new Error("Evidence bundle exceeds size policy");
    entries.push({
      path: relativePath,
      size: fileStats.size,
      sha256: await sha256File(absolutePath),
      mediaType: mediaType(relativePath),
    });
  }

  const rootHash = sha256Text(entries.map((entry) => `${entry.path}\0${entry.size}\0${entry.sha256}\n`).join(""));
  return ArtifactIndexSchema.parse({
    schemaVersion: 1,
    runId,
    hashAlgorithm: "sha256",
    indexPolicy: INDEX_POLICY,
    rootHash,
    entries,
  });
}

async function parseJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function parseJsonLines(filePath: string): Promise<unknown[]> {
  const input = await readFile(filePath, "utf8");
  if (!input) return [];
  return input.trimEnd().split("\n").map((line, index) => {
    if (!line.trim()) throw new Error(`JSONL record ${index + 1} is empty`);
    return JSON.parse(line) as unknown;
  });
}

function evidenceRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

async function assertMeasurementConsistency(directory: string, records: EvidenceRecords): Promise<void> {
  const { result, metrics } = records;
  if (result.task.durationMs !== metrics.boundary.durationMs) {
    throw new Error("Result and metrics duration measurements disagree");
  }
  if (result.performance.transferredBytes !== metrics.transferredBytes) {
    throw new Error("Result and metrics transferred byte measurements disagree");
  }
  for (const metric of ["lcpMs", "inpMs", "cls"] as const) {
    if (result.performance[metric] !== metrics[metric]) throw new Error(`Result and metrics ${metric} measurements disagree`);
  }

  const requests = await parseJsonLines(path.join(directory, "requests.jsonl"));
  let transferredBytes = 0;
  let failedRequestCount = 0;
  for (const [index, input] of requests.entries()) {
    const request = evidenceRecord(input, `Request evidence record ${index + 1}`);
    if (typeof request.failed !== "boolean") throw new Error(`Request evidence record ${index + 1} has no boolean failed state`);
    if (request.failed) failedRequestCount += 1;
    if (request.encodedBytes !== null && (!Number.isSafeInteger(request.encodedBytes) || (request.encodedBytes as number) < 0)) {
      throw new Error(`Request evidence record ${index + 1} has an invalid encoded byte count`);
    }
    if (!request.failed && typeof request.encodedBytes === "number") transferredBytes += request.encodedBytes;
  }
  if (!Number.isSafeInteger(transferredBytes)) throw new Error("Request evidence transferred byte total is unsafe");
  if (requests.length !== metrics.requestCount) throw new Error("Metrics request count disagrees with requests.jsonl");
  if (failedRequestCount !== metrics.failedRequestCount) throw new Error("Metrics failed request count disagrees with requests.jsonl");
  if (transferredBytes !== metrics.transferredBytes) throw new Error("Metrics transferred bytes disagree with requests.jsonl");

  const consoleRecords = await parseJsonLines(path.join(directory, "console.jsonl"));
  let consoleErrorCount = 0;
  let pageErrorCount = 0;
  for (const [index, input] of consoleRecords.entries()) {
    const record = evidenceRecord(input, `Console evidence record ${index + 1}`);
    if (record.kind === "pageerror") pageErrorCount += 1;
    else if (record.kind === "console" && record.level === "error") consoleErrorCount += 1;
    else if (record.kind !== "console") throw new Error(`Console evidence record ${index + 1} has an invalid kind`);
  }
  if (consoleErrorCount !== metrics.consoleErrorCount) throw new Error("Metrics console error count disagrees with console.jsonl");
  if (pageErrorCount !== metrics.pageErrorCount) throw new Error("Metrics page error count disagrees with console.jsonl");
}

function assertMatchingRunIds(records: EvidenceRecords, index: ArtifactIndex): void {
  const runIds = [records.manifest.runId, records.result.runId, records.assertions.runId, records.metrics.runId, index.runId];
  if (new Set(runIds).size !== 1) throw new Error("Evidence records do not share one run ID");
}

function assertArtifactCompleteness(manifest: EvidenceManifest, result: EvidenceResult, indexedPaths: Set<string>): void {
  const declaredMissing = new Set(manifest.missingArtifacts.map(({ path: artifactPath }) => artifactPath));
  for (const artifactPath of declaredMissing) {
    if (indexedPaths.has(artifactPath)) throw new Error(`Artifact is both present and declared missing: ${artifactPath}`);
    if (!(EVIDENCE_REQUIRED_ARTIFACTS as readonly string[]).includes(artifactPath)) {
      throw new Error(`Only required artifacts may be declared missing: ${artifactPath}`);
    }
  }
  for (const artifactPath of EVIDENCE_REQUIRED_ARTIFACTS) {
    if (!indexedPaths.has(artifactPath) && !declaredMissing.has(artifactPath)) {
      throw new Error(`Required evidence artifact is absent without a declaration: ${artifactPath}`);
    }
  }
  if (declaredMissing.size > 0 && result.verdict !== "INCONCLUSIVE") {
    throw new Error("A run with missing required artifacts must be INCONCLUSIVE");
  }
  if (!manifest.runtime.profileVerified && result.verdict !== "INCONCLUSIVE") {
    throw new Error("An unverified runtime profile must produce an INCONCLUSIVE result");
  }
  if (!manifest.redaction.verified) throw new Error("Evidence cannot be admitted without verified redaction");
}

async function assertIndexMatchesFiles(directory: string, index: ArtifactIndex): Promise<void> {
  const actualPaths = (await listPayloadFiles(directory)).sort((left, right) => left.localeCompare(right));
  const indexedPaths = index.entries.map(({ path: artifactPath }) => artifactPath);
  if (JSON.stringify(actualPaths) !== JSON.stringify(indexedPaths)) {
    throw new Error("Artifact index does not exactly cover bundle payload files");
  }

  let totalSize = 0;
  for (const entry of index.entries) {
    const absolutePath = path.join(directory, ...entry.path.split("/"));
    const fileStats = await lstat(absolutePath);
    if (!fileStats.isFile() || fileStats.isSymbolicLink()) throw new Error(`Indexed artifact is not a regular file: ${entry.path}`);
    if (fileStats.size !== entry.size) throw new Error(`Artifact size mismatch: ${entry.path}`);
    if (await sha256File(absolutePath) !== entry.sha256) throw new Error(`Artifact hash mismatch: ${entry.path}`);
    totalSize += fileStats.size;
  }
  if (totalSize > MAX_BUNDLE_BYTES) throw new Error("Evidence bundle exceeds size policy");

  const rootHash = sha256Text(index.entries.map((entry) => `${entry.path}\0${entry.size}\0${entry.sha256}\n`).join(""));
  if (rootHash !== index.rootHash) throw new Error("Artifact index root hash mismatch");
}

async function assertRedacted(directory: string, index: ArtifactIndex): Promise<void> {
  for (const entry of index.entries) {
    const absolutePath = path.join(directory, ...entry.path.split("/"));
    if (entry.path === "trace.zip") {
      await assertTraceContainsNoSensitiveData(absolutePath);
    } else if (TEXT_ARTIFACT.test(entry.path)) {
      await assertFileContainsNoSensitiveData(absolutePath, entry.path);
    }
  }
  await assertFileContainsNoSensitiveData(path.join(directory, "artifact-index.json"), "artifact-index.json");
}

function anchorPathForBundle(directory: string, runId: string): string {
  const runsDirectory = path.dirname(directory);
  if (path.basename(runsDirectory) !== "runs" || path.basename(directory) !== runId) {
    throw new Error("Anchored evidence must use the canonical runs/<runId> directory");
  }
  return path.join(path.dirname(runsDirectory), "anchors", `${runId}.json`);
}

async function readAndVerifyAnchor(
  directory: string,
  runId: string,
  index: ArtifactIndex,
  indexHash: string,
  options: InternalAdmissionOptions,
): Promise<EvidenceAnchor | null> {
  if (options.expectedIndexHash !== undefined && options.expectedIndexHash !== indexHash) {
    throw new Error("Artifact index hash does not match the trusted expected hash");
  }
  if (options.requireAnchor === false) return null;
  const anchor = EvidenceAnchorSchema.parse(await parseJson(anchorPathForBundle(directory, runId)));
  if (anchor.runId !== runId || anchor.indexHash !== indexHash || anchor.rootHash !== index.rootHash) {
    throw new Error("Evidence anchor does not match the published bundle");
  }
  return anchor;
}

async function admitEvidenceBundleWithOptions(
  directoryInput: string,
  options: InternalAdmissionOptions,
): Promise<AdmittedEvidenceBundle> {
  const directory = path.resolve(directoryInput);
  const directoryStats = await lstat(directory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) throw new Error("Evidence bundle must be a real directory");

  const index = ArtifactIndexSchema.parse(await parseJson(path.join(directory, "artifact-index.json")));
  await assertIndexMatchesFiles(directory, index);
  const [manifestInput, resultInput, assertionsInput, metricsInput] = await Promise.all([
    parseJson(path.join(directory, "manifest.json")),
    parseJson(path.join(directory, "result.json")),
    parseJson(path.join(directory, "assertions.json")),
    parseJson(path.join(directory, "metrics.json")),
  ]);
  const records: EvidenceRecords = {
    manifest: EvidenceManifestSchema.parse(manifestInput),
    result: EvidenceResultSchema.parse(resultInput),
    assertions: JourneyAssertionsSchema.parse(assertionsInput),
    metrics: EvidenceMetricsSchema.parse(metricsInput),
  };
  assertMatchingRunIds(records, index);
  assertArtifactCompleteness(records.manifest, records.result, new Set(index.entries.map(({ path: artifactPath }) => artifactPath)));
  await assertMeasurementConsistency(directory, records);
  await assertRedacted(directory, index);
  const indexHash = await sha256File(path.join(directory, "artifact-index.json"));
  const anchor = await readAndVerifyAnchor(directory, records.manifest.runId, index, indexHash, options);

  return {
    directory,
    ...records,
    index,
    indexHash,
    anchor,
  };
}

export function admitEvidenceBundle(
  directoryInput: string,
  options: EvidenceAdmissionOptions = {},
): Promise<AdmittedEvidenceBundle> {
  return admitEvidenceBundleWithOptions(directoryInput, { ...options, requireAnchor: true });
}

async function makeReadOnly(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await makeReadOnly(absolutePath);
      await chmod(absolutePath, 0o555);
    } else {
      await chmod(absolutePath, 0o444);
    }
  }
  await chmod(directory, 0o555);
}

async function publishAnchor(anchorPath: string, anchor: EvidenceAnchor): Promise<void> {
  await mkdir(path.dirname(anchorPath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(path.dirname(anchorPath), `.${path.basename(anchorPath)}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(jsonBytes(anchor), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  let linked = false;
  try {
    await link(temporaryPath, anchorPath);
    linked = true;
    await chmod(anchorPath, 0o444);
  } catch (error) {
    if (linked) {
      await chmod(anchorPath, 0o600).catch(() => undefined);
      await unlink(anchorPath).catch(() => undefined);
    }
    throw error;
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

export class EvidenceBundleWriter {
  readonly runId: string;
  readonly stagingDirectory: string;
  readonly finalDirectory: string;
  readonly anchorPath: string;
  #finalized = false;

  private constructor(runId: string, stagingDirectory: string, finalDirectory: string, anchorPath: string) {
    this.runId = runId;
    this.stagingDirectory = stagingDirectory;
    this.finalDirectory = finalDirectory;
    this.anchorPath = anchorPath;
  }

  static async create(artifactRootInput: string, runIdInput: string): Promise<EvidenceBundleWriter> {
    const runId = EvidenceRunIdSchema.parse(runIdInput);
    const artifactRoot = path.resolve(artifactRootInput);
    const runsDirectory = path.join(artifactRoot, "runs");
    const stagingRoot = path.join(runsDirectory, ".staging");
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const stagingDirectory = await mkdtemp(path.join(stagingRoot, `${runId}.${randomUUID()}.`));
    return new EvidenceBundleWriter(
      runId,
      stagingDirectory,
      path.join(runsDirectory, runId),
      path.join(artifactRoot, "anchors", `${runId}.json`),
    );
  }

  async artifactPath(relativePathInput: string): Promise<string> {
    if (this.#finalized) throw new Error("Evidence bundle is already finalized");
    const relativePath = assertSafeArtifactPath(relativePathInput);
    const absolutePath = path.join(this.stagingDirectory, ...relativePath.split("/"));
    await mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
    return absolutePath;
  }

  async writeJson(relativePath: string, value: unknown): Promise<void> {
    const absolutePath = await this.artifactPath(relativePath);
    await writeFile(absolutePath, jsonBytes(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
  }

  async writeJsonLines(relativePath: string, values: readonly unknown[]): Promise<void> {
    const absolutePath = await this.artifactPath(relativePath);
    const content = values.length === 0 ? "" : `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
    await writeFile(absolutePath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }

  async finalize(recordsInput: EvidenceRecords): Promise<AdmittedEvidenceBundle> {
    if (this.#finalized) throw new Error("Evidence bundle is already finalized");
    const records: EvidenceRecords = {
      manifest: EvidenceManifestSchema.parse(recordsInput.manifest),
      result: EvidenceResultSchema.parse(recordsInput.result),
      assertions: JourneyAssertionsSchema.parse(recordsInput.assertions),
      metrics: EvidenceMetricsSchema.parse(recordsInput.metrics),
    };
    if ([records.manifest.runId, records.result.runId, records.assertions.runId, records.metrics.runId].some((id) => id !== this.runId)) {
      throw new Error("Cannot finalize evidence records for another run");
    }

    await Promise.all([
      this.writeJson("manifest.json", records.manifest),
      this.writeJson("result.json", records.result),
      this.writeJson("assertions.json", records.assertions),
      this.writeJson("metrics.json", records.metrics),
    ]);
    const index = await buildArtifactIndex(this.stagingDirectory, this.runId);
    await this.writeJson("artifact-index.json", index);
    const staged = await admitEvidenceBundleWithOptions(this.stagingDirectory, { requireAnchor: false });
    const anchor = EvidenceAnchorSchema.parse({
      schemaVersion: 1,
      runId: this.runId,
      indexHash: staged.indexHash,
      rootHash: staged.index.rootHash,
      createdAt: new Date().toISOString(),
    });

    const lockPath = `${this.finalDirectory}.lock`;
    const lock = await open(lockPath, "wx", 0o600);
    let publicationError: unknown;
    let anchorPublished = false;
    try {
      if (await exists(this.finalDirectory) || await exists(this.anchorPath)) {
        throw new Error(`Evidence run already exists: ${this.runId}`);
      }
      await publishAnchor(this.anchorPath, anchor);
      anchorPublished = true;
      await rename(this.stagingDirectory, this.finalDirectory);
      this.#finalized = true;
    } catch (error) {
      publicationError = error;
      if (anchorPublished && !this.#finalized) {
        await chmod(this.anchorPath, 0o600).catch(() => undefined);
        await unlink(this.anchorPath).catch(() => undefined);
      }
    }
    try {
      await lock.close();
      await chmod(lockPath, 0o600);
      await unlink(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && publicationError === undefined) publicationError = error;
    }
    if (publicationError !== undefined) throw publicationError;

    const admitted = await admitEvidenceBundle(this.finalDirectory);
    await makeReadOnly(this.finalDirectory);
    return admitted;
  }
}
