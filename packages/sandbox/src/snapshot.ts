import { createHash } from "node:crypto";
import { createReadStream as fsCreateReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EntityIdSchema,
  Sha256Schema,
  SourceSnapshotSchema,
  type SourceSnapshot,
} from "@roveproof/contracts";
import { canonicalDiffPath, DiffPolicyError } from "./diff-policy.js";

const MAX_SNAPSHOT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

/**
 * These are the same no-Git source inputs used by the accepted journey source
 * revision. The projection may contain a root package manifest as preparation
 * metadata, but the revision itself remains bound to these canonical inputs.
 */
export const DEFAULT_SOURCE_REVISION_INPUTS = Object.freeze([
  "apps/target/package.json",
  "apps/target/next.config.ts",
  "apps/target/src",
  "config/demo.ts",
  "config/journeys/checkout-v1.ts",
  "config/profiles/indonesia-mobile-v1.json",
  "config/profiles/indonesia-mobile-v1.ts",
  "config/seeds/roveproof-demo-v1.ts",
  "package-lock.json",
] as const);

export const DEFAULT_PROJECTION_INPUTS = Object.freeze([
  "package.json",
  "vitest.config.ts",
  "scripts/roveproof-sandbox-runner.mjs",
  ...DEFAULT_SOURCE_REVISION_INPUTS,
  "apps/target/test/repair-mononym.test.mjs",
  "apps/target/test/repair-mononym-baseline-oracle.test.mjs",
  "apps/target/test/repair-mononym-invariants.test.mjs",
  "apps/target/test/checkout-behavior.test.ts",
] as const);

/**
 * Complete host-side trust manifest for the M5 admission boundary. These
 * files are not copied into the candidate projection; their immutable digest
 * prevents policy/orchestrator/smoke code from changing after analysis.
 */
export const DEFAULT_M5_TOOLING_INPUTS = Object.freeze([
  ...DEFAULT_PROJECTION_INPUTS,
  "tsconfig.json",
  "scripts/run-baseline.mjs",
  "scripts/run-model-smoke.mjs",
  "scripts/run-repair-smoke.mjs",
  "packages/contracts/package.json",
  "packages/contracts/tsconfig.json",
  "packages/contracts/src",
  "packages/evidence/package.json",
  "packages/evidence/tsconfig.json",
  "packages/evidence/src",
  "packages/journey/package.json",
  "packages/journey/tsconfig.json",
  "packages/journey/src",
  "packages/model-adapter/package.json",
  "packages/model-adapter/tsconfig.json",
  "packages/model-adapter/src",
  "packages/orchestrator/package.json",
  "packages/orchestrator/tsconfig.json",
  "packages/orchestrator/src",
  "packages/sandbox/package.json",
  "packages/sandbox/tsconfig.json",
  "packages/sandbox/src",
  "packages/store/package.json",
  "packages/store/tsconfig.json",
  "packages/store/src",
] as const);

export type SourceSnapshotOptions = Readonly<{
  repositoryRoot: string;
  baselineRunId: string;
  expectedIndexHash: string;
  expectedRootHash: string;
  analysisId: string;
  expectedAnalysisHash: string;
  expectedSourceRevision: string;
  expectedToolingRevision: string;
  projectionInputs?: readonly string[];
  toolingInputs?: readonly string[];
  temporaryRoot?: string;
}>;

export type SourceProjection = Readonly<{
  snapshot: SourceSnapshot;
  projectionDirectory: string;
  sourceRevisionBefore: string;
  sourceRevisionAfter: string;
  projectionRevisionBefore: string;
  projectionRevisionAfter: string;
  toolingRevisionBefore: string;
  toolingRevisionAfter: string;
}>;

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertSourceRelativePath(input: string): string {
  const relativePath = canonicalDiffPath(input);
  const segments = relativePath.split("/");
  if (
    segments.some((segment) => segment.startsWith(".env")) ||
    segments.includes(".git") ||
    segments.includes(".pi-subagents") ||
    segments.includes("node_modules") ||
    segments.includes("var") ||
    segments.some((segment) => /^(?:auth|credentials?|home)$/i.test(segment))
  ) {
    throw new DiffPolicyError(`source projection path is forbidden: ${relativePath}`);
  }
  return relativePath;
}

async function assertRealAncestor(root: string, relativePath: string): Promise<void> {
  const segments = relativePath.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new DiffPolicyError(`source projection ancestor is not a real directory: ${relativePath}`);
  }
}

async function collectFiles(root: string, input: string): Promise<string[]> {
  const relativePath = assertSourceRelativePath(input);
  const absolutePath = path.join(root, ...relativePath.split("/"));
  await assertRealAncestor(root, relativePath);
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink()) throw new DiffPolicyError(`source projection cannot contain symlinks: ${relativePath}`);
  if (metadata.isFile()) {
    if (metadata.nlink !== 1) throw new DiffPolicyError(`source projection cannot contain hard links: ${relativePath}`);
    return [relativePath];
  }
  if (!metadata.isDirectory()) throw new DiffPolicyError(`source projection entry is not regular: ${relativePath}`);
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = `${relativePath}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new DiffPolicyError(`source projection cannot contain symlinks: ${child}`);
    files.push(...await collectFiles(root, child));
  }
  return files;
}

async function collectInputFiles(root: string, inputs: readonly string[], allowMissing = false): Promise<string[]> {
  const files = (await Promise.all(inputs.map(async (input) => {
    try { return await collectFiles(root, input); }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }))).flat();
  const sorted = files.sort((left, right) => left.localeCompare(right));
  if (new Set(sorted).size !== sorted.length) throw new DiffPolicyError("source projection contains duplicate paths");
  return sorted;
}

type ProjectionTree = Readonly<{ files: readonly string[]; directories: readonly string[] }>;

async function collectProjectionTree(rootInput: string): Promise<ProjectionTree> {
  const root = path.resolve(rootInput);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new DiffPolicyError("source projection root must be a real directory");
  const files: string[] = [];
  const directories: string[] = [];
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const safe = assertSourceRelativePath(relative);
      const absolute = path.join(root, ...safe.split("/"));
      if (entry.isSymbolicLink()) throw new DiffPolicyError(`source projection cannot contain symlinks: ${safe}`);
      if (entry.isDirectory()) {
        directories.push(safe);
        await visit(absolute, safe);
      } else {
        if (!entry.isFile()) throw new DiffPolicyError(`source projection contains a special file: ${safe}`);
        const metadata = await lstat(absolute);
        if (metadata.nlink > 1) throw new DiffPolicyError(`source projection contains a hard link: ${safe}`);
        files.push(safe);
      }
    }
  }
  await visit(root, "");
  files.sort((left, right) => left.localeCompare(right));
  directories.sort((left, right) => left.localeCompare(right));
  return { files, directories };
}

async function hashFile(filePath: string): Promise<{ size: number; sha256: string }> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new DiffPolicyError(`source snapshot input is not a regular non-link file: ${filePath}`);
  if (metadata.size > MAX_SNAPSHOT_FILE_BYTES) throw new DiffPolicyError(`source snapshot file exceeds size policy: ${filePath}`);
  const hash = createHash("sha256");
  for await (const chunk of fsCreateReadStream(filePath)) hash.update(chunk);
  return { size: metadata.size, sha256: hash.digest("hex") };
}

async function revisionForFiles(root: string, files: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const relativePath of files) {
    const file = await hashFile(path.join(root, ...relativePath.split("/")));
    hash.update(`${relativePath}\0`);
    const content = await readFile(path.join(root, ...relativePath.split("/")));
    hash.update(content);
    hash.update("\0");
    if (file.size !== content.byteLength || sha256Bytes(content) !== file.sha256) throw new DiffPolicyError(`source changed during revision: ${relativePath}`);
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Compute the accepted source revision without consulting Git or a current HEAD. */
export async function computeNoGitSourceRevision(repositoryRootInput: string): Promise<string> {
  const repositoryRoot = path.resolve(repositoryRootInput);
  const files = await collectInputFiles(repositoryRoot, DEFAULT_SOURCE_REVISION_INPUTS);
  return revisionForFiles(repositoryRoot, files);
}

/** Compute the plain digest form used by M5 tooling bindings. */
async function toolingRevisionForFiles(root: string, files: readonly string[]): Promise<string> {
  return (await revisionForFiles(root, files)).slice("sha256:".length);
}

/** Compute the digest of the exact files copied into the candidate projection. */
export async function computeM5ProjectionRevision(
  repositoryRootInput: string,
  projectionInputs: readonly string[] = DEFAULT_PROJECTION_INPUTS,
): Promise<string> {
  const repositoryRoot = path.resolve(repositoryRootInput);
  const files = await collectInputFiles(repositoryRoot, projectionInputs);
  return toolingRevisionForFiles(repositoryRoot, files);
}

/**
 * Compute the complete host-side M5 trust digest. This is intentionally
 * separate from the journey source revision and the smaller Docker
 * projection revision.
 */
export async function computeM5ToolingRevision(
  repositoryRootInput: string,
  toolingInputs: readonly string[] = DEFAULT_M5_TOOLING_INPUTS,
): Promise<string> {
  const repositoryRoot = path.resolve(repositoryRootInput);
  const files = await collectInputFiles(repositoryRoot, toolingInputs);
  return toolingRevisionForFiles(repositoryRoot, files);
}

export const computeToolingRevision = computeM5ToolingRevision;

async function copyProjectionFile(sourceRoot: string, projectionRoot: string, relativePath: string): Promise<{ size: number; sha256: string }> {
  const sourcePath = path.join(sourceRoot, ...relativePath.split("/"));
  const destinationPath = path.join(projectionRoot, ...relativePath.split("/"));
  const sourceMetadata = await lstat(sourcePath);
  if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink() || sourceMetadata.nlink !== 1) throw new DiffPolicyError(`source projection input is not a regular non-link file: ${relativePath}`);
  await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
  const content = await readFile(sourcePath);
  const metadata = await hashFile(sourcePath);
  await writeFile(destinationPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const copied = await hashFile(destinationPath);
  if (copied.size !== metadata.size || copied.sha256 !== metadata.sha256) throw new DiffPolicyError(`source projection copy changed: ${relativePath}`);
  return metadata;
}

async function makeReadOnly(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await makeReadOnly(entryPath);
      await chmod(entryPath, 0o555);
    } else {
      const metadata = await lstat(entryPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new DiffPolicyError(`projection export contains a non-regular file: ${entry.name}`);
      await chmod(entryPath, 0o444);
    }
  }
  await chmod(root, 0o555);
}

async function snapshotHash(snapshot: Omit<SourceSnapshot, "snapshotHash">): Promise<string> {
  return sha256Bytes(Buffer.from(canonicalJson(snapshot), "utf8"));
}

export async function createSourceProjection(options: SourceSnapshotOptions): Promise<SourceProjection> {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const baselineRunId = EntityIdSchema.parse(options.baselineRunId);
  const analysisId = EntityIdSchema.parse(options.analysisId);
  const expectedIndexHash = Sha256Schema.parse(options.expectedIndexHash);
  const expectedRootHash = Sha256Schema.parse(options.expectedRootHash);
  const expectedAnalysisHash = Sha256Schema.parse(options.expectedAnalysisHash);
  const expectedToolingRevision = Sha256Schema.parse(options.expectedToolingRevision);
  const expectedSourceRevision = options.expectedSourceRevision;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64}|sha256:[a-f0-9]{64})$/.test(expectedSourceRevision)) throw new DiffPolicyError("an explicit source revision is required");
  const revisionFiles = await collectInputFiles(repositoryRoot, DEFAULT_SOURCE_REVISION_INPUTS);
  const sourceRevisionBefore = await revisionForFiles(repositoryRoot, revisionFiles);
  if (sourceRevisionBefore !== expectedSourceRevision) throw new DiffPolicyError("current source revision does not match the admitted expected revision");

  const projectionInputs = options.projectionInputs ?? DEFAULT_PROJECTION_INPUTS;
  // The default operational projection is mandatory. Fixture tests must pass
  // an explicit fixture list rather than silently omitting trusted files.
  const projectionFiles = await collectInputFiles(repositoryRoot, projectionInputs);
  const projectionRevisionBefore = await toolingRevisionForFiles(repositoryRoot, projectionFiles);
  const toolingInputs = options.toolingInputs ?? (options.projectionInputs ? projectionInputs : DEFAULT_M5_TOOLING_INPUTS);
  const toolingFiles = await collectInputFiles(repositoryRoot, toolingInputs);
  const toolingRevisionBefore = await toolingRevisionForFiles(repositoryRoot, toolingFiles);
  if (toolingRevisionBefore !== expectedToolingRevision) throw new DiffPolicyError("current M5 tooling revision does not match the admitted expected revision");
  const temporaryRoot = path.resolve(options.temporaryRoot ?? path.join(repositoryRoot, "var", "roveproof"));
  await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  const projectionDirectory = await mkdtemp(path.join(temporaryRoot, "m5-source-"));
  try {
    let totalSize = 0;
    const files: Array<{ path: string; size: number; sha256: string }> = [];
    for (const relativePath of projectionFiles) {
      const metadata = await copyProjectionFile(repositoryRoot, projectionDirectory, relativePath);
      totalSize += metadata.size;
      if (totalSize > MAX_SNAPSHOT_BYTES) throw new DiffPolicyError("source projection exceeds size policy");
      files.push({ path: relativePath, ...metadata });
    }
    const sourceRevisionAfter = await revisionForFiles(projectionDirectory, revisionFiles);
    const projectionRevisionAfter = await toolingRevisionForFiles(projectionDirectory, projectionFiles);
    const toolingRevisionAfter = await toolingRevisionForFiles(repositoryRoot, toolingFiles);
    if (sourceRevisionAfter !== sourceRevisionBefore) throw new DiffPolicyError("source revision changed while creating projection");
    if (projectionRevisionAfter !== projectionRevisionBefore) throw new DiffPolicyError("M5 projection changed while creating projection");
    if (toolingRevisionAfter !== toolingRevisionBefore) throw new DiffPolicyError("M5 tooling revision changed while creating projection");
    const toolingManifest: Array<{ path: string; size: number; sha256: string }> = [];
    for (const relativePath of toolingFiles) toolingManifest.push({ path: relativePath, ...(await hashFile(path.join(repositoryRoot, ...relativePath.split("/")))) });
    const withoutHash = {
      schemaVersion: 1 as const,
      recordVersion: "source-snapshot-v1" as const,
      sourceRevision: sourceRevisionBefore,
      projectionRevision: projectionRevisionBefore,
      toolingRevision: toolingRevisionBefore,
      toolingFiles: toolingManifest,
      baselineRunId,
      expectedIndexHash,
      expectedRootHash,
      analysisId,
      expectedAnalysisHash,
      files,
    };
    const snapshot = SourceSnapshotSchema.parse({ ...withoutHash, snapshotHash: await snapshotHash(withoutHash) });
    await verifySourceProjection(projectionDirectory, snapshot);
    await verifyM5ToolingSnapshot(repositoryRoot, snapshot, toolingInputs);
    await makeReadOnly(projectionDirectory);
    return { snapshot, projectionDirectory, sourceRevisionBefore, sourceRevisionAfter, projectionRevisionBefore, projectionRevisionAfter, toolingRevisionBefore, toolingRevisionAfter };
  } catch (error) {
    try {
      await rm(projectionDirectory, { recursive: true, force: true });
      await lstat(projectionDirectory).then(() => { throw new DiffPolicyError("source projection cleanup failed"); }).catch((cleanupError) => {
        if (cleanupError instanceof DiffPolicyError) throw cleanupError;
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw new DiffPolicyError("source projection cleanup failed");
      });
    } catch (cleanupError) {
      if (cleanupError instanceof DiffPolicyError) throw cleanupError;
      throw new DiffPolicyError("source projection cleanup failed");
    }
    throw error;
  }
}

export async function verifySourceProjection(projectionDirectoryInput: string, snapshotInput: unknown): Promise<SourceSnapshot> {
  const snapshot = SourceSnapshotSchema.parse(snapshotInput);
  const projectionDirectory = path.resolve(projectionDirectoryInput);
  const expectedFiles = snapshot.files.map(({ path: relativePath }) => relativePath);
  const expectedDirectories = [...new Set(expectedFiles.flatMap((file) => {
    const segments = file.split("/");
    return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
  }))].sort((left, right) => left.localeCompare(right));
  const actualTree = await collectProjectionTree(projectionDirectory);
  if (JSON.stringify(actualTree.files) !== JSON.stringify(expectedFiles) || JSON.stringify(actualTree.directories) !== JSON.stringify(expectedDirectories)) {
    throw new DiffPolicyError("source projection recursive file set changed");
  }
  const observedFiles = [] as Array<{ path: string; size: number; sha256: string }>;
  for (const relativePath of expectedFiles) {
    const metadata = await hashFile(path.join(projectionDirectory, ...relativePath.split("/")));
    observedFiles.push({ path: relativePath, ...metadata });
  }
  if (JSON.stringify(observedFiles) !== JSON.stringify(snapshot.files)) throw new DiffPolicyError("source snapshot file hash changed");
  const revisionInputs = DEFAULT_SOURCE_REVISION_INPUTS.flatMap((input) => expectedFiles.filter((file) => file === input || file.startsWith(`${input}/`)));
  const observedRevision = await revisionForFiles(projectionDirectory, [...new Set(revisionInputs)].sort((left, right) => left.localeCompare(right)));
  if (observedRevision !== snapshot.sourceRevision) throw new DiffPolicyError("source snapshot revision changed");
  const observedProjectionRevision = await toolingRevisionForFiles(projectionDirectory, expectedFiles);
  if (observedProjectionRevision !== snapshot.projectionRevision) throw new DiffPolicyError("source snapshot projection revision changed");
  const withoutHash = { ...snapshot } as Omit<SourceSnapshot, "snapshotHash"> & { snapshotHash?: string };
  delete withoutHash.snapshotHash;
  if (await snapshotHash(withoutHash) !== snapshot.snapshotHash) throw new DiffPolicyError("source snapshot content hash is invalid");
  return snapshot;
}

export async function verifyM5ToolingSnapshot(
  repositoryRootInput: string,
  snapshotInput: unknown,
  toolingInputs: readonly string[] = DEFAULT_M5_TOOLING_INPUTS,
): Promise<SourceSnapshot> {
  const snapshot = SourceSnapshotSchema.parse(snapshotInput);
  const repositoryRoot = path.resolve(repositoryRootInput);
  const toolingFiles = await collectInputFiles(repositoryRoot, toolingInputs);
  const expectedPaths = snapshot.toolingFiles.map(({ path: relativePath }) => relativePath);
  if (JSON.stringify(toolingFiles) !== JSON.stringify(expectedPaths)) throw new DiffPolicyError("M5 tooling manifest file set changed");
  const observedFiles: Array<{ path: string; size: number; sha256: string }> = [];
  for (const relativePath of toolingFiles) observedFiles.push({ path: relativePath, ...(await hashFile(path.join(repositoryRoot, ...relativePath.split("/")))) });
  if (JSON.stringify(observedFiles) !== JSON.stringify(snapshot.toolingFiles)) throw new DiffPolicyError("M5 tooling manifest file hash changed");
  if (await toolingRevisionForFiles(repositoryRoot, toolingFiles) !== snapshot.toolingRevision) throw new DiffPolicyError("M5 tooling revision changed");
  return snapshot;
}

export async function removeSourceProjection(projectionDirectory: string): Promise<void> {
  const resolved = path.resolve(projectionDirectory);
  await rm(resolved, { recursive: true, force: true });
  try {
    await lstat(resolved);
    throw new DiffPolicyError("source projection cleanup failed");
  } catch (error) {
    if (error instanceof DiffPolicyError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new DiffPolicyError("source projection cleanup failed");
  }
}
