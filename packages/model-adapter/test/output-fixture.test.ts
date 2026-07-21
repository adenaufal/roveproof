import { describe, expect, it } from "vitest";
import { AnalysisReportSchema, FixtureAnalysisSchema, SEED_IDS } from "@roveproof/contracts";
import {
  ANALYSIS_OUTPUT_JSON_SCHEMA,
  ANALYSIS_PROMPT_TEMPLATE_HASH,
  analysisOutputSchemaBytes,
  createFixtureAnalysis,
  renderAnalysisPrompt,
  sha256,
} from "../src/index.js";

const dossier = {
  baselineRunId: "run-001",
  fixedScope: {
    targetId: "seeded-checkout-v1" as const,
    journeyId: "checkout-v1" as const,
    profileId: "indonesia-mobile-v1" as const,
    seedIds: [...SEED_IDS],
    sampleCount: 1 as const,
  },
  allowedArtifactRefs: ["assertions.json"],
  inputArtifacts: [{ path: "assertions.json", size: 1, sha256: "a".repeat(64) }],
  textArtifacts: { "assertions.json": "{}" },
  binaryEvidence: [],
};

describe("analysis output and fixture adapters", () => {
  it("emits deterministic versioned schema and prompt bytes", () => {
    expect(JSON.parse(analysisOutputSchemaBytes())).toEqual(ANALYSIS_OUTPUT_JSON_SCHEMA);
    expect(sha256(analysisOutputSchemaBytes())).toMatch(/^[a-f0-9]{64}$/);
    expect(ANALYSIS_PROMPT_TEMPLATE_HASH).toMatch(/^[a-f0-9]{64}$/);
    expect(renderAnalysisPrompt(dossier)).toContain(JSON.stringify(dossier));
    expect(renderAnalysisPrompt(dossier)).toContain("Do not call or request any tool");
  });

  it("returns explicit rehearsal-only analysis that cannot parse as real", () => {
    const fixture = createFixtureAnalysis({ analysisId: "analysis-fixture-001", baselineRunId: "run-fixture-001" });
    expect(FixtureAnalysisSchema.safeParse(fixture).success).toBe(true);
    expect(AnalysisReportSchema.safeParse(fixture).success).toBe(false);
    expect(fixture.mode).toBe("fixture");
    expect(fixture.approvalAllowed).toBe(false);
  });
});
