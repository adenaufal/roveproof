import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

const SOURCE_INPUTS = [
  "apps/target/package.json",
  "apps/target/next.config.ts",
  "apps/target/src",
  "config/demo.ts",
  "config/journeys/checkout-v1.ts",
  "config/profiles/indonesia-mobile-v1.json",
  "config/profiles/indonesia-mobile-v1.ts",
  "config/seeds/roveproof-demo-v1.ts",
  "package-lock.json",
] as const;

async function collectFiles(repositoryRoot: string, relativePath: string): Promise<string[]> {
  const absolutePath = path.join(repositoryRoot, ...relativePath.split("/"));
  const fileStats = await lstat(absolutePath);
  if (fileStats.isSymbolicLink()) throw new Error(`Source revision inputs cannot contain symbolic links: ${relativePath}`);
  if (fileStats.isFile()) return [relativePath];
  if (!fileStats.isDirectory()) throw new Error(`Invalid source revision input: ${relativePath}`);

  const entries = await readdir(absolutePath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    files.push(...await collectFiles(repositoryRoot, `${relativePath}/${entry.name}`));
  }
  return files;
}

export async function computeTargetSourceRevision(repositoryRootInput: string): Promise<string> {
  const repositoryRoot = path.resolve(repositoryRootInput);
  const files = (await Promise.all(SOURCE_INPUTS.map((input) => collectFiles(repositoryRoot, input))))
    .flat()
    .sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  for (const relativePath of files) {
    hash.update(`${relativePath}\0`);
    for await (const chunk of createReadStream(path.join(repositoryRoot, ...relativePath.split("/")))) hash.update(chunk);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
