import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AnalysisReportSchema, CODEX_MODEL } from "@roveproof/contracts";
import {
  AnalysisUnavailableError,
  analyzeEvidence,
  type BoundedProcessRequest,
  type BoundedProcessResult,
} from "../src/index.js";
import { createFakeRunner, createSyntheticAdmittedBundle, validModelOutput } from "./helpers.js";

const roots: string[] = [];
const command = { executable: "trusted-codex", prefixArgs: [] } as const;

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "roveproof-model-test-"));
  roots.push(root);
  const bundle = await createSyntheticAdmittedBundle(root);
  return { root, bundle };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("evidence analyzer", () => {
  it("returns trusted provenance around schema-valid, citation-bound model output", async () => {
    const { root, bundle } = await setup();
    const calls: BoundedProcessRequest[] = [];
    const result = await analyzeEvidence({
      analysisId: "analysis-001",
      baselineRunId: bundle.manifest.runId,
      bundleDirectory: bundle.directory,
      toolingRevision: "a".repeat(64),
      temporaryRoot: root,
      parentEnvironment: { PATH: "safe", SECRET_TOKEN: "drop-me" },
      command,
      runner: createFakeRunner({ calls }),
      admit: async () => bundle,
    });

    expect(AnalysisReportSchema.safeParse(result.report).success).toBe(true);
    expect(result.report).toMatchObject({
      mode: "real",
      backend: "codex-cli-chatgpt",
      authMode: "chatgpt-subscription",
      cliVersion: "0.139.0",
      model: CODEX_MODEL,
      terminalStatus: "turn.completed",
      retryCount: 0,
      toolingRevision: "a".repeat(64),
    });
    expect(result.report.hypotheses).toHaveLength(3);
    expect(result.report.inputArtifacts).toHaveLength(10);
    expect(result.attempts[0]).toMatchObject({ status: "SUCCESS", errorCode: null, retryable: false });

    const invocation = calls.at(-1);
    expect(invocation?.args).toEqual(expect.arrayContaining([
      "exec", "--ephemeral", "--json", "--sandbox", "read-only",
      "--ignore-user-config", "--ignore-rules", "--disable", "shell_tool",
    ]));
    expect(invocation?.args).toEqual(expect.arrayContaining(["--model", CODEX_MODEL]));
    expect(invocation?.env.SECRET_TOKEN).toBeUndefined();
    expect(invocation?.stdin).toContain("EVIDENCE_DOSSIER_JSON");
    expect(invocation?.args.filter((value) => value === "--image")).toHaveLength(2);
    const removedWorkspace = path.dirname(invocation?.cwd ?? "");
    await expect(access(removedWorkspace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires exactly one failed verifier assertion for every frozen seed before preflight", async () => {
    const { root, bundle } = await setup();
    const seedAssertions = bundle.assertions.assertions;
    const variants = [
      seedAssertions.slice(0, 2),
      seedAssertions.map((assertion, index) => index === 1 ? { ...assertion, status: "PASS" as const } : assertion),
      seedAssertions.map((assertion, index) => index === 2 ? { ...assertion, seedId: seedAssertions[1]?.seedId } : assertion),
    ];
    for (const assertions of variants) {
      let calls = 0;
      const invalidBundle = {
        ...bundle,
        assertions: { ...bundle.assertions, assertions },
      };
      await expect(analyzeEvidence({
        analysisId: "analysis-seed-gate",
        baselineRunId: bundle.manifest.runId,
        bundleDirectory: bundle.directory,
        temporaryRoot: root,
        parentEnvironment: { PATH: "safe" },
        command,
        runner: async () => {
          calls += 1;
          throw new Error("must not spawn");
        },
        admit: async () => invalidBundle,
      })).rejects.toMatchObject({ code: "MODEL_EVIDENCE_REJECTED" });
      expect(calls).toBe(0);
    }
  });

  it("rejects prohibited API credentials before spawning Codex", async () => {
    const { root, bundle } = await setup();
    let calls = 0;
    await expect(analyzeEvidence({
      analysisId: "analysis-002",
      baselineRunId: bundle.manifest.runId,
      bundleDirectory: bundle.directory,
      temporaryRoot: root,
      parentEnvironment: { PATH: "safe", OPENAI_API_KEY: "" },
      command,
      runner: async () => {
        calls += 1;
        throw new Error("must not spawn");
      },
      admit: async () => bundle,
    })).rejects.toMatchObject({ code: "MODEL_ENV_FORBIDDEN", attempts: [{ status: "FAILURE", errorCode: "MODEL_ENV_FORBIDDEN" }] });
    expect(calls).toBe(0);
  });

  it("fails closed for an unadmitted path or invented evidence fragment", async () => {
    const { root, bundle } = await setup();
    for (const reference of ["invented.json", "assertions.json#definitely-not-real"]) {
      const invalidOutput = {
        ...validModelOutput,
        hypotheses: validModelOutput.hypotheses.map((hypothesis, index) => index === 0
          ? { ...hypothesis, artifactRefs: [reference] }
          : hypothesis),
      };
      await expect(analyzeEvidence({
        analysisId: "analysis-003",
        baselineRunId: bundle.manifest.runId,
        bundleDirectory: bundle.directory,
        temporaryRoot: root,
        parentEnvironment: { PATH: "safe" },
        command,
        runner: createFakeRunner({ output: invalidOutput }),
        admit: async () => bundle,
      })).rejects.toMatchObject({ code: "MODEL_CITATION_INVALID", attempts: [{ errorCode: "MODEL_CITATION_INVALID" }] });
    }
  });

  it("classifies a schema-valid completed-turn refusal instead of publishing it", async () => {
    const { root, bundle } = await setup();
    const refusalOutput = {
      ...validModelOutput,
      hypotheses: validModelOutput.hypotheses.map((hypothesis) => ({
        ...hypothesis,
        explanation: "I cannot assist with this analysis.",
      })),
      recommendedRegressionAssertion: "I refuse to provide an assertion.",
    };
    await expect(analyzeEvidence({
      analysisId: "analysis-refusal",
      baselineRunId: bundle.manifest.runId,
      bundleDirectory: bundle.directory,
      temporaryRoot: root,
      parentEnvironment: { PATH: "safe" },
      command,
      runner: createFakeRunner({ output: refusalOutput }),
      admit: async () => bundle,
    })).rejects.toMatchObject({
      code: "MODEL_REFUSAL",
      attempts: [{ status: "FAILURE", errorCode: "MODEL_REFUSAL", threadId: "123e4567-e89b-42d3-a456-426614174000" }],
    });
  });

  it("turns a child stdin failure into a sanitized attempt and cleans the workspace", async () => {
    const { root, bundle } = await setup();
    const calls: BoundedProcessRequest[] = [];
    const ioFailure: BoundedProcessResult = {
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      durationMs: 1,
      timedOut: false,
      outputLimitExceeded: false,
      spawnErrorCode: null,
      ioErrorCode: "EPIPE",
      terminationFailed: false,
    };
    await expect(analyzeEvidence({
      analysisId: "analysis-io-failure",
      baselineRunId: bundle.manifest.runId,
      bundleDirectory: bundle.directory,
      temporaryRoot: root,
      parentEnvironment: { PATH: "safe" },
      command,
      runner: createFakeRunner({ calls, execResult: ioFailure }),
      admit: async () => bundle,
    })).rejects.toMatchObject({
      code: "MODEL_PROCESS_EXIT",
      attempts: [{ status: "FAILURE", errorCode: "MODEL_PROCESS_EXIT" }],
    });
    const invocation = calls.find(({ args }) => args[0] === "exec");
    await expect(access(path.dirname(invocation?.cwd ?? ""))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("classifies subscription quota exhaustion without falling back", async () => {
    const { root, bundle } = await setup();
    const exhausted: BoundedProcessResult = {
      stdout: "",
      stderr: "Usage limit reached for this subscription",
      exitCode: 1,
      signal: null,
      durationMs: 1,
      timedOut: false,
      outputLimitExceeded: false,
      spawnErrorCode: null,
      ioErrorCode: null,
      terminationFailed: false,
    };
    const calls: BoundedProcessRequest[] = [];
    await expect(analyzeEvidence({
      analysisId: "analysis-004",
      baselineRunId: bundle.manifest.runId,
      bundleDirectory: bundle.directory,
      temporaryRoot: root,
      parentEnvironment: { PATH: "safe" },
      command,
      runner: createFakeRunner({ calls, execResult: exhausted }),
      admit: async () => bundle,
    })).rejects.toMatchObject({
      code: "MODEL_QUOTA_EXHAUSTED",
      attempts: [{ status: "FAILURE", errorCode: "MODEL_QUOTA_EXHAUSTED", retryable: false }],
    });
    expect(calls.filter(({ args }) => args[0] === "exec")).toHaveLength(1);
  });

  it("detects copied evidence tampering and removes the workspace", async () => {
    const { root, bundle } = await setup();
    let workspaceRoot = "";
    try {
      await analyzeEvidence({
        analysisId: "analysis-005",
        baselineRunId: bundle.manifest.runId,
        bundleDirectory: bundle.directory,
        temporaryRoot: root,
        parentEnvironment: { PATH: "safe" },
        command,
        runner: createFakeRunner({
          beforeExecReturn: async (request) => {
            workspaceRoot = path.dirname(request.cwd);
            const metricsPath = path.join(request.cwd, "metrics.json");
            await chmod(metricsPath, 0o600);
            await writeFile(metricsPath, "tampered");
          },
        }),
        admit: async () => bundle,
      });
      expect.fail("Expected tamper rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AnalysisUnavailableError);
      expect(error).toMatchObject({ code: "MODEL_WORKSPACE_TAMPERED" });
    }
    await expect(access(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
