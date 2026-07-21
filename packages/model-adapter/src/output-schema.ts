import { createHash } from "node:crypto";
import { ANALYSIS_OUTPUT_VERSION, SEED_IDS } from "@roveproof/contracts";

export const ANALYSIS_OUTPUT_JSON_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `https://roveproof.local/schemas/${ANALYSIS_OUTPUT_VERSION}`,
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "hypotheses", "recommendedRegressionAssertion", "uncertainty"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    hypotheses: {
      type: "array",
      minItems: SEED_IDS.length,
      maxItems: SEED_IDS.length,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["rank", "code", "explanation", "artifactRefs", "falsifier"],
        properties: {
          rank: { type: "integer", minimum: 1, maximum: SEED_IDS.length },
          code: { type: "string", enum: [...SEED_IDS] },
          explanation: { type: "string" },
          artifactRefs: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: { type: "string" },
          },
          falsifier: { type: "string" },
        },
      },
    },
    recommendedRegressionAssertion: { type: "string" },
    uncertainty: {
      type: "array",
      maxItems: 8,
      items: { type: "string" },
    },
  },
} as const);

export function analysisOutputSchemaBytes(): string {
  return `${JSON.stringify(ANALYSIS_OUTPUT_JSON_SCHEMA, null, 2)}\n`;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
