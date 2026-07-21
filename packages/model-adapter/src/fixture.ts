import {
  FIXTURE_ANALYSIS_VERSION,
  FixtureAnalysisSchema,
  SCHEMA_VERSION,
  SEED_IDS,
  type FixtureAnalysis,
} from "@roveproof/contracts";

export function createFixtureAnalysis(input: Readonly<{ analysisId: string; baselineRunId: string }>): FixtureAnalysis {
  return FixtureAnalysisSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    recordVersion: FIXTURE_ANALYSIS_VERSION,
    mode: "fixture",
    provenance: "fixture",
    fixtureVersion: "golden-control-v1",
    analysisId: input.analysisId,
    baselineRunId: input.baselineRunId,
    hypotheses: [
      {
        rank: 1,
        code: SEED_IDS[0],
        explanation: "Fixture diagnosis: the legal mononym is blocked by a required last-name assumption.",
        artifactRefs: ["assertions.json#seed.mononym-required-last-name", "screenshots/failure-or-confirmation.png"],
        falsifier: "A mononymous fixture customer completes checkout without inventing a surname.",
      },
      {
        rank: 2,
        code: SEED_IDS[1],
        explanation: "Fixture diagnosis: the valid +62 number is rejected before Indonesian normalization.",
        artifactRefs: ["assertions.json#seed.phone-plus62-normalization", "screenshots/failure-or-confirmation.png"],
        falsifier: "The fixed +62 fixture number is normalized and accepted.",
      },
      {
        rank: 3,
        code: SEED_IDS[2],
        explanation: "Fixture diagnosis: eager recommendations dominate the checkout transfer budget.",
        artifactRefs: ["assertions.json#seed.mobile-heavy-checkout-bundle", "requests.jsonl", "metrics.json"],
        falsifier: "The same fixture checkout transfers no more than the frozen verified budget.",
      },
    ],
    recommendedRegressionAssertion: "The fixed Indonesia Mobile checkout accepts Naufal and +62 812-3456-7890, creates exactly one order, and remains within the frozen transfer and duration budgets.",
    uncertainty: ["This is rehearsal-only fixture analysis and is not a real model observation."],
    approvalAllowed: false,
  });
}
