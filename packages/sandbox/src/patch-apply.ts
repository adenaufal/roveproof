import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  M5_CANDIDATE_COMMAND_ID,
  M5_MONONYM_ASSERTION_FRAGMENT,
  M5_MONONYM_ASSERTION_ID,
  M5_TEST_COMMAND_ID,
  SandboxControlSchema,
  SourceSnapshotSchema,
  hashSandboxControl,
  type SandboxControl,
  type SourceSnapshot,
} from "@roveproof/contracts";
import { canonicalDiffPath, DiffPolicyError, type ParsedDiffFile, type ParsedUnifiedDiff } from "./diff-policy.js";

export type ApplyDiffOptions = Readonly<{
  workspaceDirectory: string;
  snapshot: SourceSnapshot;
  parsedDiff: ParsedUnifiedDiff;
}>;

export type AppliedDiff = Readonly<{
  operation: ParsedUnifiedDiff["operation"];
  diffHash: string;
  files: readonly string[];
}>;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function assertRealDirectory(directoryInput: string): Promise<string> {
  const directory = path.resolve(directoryInput);
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new DiffPolicyError("patch workspace must be a real directory");
  return directory;
}

async function assertRegularFile(filePath: string, label: string): Promise<void> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1) throw new DiffPolicyError(`${label} must be a regular non-link file`);
}

function snapshotFile(snapshot: SourceSnapshot, relativePath: string) {
  return snapshot.files.find(({ path: filePath }) => filePath === relativePath);
}

function applyFileContent(original: string, file: ParsedDiffFile): string {
  const lines = original.split("\n");
  const output: string[] = [];
  let cursor = 0;
  for (const hunk of file.hunks) {
    const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (start < cursor || start > lines.length) throw new DiffPolicyError(`hunk start is outside ${file.path}`);
    output.push(...lines.slice(cursor, start));
    let sourceIndex = start;
    for (const patchLine of hunk.lines) {
      const marker = patchLine[0];
      const content = patchLine.slice(1);
      if (marker === "+") {
        output.push(content);
      } else if (marker === " ") {
        if (lines[sourceIndex] !== content) throw new DiffPolicyError(`hunk context mismatch in ${file.path}`);
        output.push(lines[sourceIndex]!);
        sourceIndex += 1;
      } else if (marker === "-") {
        if (lines[sourceIndex] !== content) throw new DiffPolicyError(`hunk deletion mismatch in ${file.path}`);
        sourceIndex += 1;
      } else {
        throw new DiffPolicyError(`unsupported hunk marker in ${file.path}`);
      }
    }
    cursor = sourceIndex;
  }
  output.push(...lines.slice(cursor));
  return output.join("\n");
}

/** Apply a previously policy-admitted diff only inside an explicit disposable workspace. */
export async function applyParsedDiff(options: ApplyDiffOptions): Promise<AppliedDiff> {
  const workspaceDirectory = await assertRealDirectory(options.workspaceDirectory);
  const snapshot = SourceSnapshotSchema.parse(options.snapshot);
  if (options.parsedDiff.operation !== "test-only" && options.parsedDiff.operation !== "source-only") throw new DiffPolicyError("unknown diff operation");
  for (const file of options.parsedDiff.files) {
    const relativePath = canonicalDiffPath(file.path);
    const destination = path.resolve(workspaceDirectory, ...relativePath.split("/"));
    if (!contained(workspaceDirectory, destination) || destination === workspaceDirectory) throw new DiffPolicyError(`diff path escapes workspace: ${relativePath}`);
    const base = snapshotFile(snapshot, relativePath);
    if (!base) throw new DiffPolicyError(`diff path is absent from the immutable snapshot: ${relativePath}`);
    await assertRegularFile(destination, `patch target ${relativePath}`);
    const originalBytes = await readFile(destination);
    if (originalBytes.byteLength !== base.size || sha256(originalBytes) !== base.sha256) throw new DiffPolicyError(`base hash mismatch for ${relativePath}`);
    const next = applyFileContent(originalBytes.toString("utf8"), file);
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${Date.now()}.patch`);
    await writeFile(temporary, next, { flag: "wx", mode: 0o600 });
    try {
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return { operation: options.parsedDiff.operation, diffHash: options.parsedDiff.diffHash, files: options.parsedDiff.files.map(({ path: filePath }) => filePath) };
}

/** Deterministically combine the two operation-specific canonical diff byte streams. */
export function combineAuthoringDiffs(testDiff: ParsedUnifiedDiff, sourceDiff: ParsedUnifiedDiff): { bytes: Buffer; hash: string; files: number; additions: number; deletions: number; changedLines: number } {
  if (testDiff.operation !== "test-only" || sourceDiff.operation !== "source-only") throw new DiffPolicyError("combined diffs must be test-only followed by source-only");
  const paths = [...testDiff.files, ...sourceDiff.files].map(({ path: filePath }) => filePath);
  if (new Set(paths.map((filePath) => filePath.toLowerCase())).size !== paths.length) throw new DiffPolicyError("combined diffs contain duplicate or case-alias paths");
  const additions = testDiff.metadata.additions + sourceDiff.metadata.additions;
  const deletions = testDiff.metadata.deletions + sourceDiff.metadata.deletions;
  const changedLines = additions + deletions;
  if (paths.length > 5) throw new DiffPolicyError(`combined file budget exceeded: ${paths.length} > 5`);
  if (changedLines > 250) throw new DiffPolicyError(`combined changed-line budget exceeded: ${changedLines} > 250`);
  const bytes = Buffer.concat([testDiff.canonicalBytes, Buffer.from("\n", "utf8"), sourceDiff.canonicalBytes]);
  return { bytes, hash: sha256(bytes), files: paths.length, additions, deletions, changedLines };
}

/** Build a host-controlled stdin envelope; model output never chooses command or stage fields. */
export function createSandboxControl(input: Readonly<{
  stage: "test-proof" | "combined";
  snapshot: SourceSnapshot;
  testDiff: ParsedUnifiedDiff;
  sourceDiff?: ParsedUnifiedDiff;
  combinedDiff?: Readonly<{ bytes: Uint8Array; hash: string }>;
}>): SandboxControl {
  const snapshot = SourceSnapshotSchema.parse(input.snapshot);
  if (input.testDiff.operation !== "test-only") throw new DiffPolicyError("sandbox test control requires a test-only diff");
  if (input.stage === "combined" && (!input.sourceDiff || !input.combinedDiff || input.sourceDiff.operation !== "source-only")) throw new DiffPolicyError("combined sandbox control requires source and combined diffs");
  const sourceBytes = input.sourceDiff?.canonicalBytes ?? null;
  const sourceHash = input.sourceDiff?.diffHash ?? null;
  const combinedBytes = input.combinedDiff?.bytes ?? null;
  const combinedHash = input.combinedDiff?.hash ?? null;
  const withoutHash = {
    schemaVersion: 1 as const,
    recordVersion: "sandbox-control-v1" as const,
    stage: input.stage,
    commandId: input.stage === "test-proof" ? M5_TEST_COMMAND_ID : M5_CANDIDATE_COMMAND_ID,
    sourceSnapshotHash: snapshot.snapshotHash,
    snapshotFiles: snapshot.files,
    testDiffBase64: input.testDiff.canonicalBytes.toString("base64"),
    testDiffHash: input.testDiff.diffHash,
    sourceDiffBase64: sourceBytes ? Buffer.from(sourceBytes).toString("base64") : null,
    sourceDiffHash: sourceHash,
    combinedDiffBase64: combinedBytes ? Buffer.from(combinedBytes).toString("base64") : null,
    combinedDiffHash: combinedHash,
    toolingRevision: snapshot.toolingRevision,
    expectedSeedId: "ID-MONONYM-REQUIRED-LAST-NAME" as const,
    assertionId: M5_MONONYM_ASSERTION_ID,
    assertionFragment: M5_MONONYM_ASSERTION_FRAGMENT,
  };
  const control = SandboxControlSchema.parse({ ...withoutHash, controlHash: hashSandboxControl(withoutHash) });
  return control;
}

/** Copy a verified projection to a fresh disposable directory for deterministic harness tests. */
export async function copyProjectionToWorkspace(sourceDirectoryInput: string, temporaryRootInput = os.tmpdir()): Promise<{ root: string; workspaceDirectory: string }> {
  const sourceDirectory = await assertRealDirectory(sourceDirectoryInput);
  const temporaryRoot = await assertRealDirectory(temporaryRootInput);
  const root = await mkdtemp(path.join(temporaryRoot, "roveproof-apply-"));
  const workspaceDirectory = path.join(root, "tree");
  await mkdir(workspaceDirectory, { recursive: true, mode: 0o700 });
  async function copy(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const source = path.join(sourceDirectory, ...relative.split("/"));
      const target = path.join(workspaceDirectory, ...relative.split("/"));
      if (entry.isSymbolicLink()) throw new DiffPolicyError(`projection contains a symlink: ${relative}`);
      if (entry.isDirectory()) {
        await mkdir(target, { recursive: true, mode: 0o700 });
        await copy(source, relative);
      } else {
        await assertRegularFile(source, `projection file ${relative}`);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, await readFile(source), { flag: "wx", mode: 0o600 });
        await chmod(target, 0o600);
      }
    }
  }
  try {
    await copy(sourceDirectory, "");
    return { root, workspaceDirectory };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}