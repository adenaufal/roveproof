import { describe, expect, it } from "vitest";
import {
	DiffPolicyError,
	parseSourceAuthoringDiff,
	parseTestAuthoringDiff,
	parseUnifiedDiff,
} from "../src/index.js";

const TEST_PATH = "apps/target/test/repair-mononym.test.mjs";
const SOURCE_PATH = "apps/target/src/lib/seeds/identity.ts";
const PHONE_PATH = "apps/target/src/lib/seeds/phone.ts";
const RECOMMENDATIONS_PATH = "apps/target/src/lib/seeds/recommendations.ts";

function testDiff(body = ""): string {
	return `--- a/${TEST_PATH}\n+++ b/${TEST_PATH}\n@@ -1,1 +1,4 @@\n import assert from "node:assert/strict";\n+test("ID-MONONYM-REQUIRED-LAST-NAME seed.mononym-required-last-name: required last name", () => {\n+  assert.equal(validateBaselineLegalName("Sari").valid, true);\n+});${body ? `\n${body}` : ""}\n`;
}

function sourceDiffAt(filePath: string, body: string): string {
	return `--- a/${filePath}\n+++ b/${filePath}\n@@ -1,1 +1,2 @@\n export const value = false;\n+${body}`;
}

function sourceDiff(body: string): string {
	return sourceDiffAt(SOURCE_PATH, body);
}

describe("M5 unified-diff policy", () => {
	it("keeps test-only and source-only authoring schemas non-interchangeable", () => {
		expect(() =>
			parseTestAuthoringDiff({
				schemaVersion: 1,
				operation: "source-only",
				unifiedDiff: testDiff(""),
			}),
		).toThrow();
		expect(() =>
			parseSourceAuthoringDiff({
				schemaVersion: 1,
				operation: "test-only",
				unifiedDiff: sourceDiff(""),
			}),
		).toThrow();
	});

	it("canonicalizes a bounded test diff and hashes canonical bytes", () => {
		const parsed = parseUnifiedDiff(testDiff(""), { operation: "test-only" });
		expect(parsed.files).toHaveLength(1);
		expect(parsed.metadata).toMatchObject({
			operation: "test-only",
			additions: 3,
			deletions: 0,
			changedLines: 3,
		});
		expect(parsed.unifiedDiff).not.toContain("\r");
		expect(parsed.diffHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it.each([
		testDiff("+process.env.OPENAI_API_KEY = 'bad';"),
		testDiff("+Authorization: Bearer abcdefghijklmnop"),
		testDiff("+api-key: abcdefghijklmnop"),
		testDiff("+bearer abcdefghijklmnop"),
		testDiff("+const credentials = '.codex/auth.json';"),
		testDiff("+const privateKey = '-----BEGIN PRIVATE KEY-----';"),
		testDiff("+const rsaKey = '-----BEGIN RSA PRIVATE KEY-----';"),
		testDiff("+access-token: abcdefghijklmnop"),
		testDiff("+it.only('bypass', () => {});"),
		testDiff("+test.setTimeout(999999);"),
		testDiff("+const command = 'npm install';"),
	])("rejects adversarial test content", (diff) => {
		expect(() => parseUnifiedDiff(diff, { operation: "test-only" })).toThrow(
			DiffPolicyError,
		);
	});

	it("rejects traversal, path aliases, binary markers, and out-of-scope paths", () => {
		expect(() =>
			parseUnifiedDiff(testDiff("").replace(TEST_PATH, "../secret.ts"), {
				operation: "test-only",
			}),
		).toThrow();
		expect(() =>
			parseUnifiedDiff(
				testDiff("")
					.replace("--- a/", "--- a/")
					.replace("+++ b/", "+++ b/")
					.replace(TEST_PATH, TEST_PATH.toUpperCase()),
				{ operation: "test-only" },
			),
		).toThrow();
		expect(() =>
			parseUnifiedDiff(`${testDiff("")}new file mode 100644\n`, {
				operation: "test-only",
			}),
		).toThrow();
		expect(() =>
			parseUnifiedDiff(sourceDiff(""), { operation: "test-only" }),
		).toThrow();
	});

	it("recomputes miscounted hunk-header line counts from the actual lines", () => {
		// Header says oldCount=2 but the hunk only consumes one context line.
		const parsed = parseUnifiedDiff(
			testDiff("").replace("@@ -1,1 +1,4 @@", "@@ -1,2 +1,4 @@"),
			{ operation: "test-only" },
		);
		expect(parsed.files[0].hunks[0]).toMatchObject({
			oldStart: 1,
			oldCount: 1,
			newStart: 1,
			newCount: 4,
		});
		expect(parsed.metadata).toMatchObject({
			additions: 3,
			deletions: 0,
			changedLines: 3,
		});
		// A model-style source diff with an off-by-one header is accepted with recomputed counts.
		const modelish = sourceDiffAt(
			SOURCE_PATH,
			"export const value = true;",
		).replace("@@ -1,1 +1,2 @@", "@@ -1,2 +1,3 @@");
		const source = parseSourceAuthoringDiff({
			schemaVersion: 1,
			operation: "source-only",
			unifiedDiff: modelish,
		});
		expect(source.files[0].hunks[0]).toMatchObject({
			oldStart: 1,
			oldCount: 1,
			newStart: 1,
			newCount: 2,
		});
	});

	it("rejects source changes to the verifier-owned seed constant", () => {
		expect(() =>
			parseSourceAuthoringDiff({
				schemaVersion: 1,
				operation: "source-only",
				unifiedDiff: sourceDiff('export const MONONYM_SEED_ID = "changed";'),
			}),
		).toThrow(/seed constant/i);
		expect(() =>
			parseSourceAuthoringDiff({
				schemaVersion: 1,
				operation: "source-only",
				unifiedDiff: sourceDiff(
					'export const value = "ID-MONONYM-REQUIRED-LAST-NAME";',
				),
			}),
		).toThrow(/seed constant/i);
	});

	it("accepts bounded source diffs to the three allowlisted seed files", () => {
		expect(() =>
			parseSourceAuthoringDiff({
				schemaVersion: 1,
				operation: "source-only",
				unifiedDiff: sourceDiffAt(SOURCE_PATH, "export const value = true;"),
			}),
		).not.toThrow();
		expect(() =>
			parseSourceAuthoringDiff({
				schemaVersion: 1,
				operation: "source-only",
				unifiedDiff: sourceDiffAt(PHONE_PATH, "export const value = true;"),
			}),
		).not.toThrow();
		expect(() =>
			parseSourceAuthoringDiff({
				schemaVersion: 1,
				operation: "source-only",
				unifiedDiff: sourceDiffAt(
					RECOMMENDATIONS_PATH,
					"export const value = true;",
				),
			}),
		).not.toThrow();
	});

	it("rejects source changes to the verifier-owned phone and recommendations seed constants", () => {
		expect(() =>
			parseSourceAuthoringDiff({
				schemaVersion: 1,
				operation: "source-only",
				unifiedDiff: sourceDiffAt(
					PHONE_PATH,
					'export const PLUS62_PHONE_SEED_ID = "changed";',
				),
			}),
		).toThrow(/seed constant/i);
		expect(() =>
			parseSourceAuthoringDiff({
				schemaVersion: 1,
				operation: "source-only",
				unifiedDiff: sourceDiffAt(
					PHONE_PATH,
					'export const value = "ID-PHONE-PLUS62-NORMALIZATION";',
				),
			}),
		).toThrow(/seed constant/i);
		expect(() =>
			parseSourceAuthoringDiff({
				schemaVersion: 1,
				operation: "source-only",
				unifiedDiff: sourceDiffAt(
					RECOMMENDATIONS_PATH,
					'export const HEAVY_RECOMMENDATIONS_SEED_ID = "changed";',
				),
			}),
		).toThrow(/seed constant/i);
		expect(() =>
			parseSourceAuthoringDiff({
				schemaVersion: 1,
				operation: "source-only",
				unifiedDiff: sourceDiffAt(
					RECOMMENDATIONS_PATH,
					'export const value = "MOBILE-HEAVY-CHECKOUT-BUNDLE";',
				),
			}),
		).toThrow(/seed constant/i);
	});

	it("rejects source diffs to non-allowlisted paths while allowing the three seed files", () => {
		expect(() =>
			parseSourceAuthoringDiff({
				schemaVersion: 1,
				operation: "source-only",
				unifiedDiff: sourceDiffAt(
					"apps/target/src/lib/seeds/other.ts",
					"export const value = true;",
				),
			}),
		).toThrow(/not allowlisted/);
		expect(() =>
			parseSourceAuthoringDiff({
				schemaVersion: 1,
				operation: "source-only",
				unifiedDiff: sourceDiffAt(
					"apps/target/src/checkout.ts",
					"export const value = true;",
				),
			}),
		).toThrow(/not allowlisted/);
	});

	it("rejects equal and overlapping hunks before any candidate apply exists", () => {
		const equal = `--- a/${TEST_PATH}\n+++ b/${TEST_PATH}\n@@ -1,1 +1,1 @@\n import { describe, expect, it, vi } from "vitest";\n@@ -1,1 +1,1 @@\n import { describe, expect, it, vi } from "vitest";\n`;
		expect(() => parseUnifiedDiff(equal, { operation: "test-only" })).toThrow(
			DiffPolicyError,
		);
		const overlapping = `--- a/${TEST_PATH}\n+++ b/${TEST_PATH}\n@@ -1,3 +1,3 @@\n import { describe, expect, it, vi } from "vitest";\n ${"x"}\n ${"y"}\n@@ -2,2 +2,2 @@\n ${"x"}\n ${"y"}\n`;
		expect(() =>
			parseUnifiedDiff(overlapping, { operation: "test-only" }),
		).toThrow(DiffPolicyError);
	});
});
