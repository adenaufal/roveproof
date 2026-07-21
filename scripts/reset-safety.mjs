import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { normalize, relative, resolve } from "node:path";

function isMissing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function samePath(left, right) {
  const normalizeForPlatform = (value) => {
    const normalized = normalize(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalizeForPlatform(left) === normalizeForPlatform(right);
}

async function assertRealDirectory(path, label) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Refusing reset: ${label} must be a real directory, not a symlink or junction`);
  }

  const canonicalPath = await realpath(path);
  if (!samePath(canonicalPath, path)) {
    throw new Error(`Refusing reset: ${label} resolves outside its expected canonical path`);
  }
}

async function ensureRealDirectory(path, label) {
  try {
    await assertRealDirectory(path, label);
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(path);
    await assertRealDirectory(path, label);
  }
}

export async function prepareEmptyArtifactRoot(repositoryRootInput) {
  const repositoryRoot = resolve(repositoryRootInput);
  const varRoot = resolve(repositoryRoot, "var");
  const artifactRoot = resolve(varRoot, "roveproof");

  if (relative(repositoryRoot, artifactRoot) !== normalize("var/roveproof")) {
    throw new Error("Refusing reset outside the repository var/roveproof directory");
  }

  await assertRealDirectory(repositoryRoot, "repository root");
  await ensureRealDirectory(varRoot, "repository var directory");
  await ensureRealDirectory(artifactRoot, "Roveproof artifact directory");

  const entries = await readdir(artifactRoot);
  if (entries.length > 0) {
    throw new Error(
      "Refusing automated recursive deletion: var/roveproof is not empty. Milestone 0 has no artifact-store-owned cleanup policy yet.",
    );
  }

  return artifactRoot;
}
