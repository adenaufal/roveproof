import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareEmptyArtifactRoot } from "./reset-safety.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const artifactRoot = await prepareEmptyArtifactRoot(repositoryRoot);

console.log(`Prepared empty local artifact directory at ${artifactRoot}.`);
console.log(
  "Milestone 0 reset is fail-closed: it will not recursively delete artifacts until the artifact store owns a verified cleanup policy.",
);
