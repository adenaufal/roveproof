import { createHash } from "node:crypto";
import path from "node:path";
import {
	CanonicalDiffMetadataSchema,
	DiffPathSchema,
	M5_MONONYM_ASSERTION_FRAGMENT,
	M5_MONONYM_ASSERTION_ID,
	Sha256Schema,
	SourceAuthoringDiffSchema,
	TestAuthoringDiffSchema,
	type CanonicalDiffMetadata,
	type SourceAuthoringDiff,
	type TestAuthoringDiff,
} from "@roveproof/contracts";

export type DiffOperation = "test-only" | "source-only";

export const DEFAULT_TEST_DIFF_PATHS = Object.freeze([
	"apps/target/test/repair-mononym.test.mjs",
] as const);

export const DEFAULT_SOURCE_DIFF_PATHS = Object.freeze([
	"apps/target/src/lib/seeds/identity.ts",
	"apps/target/src/lib/seeds/phone.ts",
	"apps/target/src/lib/seeds/recommendations.ts",
] as const);

export const MAX_DIFF_BYTES = 1024 * 1024;
export const MAX_DIFF_FILES = 5;
export const MAX_CHANGED_LINES = 250;

export class DiffPolicyError extends Error {
	readonly violations: readonly string[];

	constructor(violations: readonly string[] | string) {
		const items =
			typeof violations === "string" ? [violations] : [...violations];
		super(items.join("; "));
		this.name = "DiffPolicyError";
		this.violations = items;
	}
}

export type ParsedDiffHunk = Readonly<{
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: readonly string[];
}>;

export type ParsedDiffFile = Readonly<{
	path: string;
	oldPath: string;
	newPath: string;
	additions: number;
	deletions: number;
	hunks: readonly ParsedDiffHunk[];
}>;

export type ParsedUnifiedDiff = Readonly<{
	operation: DiffOperation;
	unifiedDiff: string;
	canonicalBytes: Buffer;
	diffHash: string;
	files: readonly ParsedDiffFile[];
	metadata: CanonicalDiffMetadata;
}>;

export type DiffPolicyOptions = Readonly<{
	operation: DiffOperation;
	allowedPaths?: readonly string[];
	maxFiles?: number;
	maxChangedLines?: number;
}>;

function fail(violations: string[]): never {
	throw new DiffPolicyError(violations);
}

function pathAlias(value: string): string {
	return value.toLowerCase();
}

const CREDENTIAL_PATTERN =
	/(?:OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN|-----BEGIN (?:[A-Z0-9][A-Z0-9 ]* )?PRIVATE KEY-----|(?:authorization|api[_-]?key|access[_-]?token)\s*[:=]|bearer\s+[a-z0-9._-]{8,}|sk-[a-z0-9]{16,}|(?:\.codex[\\/])auth(?:\.json)?)/i;

export function containsCredentialPattern(value: string): boolean {
	return CREDENTIAL_PATTERN.test(value);
}

/**
 * Candidate paths are repository-relative and intentionally stricter than the
 * general artifact path policy. In particular, backslashes are never treated
 * as separators, which prevents a Windows path from being reinterpreted by a
 * Linux Docker worker.
 */
export function canonicalDiffPath(valueInput: string): string {
	if (!DiffPathSchema.safeParse(valueInput).success) {
		throw new DiffPolicyError("path is not a canonical relative path");
	}
	if (path.isAbsolute(valueInput))
		throw new DiffPolicyError("path must be relative");
	return valueInput;
}

function stripDiffPrefix(value: string, prefix: string): string {
	if (value.startsWith(`${prefix}/`)) return value.slice(prefix.length + 1);
	if (value === prefix) return "";
	return value;
}

function parseHeaderPath(line: string, marker: "---" | "+++"): string {
	if (!line.startsWith(`${marker} `))
		throw new DiffPolicyError(`missing ${marker} path header`);
	const value = line.slice(marker.length + 1);
	if (!value || value.includes("\t") || value.startsWith('"'))
		throw new DiffPolicyError("quoted or timestamped paths are not accepted");
	const pathValue = stripDiffPrefix(value, marker === "---" ? "a" : "b");
	if (pathValue === "/dev/null")
		throw new DiffPolicyError(
			"file creation and deletion patches are not accepted",
		);
	return canonicalDiffPath(pathValue);
}

function parseRange(
	value: string,
	marker: "-" | "+",
): { start: number; count: number } {
	const match = new RegExp(`^\\${marker}([0-9]+)(?:,([0-9]+))?$`).exec(value);
	if (!match) throw new DiffPolicyError("malformed hunk range");
	const start = Number(match[1]);
	const count = match[2] === undefined ? 1 : Number(match[2]);
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(count) ||
		count < 0 ||
		start < 0
	) {
		throw new DiffPolicyError(
			"hunk range is outside the supported integer policy",
		);
	}
	if (count > MAX_CHANGED_LINES * 4)
		throw new DiffPolicyError("hunk range is unreasonably large");
	return { start, count };
}

function parseHunkHeader(line: string): {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
} {
	const match =
		/^@@\s+(-[0-9]+(?:,[0-9]+)?)\s+\+([0-9]+(?:,[0-9]+)?)\s+@@(?: .*)?$/.exec(
			line,
		);
	if (!match) throw new DiffPolicyError("malformed hunk header");
	const oldRange = parseRange(match[1], "-");
	const newRange = parseRange(`+${match[2]}`, "+");
	return {
		oldStart: oldRange.start,
		oldCount: oldRange.count,
		newStart: newRange.start,
		newCount: newRange.count,
	};
}

function hasForbiddenPatchMarker(line: string): boolean {
	return /^(?:new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to|copy from|copy to|Binary files|GIT binary patch|literal |delta )/.test(
		line,
	);
}

function parseDiffFiles(lines: readonly string[]): ParsedDiffFile[] {
	const files: ParsedDiffFile[] = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index];
		if (!line) {
			index += 1;
			continue;
		}
		if (hasForbiddenPatchMarker(line))
			throw new DiffPolicyError(
				"binary, mode, rename, copy, or delete patches are not accepted",
			);
		if (line.startsWith("diff --git ")) {
			index += 1;
			continue;
		}
		if (line.startsWith("index ")) {
			index += 1;
			continue;
		}
		if (!line.startsWith("--- "))
			throw new DiffPolicyError(
				"unified diff must begin each file with an old path header",
			);
		const oldPath = parseHeaderPath(line, "---");
		index += 1;
		if (index >= lines.length)
			throw new DiffPolicyError("unified diff is missing a new path header");
		const newPath = parseHeaderPath(lines[index], "+++");
		if (oldPath !== newPath)
			throw new DiffPolicyError(
				"rename and cross-path patches are not accepted",
			);
		index += 1;

		const hunks: ParsedDiffHunk[] = [];
		let additions = 0;
		let deletions = 0;
		let previousRange: {
			oldStart: number;
			oldCount: number;
			oldEnd: number;
			newStart: number;
			newCount: number;
			newEnd: number;
		} | null = null;
		while (
			index < lines.length &&
			!lines[index].startsWith("--- ") &&
			!lines[index].startsWith("diff --git ")
		) {
			const hunkLine = lines[index];
			if (hasForbiddenPatchMarker(hunkLine))
				throw new DiffPolicyError("unsupported patch marker");
			if (!hunkLine.startsWith("@@")) {
				if (hunkLine.startsWith("index ") || hunkLine.length === 0) {
					index += 1;
					continue;
				}
				throw new DiffPolicyError("unified diff contains text outside a hunk");
			}
			const header = parseHunkHeader(hunkLine);
			index += 1;
			const hunkLines: string[] = [];
			let oldConsumed = 0;
			let newConsumed = 0;
			while (
				index < lines.length &&
				!lines[index].startsWith("@@") &&
				!lines[index].startsWith("--- ") &&
				!lines[index].startsWith("diff --git ")
			) {
				const patchLine = lines[index];
				if (patchLine.length === 0) break;
				if (patchLine.startsWith("\\ No newline at end of file"))
					throw new DiffPolicyError(
						"non-canonical no-newline markers are not accepted",
					);
				const marker = patchLine[0];
				if (marker !== " " && marker !== "+" && marker !== "-")
					throw new DiffPolicyError("hunk contains an invalid line marker");
				hunkLines.push(patchLine);
				if (marker !== "+") oldConsumed += 1;
				if (marker !== "-") newConsumed += 1;
				if (marker === "+") additions += 1;
				if (marker === "-") deletions += 1;
				index += 1;
			}
			// The hunk-header line counts are advisory; the actual context/+/- lines are
			// authoritative. Recompute the counts from the consumed lines so a model that
			// miscounts its header (a common LLM limitation) still yields a well-formed,
			// content-validated hunk. The apply positions (oldStart/newStart) remain taken
			// from the header. This matches how git apply and other patch tools behave and
			// preserves every security check (allowlist, seed constants, secrets, budgets,
			// ordering/overlap, Docker isolation, hash-bound proof).
			const range = {
				oldStart: header.oldStart,
				oldCount: oldConsumed,
				newStart: header.newStart,
				newCount: newConsumed,
			};
			const oldEnd = range.oldStart + range.oldCount;
			const newEnd = range.newStart + range.newCount;
			if (!Number.isSafeInteger(oldEnd) || !Number.isSafeInteger(newEnd))
				throw new DiffPolicyError(
					"hunk range is outside the supported integer policy",
				);
			if (previousRange) {
				const equal =
					range.oldStart === previousRange.oldStart &&
					range.oldCount === previousRange.oldCount &&
					range.newStart === previousRange.newStart &&
					range.newCount === previousRange.newCount;
				const oldOverlaps =
					range.oldCount > 0 &&
					previousRange.oldCount > 0 &&
					range.oldStart < previousRange.oldEnd;
				const newOverlaps =
					range.newCount > 0 &&
					previousRange.newCount > 0 &&
					range.newStart < previousRange.newEnd;
				if (
					equal ||
					oldOverlaps ||
					newOverlaps ||
					range.oldStart < previousRange.oldStart ||
					range.newStart < previousRange.newStart
				) {
					throw new DiffPolicyError(
						"hunks are out of order, equal, or overlap",
					);
				}
			}
			previousRange = { ...range, oldEnd, newEnd };
			hunks.push({ ...range, lines: hunkLines });
		}
		if (hunks.length === 0)
			throw new DiffPolicyError("each file must contain at least one hunk");
		files.push({
			path: oldPath,
			oldPath,
			newPath,
			additions,
			deletions,
			hunks,
		});
	}
	if (files.length === 0) throw new DiffPolicyError("unified diff is empty");
	return files;
}

function scanPolicy(
	_diff: string,
	files: readonly ParsedDiffFile[],
	options: DiffPolicyOptions,
): string[] {
	const violations: string[] = [];
	const maxFiles = options.maxFiles ?? MAX_DIFF_FILES;
	const maxChangedLines = options.maxChangedLines ?? MAX_CHANGED_LINES;
	if (files.length > maxFiles)
		violations.push(`file budget exceeded: ${files.length} > ${maxFiles}`);
	const additions = files.reduce((sum, file) => sum + file.additions, 0);
	const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
	if (additions + deletions > maxChangedLines)
		violations.push(
			`changed-line budget exceeded: ${additions + deletions} > ${maxChangedLines}`,
		);

	const aliases = new Set<string>();
	const addedCandidateLines: string[] = [];
	let addedCandidateText = "";
	const allowlist =
		options.allowedPaths ??
		(options.operation === "test-only"
			? DEFAULT_TEST_DIFF_PATHS
			: DEFAULT_SOURCE_DIFF_PATHS);
	const allowed = new Set(allowlist.map(canonicalDiffPath));
	for (const file of files) {
		const alias = pathAlias(file.path);
		if (aliases.has(alias))
			violations.push(`duplicate or case-alias path: ${file.path}`);
		aliases.add(alias);
		if (!allowed.has(file.path))
			violations.push(
				`path is not allowlisted for ${options.operation}: ${file.path}`,
			);
		if (
			file.path
				.split("/")
				.some((segment) =>
					[".git", ".pi-subagents", "node_modules", "var"].includes(segment),
				) ||
			file.path.startsWith(".env") ||
			file.path.includes("/config/") ||
			file.path === "package-lock.json" ||
			file.path === "package.json"
		) {
			violations.push(`forbidden candidate path: ${file.path}`);
		}
		if (options.operation === "test-only" && !file.path.includes("/test/"))
			violations.push(`test-only diff changed non-test path: ${file.path}`);
		if (options.operation === "source-only" && file.path.includes("/test/"))
			violations.push(`source-only diff changed a test path: ${file.path}`);
		for (const hunk of file.hunks) {
			for (const line of hunk.lines) {
				if (!line.startsWith("+") && !line.startsWith("-")) continue;
				const content = line.slice(1);
				if (line.startsWith("+")) {
					addedCandidateLines.push(content);
					addedCandidateText += `${content}\n`;
				}
				if (containsCredentialPattern(content)) {
					violations.push("candidate contains a credential or secret pattern");
				}
				if (
					/\b(?:test|it|describe)\.(?:only|skip)|\b(?:test|it|describe)\s*\.todo\b|\bexpect\.assertions\s*\(\s*0\s*\)/.test(
						content,
					)
				) {
					violations.push("candidate weakens or bypasses assertions");
				}
				if (
					line.startsWith("-") &&
					/\b(?:expect|assert|toBe|toEqual|toHave[A-Z]|toContain|toThrow)\b/.test(
						content,
					)
				) {
					violations.push("candidate removes an assertion");
				}
				if (
					/\b(?:setTimeout|timeoutMs|test\.setTimeout|patchBudget|performanceBudget)\b/.test(
						content,
					)
				) {
					violations.push("candidate changes a timeout or frozen budget");
				}
				if (
					/(?:npm|pnpm|yarn)\s+(?:install|add)|\b(?:curl|wget|Invoke-WebRequest)\b|docker\s+run|child_process|execSync\s*\(/i.test(
						content,
					)
				) {
					violations.push(
						"candidate introduces an untrusted command or dependency operation",
					);
				}
				if (
					line.startsWith("+") &&
					/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(content)
				) {
					violations.push("candidate swallows an error");
				}
			}
		}
	}
	if (options.operation === "test-only") {
		const requiredAssertion = [
			`test("ID-MONONYM-REQUIRED-LAST-NAME ${M5_MONONYM_ASSERTION_ID}: ${M5_MONONYM_ASSERTION_FRAGMENT}", () => {`,
			`  assert.equal(validateBaselineLegalName("Sari").valid, true);`,
			`});`,
		];
		if (
			files.length !== 1 ||
			deletions !== 0 ||
			JSON.stringify(addedCandidateLines) !== JSON.stringify(requiredAssertion)
		) {
			violations.push(
				"test-only diff must add only the verifier-defined mononym assertion block",
			);
		}
		if (!addedCandidateText.includes(M5_MONONYM_ASSERTION_ID))
			violations.push(
				`test-only diff must bind assertion ${M5_MONONYM_ASSERTION_ID}`,
			);
		if (
			!addedCandidateText.toLowerCase().includes(M5_MONONYM_ASSERTION_FRAGMENT)
		)
			violations.push(
				`test-only diff must bind assertion fragment ${M5_MONONYM_ASSERTION_FRAGMENT}`,
			);
		if (!/\b(?:assert|expect)\s*\./.test(addedCandidateText))
			violations.push("test-only diff must add an executable assertion");
		if (
			!/validateBaselineLegalName\(\s*["']Sari["']\s*\)\s*\.\s*valid/.test(
				addedCandidateText,
			)
		)
			violations.push(
				'test-only diff must assert validateBaselineLegalName("Sari").valid',
			);
		if (
			!/(?:validateBaselineLegalName\(\s*["']Sari["']\s*\)\s*\.\s*valid[\s\S]{0,80}(?:===\s*true|toBe\(\s*true\s*\)|,\s*true\b)|(?:assert|expect)\.[\s\S]{0,80}validateBaselineLegalName\(\s*["']Sari["']\s*\)[^\\n;]*(?:true))/.test(
				addedCandidateText,
			)
		)
			violations.push("test-only diff must assert the Sari result is true");
	}
	if (options.operation === "source-only") {
		// The verifier owns every seed identifier. A candidate may fix the seed
		// behavior but must never rename, relabel, or repurpose a seed constant.
		const seedConstantPattern =
			/MONONYM_SEED_ID|ID-MONONYM-REQUIRED-LAST-NAME|PLUS62_PHONE_SEED_ID|ID-PHONE-PLUS62-NORMALIZATION|HEAVY_RECOMMENDATIONS_SEED_ID|MOBILE-HEAVY-CHECKOUT-BUNDLE/;
		if (
			files.some((file) =>
				file.hunks.some((hunk) =>
					hunk.lines.some(
						(line) =>
							(line.startsWith("+") || line.startsWith("-")) &&
							seedConstantPattern.test(line.slice(1)),
					),
				),
			)
		) {
			violations.push(
				"source-only diff cannot change the verifier-owned seed constant",
			);
		}
	}
	return [...new Set(violations)];
}

export function parseUnifiedDiff(
	input: string | Uint8Array,
	options: DiffPolicyOptions,
): ParsedUnifiedDiff {
	const bytes =
		typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
	if (bytes.length === 0 || bytes.length > MAX_DIFF_BYTES)
		throw new DiffPolicyError("diff input exceeds size policy");
	const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	if (decoded.includes("\r\r\n"))
		throw new DiffPolicyError("diff contains malformed line endings");
	const unifiedDiff = decoded.replace(/\r\n/g, "\n");
	const files = parseDiffFiles(unifiedDiff.split("\n"));
	const violations = scanPolicy(unifiedDiff, files, options);
	if (violations.length > 0) fail(violations);
	const canonicalBytes = Buffer.from(unifiedDiff, "utf8");
	const diffHash = createHash("sha256").update(canonicalBytes).digest("hex");
	Sha256Schema.parse(diffHash);
	const metadata = CanonicalDiffMetadataSchema.parse({
		schemaVersion: 1,
		format: "unified-diff-v1",
		operation: options.operation,
		diffHash,
		files: files.map((file) => ({
			path: file.path,
			additions: file.additions,
			deletions: file.deletions,
			hunkCount: file.hunks.length,
		})),
		additions: files.reduce((sum, file) => sum + file.additions, 0),
		deletions: files.reduce((sum, file) => sum + file.deletions, 0),
		changedLines: files.reduce(
			(sum, file) => sum + file.additions + file.deletions,
			0,
		),
	});
	return {
		operation: options.operation,
		unifiedDiff,
		canonicalBytes,
		diffHash,
		files,
		metadata,
	};
}

export function parseTestAuthoringDiff(
	input: unknown,
	options: Readonly<{ allowedPaths?: readonly string[] }> = {},
): ParsedUnifiedDiff {
	const parsed = TestAuthoringDiffSchema.parse(input) as TestAuthoringDiff;
	return parseUnifiedDiff(parsed.unifiedDiff, {
		operation: "test-only",
		allowedPaths: options.allowedPaths,
	});
}

export function parseSourceAuthoringDiff(
	input: unknown,
	options: Readonly<{ allowedPaths?: readonly string[] }> = {},
): ParsedUnifiedDiff {
	const parsed = SourceAuthoringDiffSchema.parse(input) as SourceAuthoringDiff;
	return parseUnifiedDiff(parsed.unifiedDiff, {
		operation: "source-only",
		allowedPaths: options.allowedPaths,
	});
}
