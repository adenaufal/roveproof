import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareEmptyArtifactRoot } from "./reset-safety.mjs";

const temporaryRoots = [];

async function createTemporaryDirectory(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("safe demo reset root", () => {
  it("creates only the empty repository artifact root", async () => {
    const repositoryRoot = await createTemporaryDirectory("roveproof-reset-safe-");
    await expect(prepareEmptyArtifactRoot(repositoryRoot)).resolves.toBe(join(repositoryRoot, "var", "roveproof"));
  });

  it("rejects a symlink or junction used as the var ancestor", async () => {
    const repositoryRoot = await createTemporaryDirectory("roveproof-reset-repo-");
    const externalRoot = await createTemporaryDirectory("roveproof-reset-external-");
    await symlink(externalRoot, join(repositoryRoot, "var"), process.platform === "win32" ? "junction" : "dir");

    await expect(prepareEmptyArtifactRoot(repositoryRoot)).rejects.toThrow(/symlink or junction/);
  });

  it("rejects a symlink or junction used as the artifact root", async () => {
    const repositoryRoot = await createTemporaryDirectory("roveproof-reset-repo-");
    const externalRoot = await createTemporaryDirectory("roveproof-reset-external-");
    await mkdir(join(repositoryRoot, "var"));
    await symlink(externalRoot, join(repositoryRoot, "var", "roveproof"), process.platform === "win32" ? "junction" : "dir");

    await expect(prepareEmptyArtifactRoot(repositoryRoot)).rejects.toThrow(/symlink or junction/);
  });

  it("refuses to delete a nonempty artifact root", async () => {
    const repositoryRoot = await createTemporaryDirectory("roveproof-reset-nonempty-");
    const artifactRoot = join(repositoryRoot, "var", "roveproof");
    const sentinel = join(artifactRoot, "keep.txt");
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(sentinel, "keep");

    await expect(prepareEmptyArtifactRoot(repositoryRoot)).rejects.toThrow(/Refusing automated recursive deletion/);
    await expect(writeFile(sentinel, "still-present")).resolves.toBeUndefined();
  });
});
