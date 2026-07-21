#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeTargetSourceRevision } from "./source-revision.js";
import { runBaseline } from "./runner.js";

type CliOptions = {
  targetUrl: string;
  artifactRoot: string;
  runId?: string;
  headless: boolean;
};

function parseArguments(arguments_: readonly string[]): CliOptions {
  const options: CliOptions = {
    targetUrl: "http://127.0.0.1:3001/checkout",
    artifactRoot: path.resolve("var", "roveproof"),
    headless: true,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--headed") {
      options.headless = false;
      continue;
    }
    const value = arguments_[index + 1];
    if (!value) throw new Error(`Missing value for ${argument}`);
    if (argument === "--target-url") options.targetUrl = value;
    else if (argument === "--artifact-root") options.artifactRoot = path.resolve(value);
    else if (argument === "--run-id") options.runId = value;
    else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  return options;
}

const cli = parseArguments(process.argv.slice(2));
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const sourceRevision = await computeTargetSourceRevision(repositoryRoot);
const output = await runBaseline({ ...cli, sourceRevision });
const { result, manifest } = output.bundle;
console.log(`Evidence run: ${output.runId}`);
console.log(`Bundle: ${output.bundle.directory}`);
console.log(`Verdict: ${result.verdict}`);
console.log(`Transfer: ${result.performance.transferredBytes} bytes (${(result.performance.transferredBytes / 1_000_000).toFixed(1)} MB)`);
console.log(`Duration: ${(result.task.durationMs / 1_000).toFixed(1)} s`);
console.log(`Profile verified: ${manifest.runtime.profileVerified ? "yes" : "no"}`);
if (result.verdict === "INCONCLUSIVE") process.exitCode = 2;
