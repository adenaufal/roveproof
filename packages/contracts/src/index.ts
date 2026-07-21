import { createHash } from "node:crypto";
import { z } from "zod";
import { assertSafeArtifactPath, isSafeArtifactPath } from "./artifact-path.js";
export { assertSafeArtifactPath, isSafeArtifactPath };

export const SCHEMA_VERSION = 1 as const;
export const TARGET_ID = "seeded-checkout-v1" as const;
export const JOURNEY_ID = "checkout-v1" as const;
export const PROFILE_ID = "indonesia-mobile-v1" as const;
export const SEED_IDS = [
	"ID-MONONYM-REQUIRED-LAST-NAME",
	"ID-PHONE-PLUS62-NORMALIZATION",
	"MOBILE-HEAVY-CHECKOUT-BUNDLE",
] as const;

export const SchemaVersionSchema = z.literal(SCHEMA_VERSION);
export const TargetIdSchema = z.literal(TARGET_ID);
export const JourneyIdSchema = z.literal(JOURNEY_ID);
export const ProfileIdSchema = z.literal(PROFILE_ID);
export const SeedIdSchema = z.enum(SEED_IDS);
export const RunVerdictSchema = z.enum(["PASSED", "FAILED", "INCONCLUSIVE"]);
export const EXECUTION_MODES = ["real", "fixture"] as const;
export const ExecutionModeSchema = z.enum(EXECUTION_MODES);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const EntityIdSchema = z.string().regex(/^[a-z][a-z0-9-]{2,63}$/);
const FixedSeedIdsSchema = z.tuple(
	SEED_IDS.map((seed) => z.literal(seed)) as [
		z.ZodLiteral<(typeof SEED_IDS)[0]>,
		z.ZodLiteral<(typeof SEED_IDS)[1]>,
		z.ZodLiteral<(typeof SEED_IDS)[2]>,
	],
);

export const RunOriginSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		jobId: EntityIdSchema,
		runId: EntityIdSchema,
		mode: ExecutionModeSchema,
		targetId: TargetIdSchema,
		journeyId: JourneyIdSchema,
		profileId: ProfileIdSchema,
		seedIds: FixedSeedIdsSchema.readonly(),
	})
	.strict()
	.readonly();

export const RUN_STATES = [
	"REQUESTED",
	"BASELINE_RUNNING",
	"BASELINE_FAILED_EXPECTED",
	"ANALYZING",
	"TEST_AUTHORING",
	"TEST_FAILED_AS_EXPECTED",
	"PATCH_AUTHORING",
	"SANDBOX_GATING",
	"VERIFYING_CLEAN",
	"READY_FOR_HUMAN_REVIEW",
	"APPROVED",
	"REJECTED",
	"INCONCLUSIVE",
] as const;
export const RunStateSchema = z.enum(RUN_STATES);
export type RunState = z.infer<typeof RunStateSchema>;
export const TERMINAL_RUN_STATES = [
	"APPROVED",
	"REJECTED",
	"INCONCLUSIVE",
] as const;
export const TerminalRunStateSchema = z.enum(TERMINAL_RUN_STATES);
export function isTerminalRunState(
	state: RunState,
): state is z.infer<typeof TerminalRunStateSchema> {
	return (TERMINAL_RUN_STATES as readonly RunState[]).includes(state);
}

export const STATE_TRANSITIONS = Object.freeze({
	REQUESTED: Object.freeze(["BASELINE_RUNNING", "INCONCLUSIVE"]),
	BASELINE_RUNNING: Object.freeze(["BASELINE_FAILED_EXPECTED", "INCONCLUSIVE"]),
	BASELINE_FAILED_EXPECTED: Object.freeze(["ANALYZING", "INCONCLUSIVE"]),
	ANALYZING: Object.freeze(["TEST_AUTHORING", "INCONCLUSIVE"]),
	TEST_AUTHORING: Object.freeze(["TEST_FAILED_AS_EXPECTED", "INCONCLUSIVE"]),
	TEST_FAILED_AS_EXPECTED: Object.freeze(["PATCH_AUTHORING", "INCONCLUSIVE"]),
	PATCH_AUTHORING: Object.freeze(["SANDBOX_GATING", "INCONCLUSIVE"]),
	SANDBOX_GATING: Object.freeze([
		"VERIFYING_CLEAN",
		"REJECTED",
		"INCONCLUSIVE",
	]),
	VERIFYING_CLEAN: Object.freeze(["READY_FOR_HUMAN_REVIEW", "INCONCLUSIVE"]),
	READY_FOR_HUMAN_REVIEW: Object.freeze([
		"APPROVED",
		"REJECTED",
		"INCONCLUSIVE",
	]),
	APPROVED: Object.freeze([]),
	REJECTED: Object.freeze([]),
	INCONCLUSIVE: Object.freeze([]),
} satisfies Record<RunState, readonly RunState[]>);

function isAllowedTransition(
	from: RunState,
	to: RunState,
	mode: ExecutionMode,
): boolean {
	if (
		mode === "fixture" &&
		(to === "READY_FOR_HUMAN_REVIEW" || to === "APPROVED")
	)
		return false;
	return (STATE_TRANSITIONS[from] as readonly RunState[]).includes(to);
}

export const StateTransitionSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		jobId: EntityIdSchema,
		runId: EntityIdSchema,
		mode: ExecutionModeSchema,
		from: RunStateSchema,
		to: RunStateSchema,
	})
	.strict()
	.superRefine(({ from, to, mode }, context) => {
		if (!isAllowedTransition(from, to, mode))
			context.addIssue({
				code: "custom",
				message: `Invalid ${mode} run state transition: ${from} -> ${to}`,
			});
	});

function assertMatchingOrigin(
	origin: z.infer<typeof RunOriginSchema>,
	record: { jobId: string; runId: string; mode: ExecutionMode },
): void {
	if (record.jobId !== origin.jobId)
		throw new Error("Record job ID does not match originating job");
	if (record.runId !== origin.runId)
		throw new Error("Record run ID does not match originating run");
	if (record.mode !== origin.mode)
		throw new Error("Record mode does not match originating run");
}

/**
 * The origin input must be loaded from the immutable provenance store, never
 * reconstructed from transition fields supplied by a caller.
 */
export function validateStateTransitionForOrigin(
	originInput: unknown,
	transitionInput: unknown,
) {
	const origin = RunOriginSchema.parse(originInput);
	const transition = StateTransitionSchema.parse(transitionInput);
	assertMatchingOrigin(origin, transition);
	return transition;
}

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const TimestampSchema = z.iso.datetime({ offset: true });
export const ArtifactPathSchema = z
	.string()
	.refine(
		isSafeArtifactPath,
		"Artifact path must be bundle-relative and traversal-free",
	);

export const EVIDENCE_REQUIRED_ARTIFACTS = [
	"manifest.json",
	"result.json",
	"assertions.json",
	"screenshots/00-start.png",
	"screenshots/failure-or-confirmation.png",
	"trace.zip",
	"network.har",
	"console.jsonl",
	"requests.jsonl",
	"metrics.json",
] as const;

export const EvidenceRunIdSchema = EntityIdSchema;
export const EvidenceRunKindSchema = z.enum(["baseline", "verification"]);
export const JourneyVerdictSchema = z.enum([
	"PASS",
	"FAIL_BLOCKED",
	"FAIL_INCORRECT",
	"FAIL_BUDGET",
	"INCONCLUSIVE",
]);
export const JourneyAssertionStatusSchema = z.enum([
	"PASS",
	"FAIL",
	"NOT_EVALUATED",
]);

const NonNegativeFiniteSchema = z.number().finite().nonnegative();
const NullableNonNegativeFiniteSchema = NonNegativeFiniteSchema.nullable();
export const ArtifactReferenceSchema = z
	.string()
	.superRefine((reference, context) => {
		const [artifactPath, fragment, ...extra] = reference.split("#");
		if (!isSafeArtifactPath(artifactPath) || extra.length > 0) {
			context.addIssue({
				code: "custom",
				message:
					"Artifact reference must contain a safe bundle path and at most one fragment",
			});
		}
		if (
			fragment !== undefined &&
			!/^[a-zA-Z0-9._~!$&'()*+,;=:@/?-]+$/.test(fragment)
		) {
			context.addIssue({
				code: "custom",
				message: "Artifact reference fragment is invalid",
			});
		}
	});

const RuntimeObservationSchema = z
	.object({
		viewport: z
			.object({
				width: z.number().int().positive().nullable(),
				height: z.number().int().positive().nullable(),
			})
			.strict(),
		deviceScaleFactor: z.number().positive().nullable(),
		maxTouchPoints: z.number().int().nonnegative().nullable(),
		locale: z.string().min(1).nullable(),
		languages: z.array(z.string().min(1)),
		timeZone: z.string().min(1).nullable(),
		acceptLanguage: z.string().min(1).nullable(),
	})
	.strict();

const CpuVerificationSchema = z
	.object({
		requestedRate: z.literal(4),
		commandApplied: z.boolean(),
		verified: z.boolean(),
		verificationBasis: z.enum(["benchmark-ratio", "unavailable"]),
		baselineProbeMs: NullableNonNegativeFiniteSchema,
		throttledProbeMs: NullableNonNegativeFiniteSchema,
		observedRatio: NullableNonNegativeFiniteSchema,
	})
	.strict()
	.superRefine((cpu, context) => {
		if (
			cpu.verified &&
			(!cpu.commandApplied ||
				cpu.verificationBasis !== "benchmark-ratio" ||
				cpu.observedRatio === null)
		) {
			context.addIssue({
				code: "custom",
				message:
					"Verified CPU throttling requires an applied command and benchmark evidence",
			});
		}
	});

const NetworkVerificationSchema = z
	.object({
		profile: z.literal("flaky-3g-v1"),
		latencyMs: z.literal(300),
		downloadBytesPerSecond: z.literal(450_000),
		uploadBytesPerSecond: z.literal(93_750),
		commandApplied: z.boolean(),
		verified: z.boolean(),
		verificationBasis: z.enum(["rule-id-and-transfer-probe", "unavailable"]),
		probeRuleId: z.string().min(1).nullable(),
		measuredRuleId: z.string().min(1).nullable(),
		measuredRuleMatched: z.boolean(),
		probe: z
			.object({
				bodyBytes: z.literal(450_000),
				durationMs: NonNegativeFiniteSchema,
				expectedDurationMs: NonNegativeFiniteSchema,
				matchedRule: z.boolean(),
			})
			.strict()
			.nullable(),
	})
	.strict()
	.superRefine((network, context) => {
		if (
			network.verified &&
			(!network.commandApplied ||
				network.verificationBasis !== "rule-id-and-transfer-probe" ||
				!network.probeRuleId ||
				!network.measuredRuleId ||
				!network.measuredRuleMatched ||
				!network.probe?.matchedRule)
		) {
			context.addIssue({
				code: "custom",
				message:
					"Verified network throttling requires an applied rule and matching transfer probe",
			});
		}
	});

const JitterApplicationSchema = {
	appliedAtMs: NullableNonNegativeFiniteSchema,
	ruleId: z.string().min(1).nullable(),
} as const;

export const EvidenceManifestSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		runId: EvidenceRunIdSchema,
		kind: EvidenceRunKindSchema,
		mode: z.literal("real"),
		targetId: TargetIdSchema,
		journeyId: JourneyIdSchema,
		profileId: ProfileIdSchema,
		seedIds: FixedSeedIdsSchema,
		sourceRevision: z
			.string()
			.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64}|sha256:[a-f0-9]{64})$/),
		candidateDiffHash: Sha256Schema.nullable(),
		startedAt: TimestampSchema,
		completedAt: TimestampSchema,
		runtime: z
			.object({
				playwrightVersion: z.string().min(1),
				browser: z.literal("chromium"),
				browserVersion: z.string().min(1).nullable(),
				userAgent: z.string().min(1).nullable(),
				observed: RuntimeObservationSchema,
				touch: z
					.object({
						requested: z.literal(true),
						pointerEventObserved: z.boolean(),
						verified: z.boolean(),
					})
					.strict(),
				cpu: CpuVerificationSchema,
				network: NetworkVerificationSchema,
				jitter: z
					.object({
						schedule: z.literal("deterministic-jitter-v1"),
						completed: z.boolean(),
						events: z.tuple([
							z
								.object({
									phase: z.literal("degraded"),
									plannedAtMs: z.literal(0),
									...JitterApplicationSchema,
								})
								.strict(),
							z
								.object({
									phase: z.literal("restored"),
									plannedAtMs: z.literal(250),
									...JitterApplicationSchema,
								})
								.strict(),
						]),
					})
					.strict(),
				profileVerified: z.boolean(),
			})
			.strict(),
		redaction: z
			.object({
				policy: z.literal("roveproof-redaction-v1"),
				scope: z.literal("credentials-secrets-and-unexpected-pii"),
				dataClassification: z.literal("fixed-synthetic-only"),
				verified: z.boolean(),
			})
			.strict(),
		missingArtifacts: z
			.array(
				z
					.object({
						path: ArtifactPathSchema,
						reason: z.string().min(1),
					})
					.strict(),
			)
			.superRefine((artifacts, context) => {
				const paths = artifacts.map(({ path }) => path);
				if (new Set(paths).size !== paths.length) {
					context.addIssue({
						code: "custom",
						message: "Missing artifact paths must be unique",
					});
				}
			}),
		deviations: z.array(z.string().min(1)),
	})
	.strict()
	.superRefine((manifest, context) => {
		const { runtime } = manifest;
		const touchObserved =
			(runtime.observed.maxTouchPoints ?? 0) > 0 ||
			runtime.touch.pointerEventObserved;
		if (runtime.touch.verified && !touchObserved) {
			context.addIssue({
				code: "custom",
				path: ["runtime", "touch"],
				message:
					"Touch verification requires an observed touch capability or pointer event",
			});
		}
		if (!runtime.profileVerified) return;
		if (
			!runtime.cpu.verified ||
			!runtime.network.verified ||
			!runtime.touch.verified ||
			!runtime.jitter.completed
		) {
			context.addIssue({
				code: "custom",
				path: ["runtime", "profileVerified"],
				message:
					"Profile verification requires verified CPU, network, touch, and jitter constraints",
			});
		}
		const observed = runtime.observed;
		if (
			observed.viewport.width !== 360 ||
			observed.viewport.height !== 800 ||
			observed.deviceScaleFactor !== 2 ||
			observed.locale !== "id-ID" ||
			!observed.languages.includes("id-ID") ||
			observed.timeZone !== "Asia/Jakarta" ||
			observed.acceptLanguage !== "id-ID,id;q=0.9,en;q=0.8"
		) {
			context.addIssue({
				code: "custom",
				path: ["runtime", "observed"],
				message:
					"Verified profile observations must match the frozen Indonesia Mobile settings",
			});
		}
	});

export const EvidenceResultSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		runId: EvidenceRunIdSchema,
		verdict: JourneyVerdictSchema,
		firstCausalFailure: z
			.object({
				code: z.string().min(1),
				message: z.string().min(1),
				artifactRefs: z.array(ArtifactReferenceSchema).min(1),
			})
			.strict()
			.nullable(),
		task: z
			.object({
				completed: z.boolean(),
				durationMs: NonNegativeFiniteSchema,
				orderId: z.string().min(1).nullable(),
				durableOrderCount: z.number().int().nonnegative(),
			})
			.strict(),
		performance: z
			.object({
				transferredBytes: z.number().int().nonnegative(),
				measurement: z.literal(
					"sum of one terminal CDP Network.loadingFinished encodedDataLength per target response within monotonic journey boundaries",
				),
				lcpMs: NullableNonNegativeFiniteSchema,
				inpMs: NullableNonNegativeFiniteSchema,
				cls: NullableNonNegativeFiniteSchema,
			})
			.strict(),
		sampleCount: z.literal(1),
	})
	.strict()
	.superRefine((result, context) => {
		if (
			result.verdict === "PASS" &&
			(!result.task.completed ||
				!result.task.orderId ||
				result.firstCausalFailure !== null)
		) {
			context.addIssue({
				code: "custom",
				message:
					"A passing run requires completion, an order ID, and no causal failure",
			});
		}
		if (result.verdict !== "PASS" && result.firstCausalFailure === null) {
			context.addIssue({
				code: "custom",
				path: ["firstCausalFailure"],
				message: "A non-passing run requires a causal failure",
			});
		}
	});

export const JourneyAssertionsSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		runId: EvidenceRunIdSchema,
		journeyId: JourneyIdSchema,
		expectedSeedIds: FixedSeedIdsSchema,
		observedSeedIds: z.array(SeedIdSchema).superRefine((seedIds, context) => {
			if (new Set(seedIds).size !== seedIds.length) {
				context.addIssue({
					code: "custom",
					message: "Observed seed IDs must be unique",
				});
			}
		}),
		assertions: z
			.array(
				z
					.object({
						id: z.string().regex(/^[a-z][a-z0-9.-]{2,127}$/),
						status: JourneyAssertionStatusSchema,
						message: z.string().min(1),
						seedId: SeedIdSchema.optional(),
						artifactRefs: z.array(ArtifactReferenceSchema),
					})
					.strict(),
			)
			.min(1)
			.superRefine((assertions, context) => {
				const ids = assertions.map(({ id }) => id);
				if (new Set(ids).size !== ids.length) {
					context.addIssue({
						code: "custom",
						message: "Journey assertion IDs must be unique",
					});
				}
			}),
	})
	.strict();

export const EvidenceMetricsSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		runId: EvidenceRunIdSchema,
		boundary: z
			.object({
				clock: z.literal("node:performance.now"),
				startedAt: TimestampSchema,
				completedAt: TimestampSchema,
				durationMs: NonNegativeFiniteSchema,
			})
			.strict(),
		transferredBytes: z.number().int().nonnegative(),
		requestCount: z.number().int().nonnegative(),
		failedRequestCount: z.number().int().nonnegative(),
		consoleErrorCount: z.number().int().nonnegative(),
		pageErrorCount: z.number().int().nonnegative(),
		lcpMs: NullableNonNegativeFiniteSchema,
		inpMs: NullableNonNegativeFiniteSchema,
		cls: NullableNonNegativeFiniteSchema,
	})
	.strict();

export const EvidenceAnchorSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		runId: EvidenceRunIdSchema,
		indexHash: Sha256Schema,
		rootHash: Sha256Schema,
		createdAt: TimestampSchema,
	})
	.strict();

export const ArtifactIndexSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		runId: EvidenceRunIdSchema,
		hashAlgorithm: z.literal("sha256"),
		indexPolicy: z.literal(
			"sha256-tree-v1; artifact-index.json is metadata and is self-excluded",
		),
		rootHash: Sha256Schema,
		entries: z
			.array(
				z
					.object({
						path: ArtifactPathSchema,
						size: z.number().int().nonnegative(),
						sha256: Sha256Schema,
						mediaType: z.string().min(1),
					})
					.strict(),
			)
			.min(1)
			.superRefine((entries, context) => {
				const paths = entries.map(({ path }) => path);
				if (paths.includes("artifact-index.json")) {
					context.addIssue({
						code: "custom",
						message: "The artifact index cannot hash itself",
					});
				}
				if (new Set(paths).size !== paths.length) {
					context.addIssue({
						code: "custom",
						message: "Artifact index paths must be unique",
					});
				}
				const sorted = [...paths].sort((left, right) =>
					left.localeCompare(right),
				);
				if (paths.some((entry, index) => entry !== sorted[index])) {
					context.addIssue({
						code: "custom",
						message: "Artifact index entries must be sorted by path",
					});
				}
			}),
	})
	.strict();

export const JobRequestSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		targetId: TargetIdSchema,
		journeyId: JourneyIdSchema,
		profileId: ProfileIdSchema,
		seedIds: FixedSeedIdsSchema,
		mode: ExecutionModeSchema,
	})
	.strict();

export const RunEventSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		jobId: EntityIdSchema,
		runId: EntityIdSchema,
		mode: ExecutionModeSchema,
		sequence: z.number().int().positive(),
		state: RunStateSchema,
		occurredAt: TimestampSchema,
		message: z.string().min(1).optional(),
	})
	.strict();

export const ControlJobCreateSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		mode: z.literal("fixture"),
	})
	.strict();

export const ControlIdempotencyKeySchema = z
	.string()
	.regex(/^[A-Za-z0-9:_-]{8,128}$/);

export const ControlJobRecordSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		fixtureVersion: z.literal("golden-control-v1"),
		jobId: EntityIdSchema,
		runId: EntityIdSchema,
		mode: z.literal("fixture"),
		targetId: TargetIdSchema,
		journeyId: JourneyIdSchema,
		profileId: ProfileIdSchema,
		seedIds: FixedSeedIdsSchema,
		idempotencyKeyHash: Sha256Schema,
		requestHash: Sha256Schema,
		state: RunStateSchema,
		lastSequence: z.number().int().positive(),
		createdAt: TimestampSchema,
		updatedAt: TimestampSchema,
	})
	.strict()
	.superRefine((job, context) => {
		if (job.state === "READY_FOR_HUMAN_REVIEW" || job.state === "APPROVED") {
			context.addIssue({
				code: "custom",
				path: ["state"],
				message: "Fixture control jobs cannot become review-ready or approved",
			});
		}
	});

export const ControlIdempotencyRecordSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		keyHash: Sha256Schema,
		requestHash: Sha256Schema,
		jobId: EntityIdSchema,
		createdAt: TimestampSchema,
	})
	.strict();

export const LatestJobPointerSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		jobId: EntityIdSchema,
		updatedAt: TimestampSchema,
	})
	.strict();

const FixtureMeasurementBaseSchema = z
	.object({
		source: z.literal("fixture-golden-v1"),
		sampleCount: z.literal(1),
		transferredBytes: z.number().int().nonnegative(),
		durationMs: z.number().finite().nonnegative(),
		displayMegabytes: z.string().regex(/^\d+\.\d MB$/),
		displayDuration: z.string().regex(/^\d+ s$/),
	})
	.strict();

const FixtureFailureFields = {
	title: z.string().min(1),
	summary: z.string().min(1),
	evidenceRefs: z.array(ArtifactReferenceSchema).min(1),
} as const;

export const FixtureDashboardSnapshotSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		fixtureVersion: z.literal("golden-control-v1"),
		provenance: z.literal("fixture"),
		jobId: EntityIdSchema,
		runId: EntityIdSchema,
		createdAt: TimestampSchema,
		profile: z
			.object({
				id: ProfileIdSchema,
				label: z.literal("Indonesia Mobile"),
				viewport: z
					.object({ width: z.literal(360), height: z.literal(800) })
					.strict(),
				deviceScaleFactor: z.literal(2),
				locale: z.literal("id-ID"),
				timeZone: z.literal("Asia/Jakarta"),
				cpuSlowdown: z.literal(4),
				networkLabel: z.literal("Flaky 3G"),
				latencyMs: z.literal(300),
				downloadBitsPerSecond: z.literal(3_600_000),
				uploadBitsPerSecond: z.literal(750_000),
			})
			.strict(),
		baseline: FixtureMeasurementBaseSchema.extend({
			runId: EntityIdSchema,
			verdict: z.literal("FAIL_BLOCKED"),
			outcomeLabel: z.literal("Checkout blocked"),
			taskCompleted: z.literal(false),
		}).strict(),
		verification: FixtureMeasurementBaseSchema.extend({
			runId: EntityIdSchema,
			verdict: z.literal("PASS"),
			outcomeLabel: z.literal("Checkout completed"),
			taskCompleted: z.literal(true),
		}).strict(),
		failures: z.tuple([
			z
				.object({ seedId: z.literal(SEED_IDS[0]), ...FixtureFailureFields })
				.strict(),
			z
				.object({ seedId: z.literal(SEED_IDS[1]), ...FixtureFailureFields })
				.strict(),
			z
				.object({ seedId: z.literal(SEED_IDS[2]), ...FixtureFailureFields })
				.strict(),
		]),
		completion: z.discriminatedUnion("status", [
			z
				.object({
					status: z.literal("PENDING"),
					terminalState: z.null(),
					completedAt: z.null(),
				})
				.strict(),
			z
				.object({
					status: z.literal("REHEARSAL_COMPLETE"),
					terminalState: z.literal("INCONCLUSIVE"),
					completedAt: TimestampSchema,
				})
				.strict(),
		]),
		evidence: z
			.array(
				z
					.object({
						id: EntityIdSchema,
						label: z.string().min(1),
						type: z.enum([
							"screenshot",
							"trace",
							"har",
							"assertions",
							"requests",
							"metrics",
						]),
						artifactPath: ArtifactPathSchema,
						previewPath: z
							.string()
							.regex(/^\/fixtures\/[a-z0-9._/-]+$/)
							.refine(
								(value) =>
									value
										.split("/")
										.every((segment) => segment !== "." && segment !== ".."),
								"Fixture preview paths cannot contain dot segments",
							)
							.optional(),
						note: z.string().min(1),
					})
					.strict(),
			)
			.min(1),
		approval: z
			.object({
				allowed: z.literal(false),
				reason: z.literal("Fixture rehearsals cannot be approved"),
			})
			.strict(),
	})
	.strict();

export const ControlJobViewSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		job: ControlJobRecordSchema,
		snapshot: FixtureDashboardSnapshotSchema,
		events: z
			.array(RunEventSchema)
			.min(1)
			.superRefine((events, context) => {
				events.forEach((event, index) => {
					if (event.sequence !== index + 1) {
						context.addIssue({
							code: "custom",
							path: [index, "sequence"],
							message: "Control job event sequences must be contiguous",
						});
					}
					if (index === 0 && event.state !== "REQUESTED") {
						context.addIssue({
							code: "custom",
							path: [index, "state"],
							message: "A control event log must begin at REQUESTED",
						});
					}
					const previous = events[index - 1];
					if (
						previous &&
						!StateTransitionSchema.safeParse({
							schemaVersion: SCHEMA_VERSION,
							jobId: event.jobId,
							runId: event.runId,
							mode: event.mode,
							from: previous.state,
							to: event.state,
						}).success
					) {
						context.addIssue({
							code: "custom",
							path: [index, "state"],
							message: "Control event log contains an invalid state transition",
						});
					}
				});
			}),
	})
	.strict()
	.superRefine((view, context) => {
		if (
			view.job.jobId !== view.snapshot.jobId ||
			view.job.runId !== view.snapshot.runId
		) {
			context.addIssue({
				code: "custom",
				message: "Control job and fixture snapshot provenance do not match",
			});
		}
		if (
			view.snapshot.completion.status === "REHEARSAL_COMPLETE" &&
			view.job.state !== "INCONCLUSIVE"
		) {
			context.addIssue({
				code: "custom",
				message:
					"Fixture rehearsal completion requires terminal INCONCLUSIVE state",
			});
		}
		const eventProvenanceMismatch = view.events.some(
			(event) =>
				event.jobId !== view.job.jobId ||
				event.runId !== view.job.runId ||
				event.mode !== view.job.mode,
		);
		if (eventProvenanceMismatch) {
			context.addIssue({
				code: "custom",
				message: "Control events do not match their job provenance",
			});
		}
		const lastEvent = view.events.at(-1);
		if (
			!lastEvent ||
			lastEvent.state !== view.job.state ||
			lastEvent.sequence !== view.job.lastSequence
		) {
			context.addIssue({
				code: "custom",
				message: "Control job projection does not match its event log",
			});
		}
	});

export const ANALYSIS_OUTPUT_VERSION = "analysis-output-v1" as const;
export const ANALYSIS_PROMPT_VERSION = "analysis-prompt-v1" as const;
export const REAL_ANALYSIS_VERSION = "real-analysis-v1" as const;
export const FIXTURE_ANALYSIS_VERSION = "fixture-analysis-v1" as const;
export const CODEX_CLI_VERSION = "0.139.0" as const;
export const CODEX_MODEL = "gpt-5.6-sol" as const;
export const MODEL_BACKEND = "codex-cli-chatgpt" as const;
export const MODEL_AUTH_MODE = "chatgpt-subscription" as const;

export const AnalysisHypothesisSchema = z
	.object({
		rank: z.number().int().min(1).max(SEED_IDS.length),
		code: SeedIdSchema,
		explanation: z.string().trim().min(1).max(2_000),
		artifactRefs: z
			.array(ArtifactReferenceSchema)
			.min(1)
			.max(8)
			.superRefine((references, context) => {
				if (new Set(references).size !== references.length) {
					context.addIssue({
						code: "custom",
						message: "Hypothesis artifact references must be unique",
					});
				}
			}),
		falsifier: z.string().trim().min(1).max(1_000),
	})
	.strict();

export const AnalysisModelOutputSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		hypotheses: z
			.array(AnalysisHypothesisSchema)
			.length(SEED_IDS.length)
			.superRefine((hypotheses, context) => {
				hypotheses.forEach((hypothesis, index) => {
					const expectedRank = index + 1;
					if (hypothesis.rank !== expectedRank) {
						context.addIssue({
							code: "custom",
							path: [index, "rank"],
							message: `Hypothesis ranks must be unique and contiguous beginning at 1; expected rank ${expectedRank}`,
						});
					}
				});
				const codes = hypotheses.map(({ code }) => code);
				for (const seedId of SEED_IDS) {
					if (!codes.includes(seedId)) {
						context.addIssue({
							code: "custom",
							message: `Analysis must cover the frozen seed exactly once: ${seedId}`,
						});
					}
				}
				if (new Set(codes).size !== codes.length) {
					context.addIssue({
						code: "custom",
						message: "Analysis hypothesis codes must be unique",
					});
				}
			}),
		recommendedRegressionAssertion: z.string().trim().min(1).max(1_000),
		uncertainty: z
			.array(z.string().trim().min(1).max(500))
			.max(8)
			.superRefine((items, context) => {
				if (new Set(items).size !== items.length) {
					context.addIssue({
						code: "custom",
						message: "Analysis uncertainty items must be unique",
					});
				}
			}),
	})
	.strict();

export const CodexUsageSchema = z
	.object({
		inputTokens: z.number().int().nonnegative(),
		cachedInputTokens: z.number().int().nonnegative(),
		outputTokens: z.number().int().nonnegative(),
		reasoningOutputTokens: z.number().int().nonnegative(),
	})
	.strict();

export const AnalysisInputArtifactSchema = z
	.object({
		path: ArtifactPathSchema,
		size: z.number().int().nonnegative(),
		sha256: Sha256Schema,
	})
	.strict();

const AnalysisTimingFields = {
	startedAt: TimestampSchema,
	completedAt: TimestampSchema,
	durationMs: z.number().finite().nonnegative(),
} as const;

export const AnalysisReportSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		recordVersion: z.literal(REAL_ANALYSIS_VERSION),
		mode: z.literal("real"),
		analysisId: EntityIdSchema,
		baselineRunId: EntityIdSchema,
		backend: z.literal(MODEL_BACKEND),
		authMode: z.literal(MODEL_AUTH_MODE),
		cliVersion: z.literal(CODEX_CLI_VERSION),
		model: z.string().trim().min(1).nullable(),
		threadId: z.string().uuid(),
		terminalStatus: z.literal("turn.completed"),
		usage: CodexUsageSchema,
		...AnalysisTimingFields,
		exitStatus: z.literal(0),
		retryCount: z.union([z.literal(0), z.literal(1)]),
		promptVersion: z.literal(ANALYSIS_PROMPT_VERSION),
		promptTemplateHash: Sha256Schema,
		renderedPromptHash: Sha256Schema,
		outputSchemaVersion: z.literal(ANALYSIS_OUTPUT_VERSION),
		outputSchemaHash: Sha256Schema,
		inputIndexHash: Sha256Schema,
		inputRootHash: Sha256Schema,
		/** Fresh M5 analyses bind the no-Git source revision used by repair admission. */
		sourceRevision: z
			.string()
			.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64}|sha256:[a-f0-9]{64})$/)
			.optional(),
		/** Fresh M5 analyses also bind the complete trusted projection/tooling tree. */
		toolingRevision: Sha256Schema.optional(),
		inputArtifacts: z
			.array(AnalysisInputArtifactSchema)
			.length(EVIDENCE_REQUIRED_ARTIFACTS.length),
		inputArtifactHashes: z
			.array(Sha256Schema)
			.length(EVIDENCE_REQUIRED_ARTIFACTS.length),
		allowedArtifactRefs: z
			.array(ArtifactReferenceSchema)
			.min(EVIDENCE_REQUIRED_ARTIFACTS.length)
			.max(128)
			.superRefine((references, context) => {
				if (new Set(references).size !== references.length) {
					context.addIssue({
						code: "custom",
						message: "Allowed analysis artifact references must be unique",
					});
				}
			}),
		finalOutputHash: Sha256Schema,
		hypotheses: AnalysisModelOutputSchema.shape.hypotheses,
		recommendedRegressionAssertion:
			AnalysisModelOutputSchema.shape.recommendedRegressionAssertion,
		uncertainty: AnalysisModelOutputSchema.shape.uncertainty,
	})
	.strict()
	.superRefine((report, context) => {
		if (Date.parse(report.completedAt) < Date.parse(report.startedAt)) {
			context.addIssue({
				code: "custom",
				path: ["completedAt"],
				message: "Analysis completion cannot precede its start",
			});
		}
		const expectedPaths = [...EVIDENCE_REQUIRED_ARTIFACTS].sort((left, right) =>
			left.localeCompare(right),
		);
		const paths = report.inputArtifacts.map(
			({ path: artifactPath }) => artifactPath,
		);
		if (
			paths.some((artifactPath, index) => artifactPath !== expectedPaths[index])
		) {
			context.addIssue({
				code: "custom",
				path: ["inputArtifacts"],
				message:
					"Analysis input artifacts must be the sorted required evidence set",
			});
		}
		const hashes = report.inputArtifacts.map(({ sha256 }) => sha256);
		if (
			hashes.some((hash, index) => hash !== report.inputArtifactHashes[index])
		) {
			context.addIssue({
				code: "custom",
				path: ["inputArtifactHashes"],
				message: "Analysis input hashes must match the ordered artifacts",
			});
		}
		const allowedBasePaths = report.allowedArtifactRefs.filter(
			(reference) => !reference.includes("#"),
		);
		if (
			allowedBasePaths.some((reference, index) => reference !== paths[index]) ||
			allowedBasePaths.length !== paths.length
		) {
			context.addIssue({
				code: "custom",
				path: ["allowedArtifactRefs"],
				message:
					"Allowed analysis references must contain the sorted admitted base paths",
			});
		}
		const allowedReferences = new Set(report.allowedArtifactRefs);
		report.hypotheses.forEach((hypothesis, hypothesisIndex) => {
			hypothesis.artifactRefs.forEach((reference, referenceIndex) => {
				if (!allowedReferences.has(reference)) {
					context.addIssue({
						code: "custom",
						path: [
							"hypotheses",
							hypothesisIndex,
							"artifactRefs",
							referenceIndex,
						],
						message:
							"Analysis citations must match the verifier-owned admitted reference catalog",
					});
				}
			});
		});
	});

export const MODEL_ADAPTER_ERROR_CODES = [
	"MODEL_ENV_FORBIDDEN",
	"MODEL_CLI_NOT_FOUND",
	"MODEL_CLI_IDENTITY_INVALID",
	"MODEL_CLI_VERSION_UNSUPPORTED",
	"MODEL_AUTH_NOT_CHATGPT",
	"MODEL_EVIDENCE_REJECTED",
	"MODEL_INPUT_LIMIT",
	"MODEL_SPAWN_FAILED",
	"MODEL_TIMEOUT",
	"MODEL_OUTPUT_LIMIT",
	"MODEL_PROCESS_EXIT",
	"MODEL_PROCESS_SIGNAL",
	"MODEL_PROCESS_TERMINATION_FAILED",
	"MODEL_PROTOCOL_INVALID",
	"MODEL_PROTOCOL_UNSUPPORTED",
	"MODEL_TURN_FAILED",
	"MODEL_REFUSAL",
	"MODEL_AUTH_LOST",
	"MODEL_QUOTA_EXHAUSTED",
	"MODEL_UNAVAILABLE",
	"MODEL_RESULT_MISSING",
	"MODEL_RESULT_INVALID_JSON",
	"MODEL_RESULT_SCHEMA_INVALID",
	"MODEL_RESULT_CHANNEL_MISMATCH",
	"MODEL_CITATION_INVALID",
	"MODEL_WORKSPACE_TAMPERED",
	"MODEL_WORKSPACE_CLEANUP_FAILED",
	"MODEL_PERSISTENCE_FAILED",
	"MODEL_CLI_TRANSIENT",
] as const;
export const ModelAdapterErrorCodeSchema = z.enum(MODEL_ADAPTER_ERROR_CODES);
export const AnalysisStageSchema = z.enum([
	"admission",
	"preflight",
	"workspace",
	"invocation",
	"protocol",
	"result",
	"cleanup",
	"persistence",
]);

const AnalysisAttemptBaseSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		recordVersion: z.literal("analysis-attempt-v1"),
		mode: z.literal("real"),
		analysisId: EntityIdSchema,
		baselineRunId: EntityIdSchema,
		backend: z.literal(MODEL_BACKEND),
		authMode: z.literal(MODEL_AUTH_MODE),
		attempt: z.union([z.literal(1), z.literal(2)]),
		stage: AnalysisStageSchema,
		...AnalysisTimingFields,
	})
	.strict();

export const AnalysisAttemptRecordSchema = z
	.discriminatedUnion("status", [
		AnalysisAttemptBaseSchema.extend({
			status: z.literal("SUCCESS"),
			cliVersion: z.literal(CODEX_CLI_VERSION),
			threadId: z.string().uuid(),
			terminalStatus: z.literal("turn.completed"),
			usage: CodexUsageSchema,
			exitStatus: z.literal(0),
			signal: z.null(),
			errorCode: z.null(),
			retryable: z.literal(false),
		}).strict(),
		AnalysisAttemptBaseSchema.extend({
			status: z.literal("FAILURE"),
			cliVersion: z.string().trim().min(1).nullable(),
			threadId: z.string().uuid().nullable(),
			terminalStatus: z.enum(["turn.completed", "turn.failed"]).nullable(),
			usage: CodexUsageSchema.nullable(),
			exitStatus: z.number().int().nullable(),
			signal: z.string().trim().min(1).max(64).nullable(),
			errorCode: ModelAdapterErrorCodeSchema,
			retryable: z.boolean(),
		}).strict(),
	])
	.superRefine((attempt, context) => {
		if (Date.parse(attempt.completedAt) < Date.parse(attempt.startedAt)) {
			context.addIssue({
				code: "custom",
				path: ["completedAt"],
				message: "Analysis attempt completion cannot precede its start",
			});
		}
	});

export const FixtureAnalysisSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		recordVersion: z.literal(FIXTURE_ANALYSIS_VERSION),
		mode: z.literal("fixture"),
		provenance: z.literal("fixture"),
		fixtureVersion: z.literal("golden-control-v1"),
		analysisId: EntityIdSchema,
		baselineRunId: EntityIdSchema,
		hypotheses: AnalysisModelOutputSchema.shape.hypotheses,
		recommendedRegressionAssertion:
			AnalysisModelOutputSchema.shape.recommendedRegressionAssertion,
		uncertainty: AnalysisModelOutputSchema.shape.uncertainty,
		approvalAllowed: z.literal(false),
	})
	.strict();

export const CandidateRecordSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		candidateId: EntityIdSchema,
		jobId: EntityIdSchema,
		runId: EntityIdSchema,
		baselineRunId: EntityIdSchema,
		mode: ExecutionModeSchema,
		diffHash: Sha256Schema,
		state: z.enum([
			"SANDBOX_GATING",
			"VERIFYING_CLEAN",
			"READY_FOR_HUMAN_REVIEW",
			"REJECTED",
		]),
	})
	.strict()
	.superRefine(({ mode, state }, context) => {
		if (mode === "fixture" && state === "READY_FOR_HUMAN_REVIEW") {
			context.addIssue({
				code: "custom",
				path: ["state"],
				message: "Fixture candidates cannot be ready for human review",
			});
		}
	});

// Milestone 5 repair-loop contracts. These are deliberately separate from the
// M6 CandidateRecord above: model output contains only the operation and diff
// bytes, while trusted code supplies hashes, provenance, and command evidence.
export const AUTHORING_DIFF_VERSION = "unified-diff-v1" as const;
export const SOURCE_SNAPSHOT_VERSION = "source-snapshot-v1" as const;
export const TEST_FAILURE_PROOF_VERSION = "test-failure-proof-v1" as const;
export const CANDIDATE_POLICY_EVIDENCE_VERSION = "candidate-policy-v1" as const;
export const SANDBOX_COMMAND_EVIDENCE_VERSION = "sandbox-command-v1" as const;
export const M5_CANDIDATE_VERSION = "m5-candidate-v1" as const;

/** Fixed verifier-owned bindings for the first M5 mononym slice. */
export const M5_TEST_TARGET =
	"apps/target/test/repair-mononym.test.mjs" as const;
export const M5_BASELINE_ORACLE_TARGET =
	"apps/target/test/repair-mononym-baseline-oracle.test.mjs" as const;
export const M5_INVARIANT_TARGET =
	"apps/target/test/repair-mononym-invariants.test.mjs" as const;
export const M5_TEST_COMMAND_ID = "test-regression" as const;
export const M5_TEST_COMMAND_ARGV = Object.freeze([
	"node",
	"--experimental-strip-types",
	"--test",
	M5_TEST_TARGET,
	M5_BASELINE_ORACLE_TARGET,
] as const);
export const M5_TEST_COMMAND_ARGV_DIGEST =
	"3cc71c25cc3875cacc130e9f171b958018001505d9b7e941dd822a10d81a91a6" as const;
export const M5_MONONYM_ASSERTION_ID =
	"seed.mononym-required-last-name" as const;
export const M5_MONONYM_ASSERTION_FRAGMENT = "required last name" as const;
export const M5_CANDIDATE_COMMAND_ID = "candidate-check" as const;
export const M5_CANDIDATE_COMMAND_ARGV = Object.freeze([
	"node",
	"--experimental-strip-types",
	"--test",
	M5_TEST_TARGET,
	M5_INVARIANT_TARGET,
] as const);
export const M5_CANDIDATE_COMMAND_ARGV_DIGEST =
	"fb8beeb2c225a1b24c3333db62ebbbc55ee47a4a0f19c897f9c673b71e57c5eb" as const;
/** The inspected runtime binding supplied for the approved one-seed smoke. */
export const M5_INSPECTED_IMAGE =
	"node@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2" as const;
export const M5_SANDBOX_ENTRYPOINT_SCRIPT =
	"scripts/roveproof-sandbox-runner.mjs" as const;
export const M5_SANDBOX_COMMAND_ID_SCHEMA = z.enum([
	M5_TEST_COMMAND_ID,
	M5_CANDIDATE_COMMAND_ID,
]);
const M5_SANDBOX_COMMAND_ARGV_DIGESTS = Object.freeze({
	[M5_TEST_COMMAND_ID]: M5_TEST_COMMAND_ARGV_DIGEST,
	[M5_CANDIDATE_COMMAND_ID]: M5_CANDIDATE_COMMAND_ARGV_DIGEST,
} as const);

const AuthoringDiffTextSchema = z
	.string()
	.min(1)
	.max(1024 * 1024);

export const TestAuthoringDiffSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		operation: z.literal("test-only"),
		unifiedDiff: AuthoringDiffTextSchema,
	})
	.strict();

export const SourceAuthoringDiffSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		operation: z.literal("source-only"),
		unifiedDiff: AuthoringDiffTextSchema,
	})
	.strict();

function isCanonicalDiffPath(value: string): boolean {
	if (
		value.length === 0 ||
		value !== value.trim() ||
		value.includes("\\") ||
		value.includes("\0")
	)
		return false;
	if (
		value.startsWith("/") ||
		value.startsWith("//") ||
		/^[A-Za-z]:/.test(value)
	)
		return false;
	const segments = value.split("/");
	return segments.every(
		(segment) =>
			segment.length > 0 &&
			segment !== "." &&
			segment !== ".." &&
			!segment.endsWith(".") &&
			!segment.endsWith(" ") &&
			/^[a-z0-9][a-z0-9._-]*$/.test(segment),
	);
}

export const DiffPathSchema = z
	.string()
	.refine(
		isCanonicalDiffPath,
		"Path must be canonical, relative, and traversal-free",
	);
const DiffFileMetadataSchema = z
	.object({
		path: DiffPathSchema,
		additions: z.number().int().nonnegative(),
		deletions: z.number().int().nonnegative(),
		hunkCount: z.number().int().positive(),
	})
	.strict();

export const CanonicalDiffMetadataSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		format: z.literal(AUTHORING_DIFF_VERSION),
		operation: z.enum(["test-only", "source-only"]),
		diffHash: Sha256Schema,
		files: z.array(DiffFileMetadataSchema).min(1).max(5),
		additions: z.number().int().nonnegative(),
		deletions: z.number().int().nonnegative(),
		changedLines: z.number().int().nonnegative().max(250),
	})
	.strict()
	.superRefine((metadata, context) => {
		const paths = metadata.files.map(({ path: filePath }) => filePath);
		if (new Set(paths).size !== paths.length) {
			context.addIssue({
				code: "custom",
				path: ["files"],
				message: "Diff metadata paths must be unique",
			});
		}
		if (metadata.changedLines !== metadata.additions + metadata.deletions) {
			context.addIssue({
				code: "custom",
				path: ["changedLines"],
				message: "Changed lines must equal additions plus deletions",
			});
		}
	});

export const AUTHORING_ERROR_CODES = [
	"AUTHORING_ENV_FORBIDDEN",
	"AUTHORING_ORDER_VIOLATION",
	"AUTHORING_PROVENANCE_REJECTED",
	"AUTHORING_DIFF_INVALID",
	"AUTHORING_POLICY_REJECTED",
	"AUTHORING_TEST_PROOF_REQUIRED",
	"AUTHORING_SANDBOX_REJECTED",
	"AUTHORING_PROCESS_FAILED",
	"AUTHORING_TIMEOUT",
	"AUTHORING_OUTPUT_LIMIT",
	"AUTHORING_RESULT_INVALID",
] as const;
export const AuthoringErrorCodeSchema = z.enum(AUTHORING_ERROR_CODES);
export const AuthoringOperationSchema = z.enum(["test-only", "source-only"]);

const AttemptTimingFields = {
	startedAt: TimestampSchema,
	completedAt: TimestampSchema,
	durationMs: z.number().finite().nonnegative(),
} as const;
const AuthoringAttemptBaseSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		recordVersion: z.literal("authoring-attempt-v1"),
		mode: z.literal("real"),
		attempt: z.literal(1),
		operation: AuthoringOperationSchema,
		authoringId: EntityIdSchema,
		baselineRunId: EntityIdSchema,
		sourceSnapshotHash: Sha256Schema,
		...AttemptTimingFields,
	})
	.strict();

export const AuthoringAttemptRecordSchema = z
	.discriminatedUnion("status", [
		AuthoringAttemptBaseSchema.extend({
			status: z.literal("SUCCESS"),
			cliVersion: z.literal(CODEX_CLI_VERSION),
			authMode: z.literal(MODEL_AUTH_MODE),
			threadId: z.string().uuid(),
			usage: CodexUsageSchema,
			exitStatus: z.literal(0),
			signal: z.null(),
			diffHash: Sha256Schema,
			errorCode: z.null(),
		}).strict(),
		AuthoringAttemptBaseSchema.extend({
			status: z.literal("FAILURE"),
			cliVersion: z.string().trim().min(1).nullable(),
			authMode: z.literal(MODEL_AUTH_MODE).nullable(),
			threadId: z.string().uuid().nullable(),
			usage: CodexUsageSchema.nullable(),
			exitStatus: z.number().int().nullable(),
			signal: z.string().trim().min(1).max(64).nullable(),
			diffHash: Sha256Schema.nullable(),
			errorCode: AuthoringErrorCodeSchema,
		}).strict(),
	])
	.superRefine((attempt, context) => {
		if (Date.parse(attempt.completedAt) < Date.parse(attempt.startedAt)) {
			context.addIssue({
				code: "custom",
				path: ["completedAt"],
				message: "Authoring completion cannot precede its start",
			});
		}
	});

const SnapshotFileSchema = z
	.object({
		path: DiffPathSchema,
		size: z.number().int().nonnegative(),
		sha256: Sha256Schema,
	})
	.strict();

export const SANDBOX_CONTROL_VERSION = "sandbox-control-v1" as const;
export const SANDBOX_RESULT_VERSION = "sandbox-result-v1" as const;
export const SANDBOX_STAGES = ["test-proof", "combined"] as const;
export const SandboxStageSchema = z.enum(SANDBOX_STAGES);
export const SANDBOX_CLASSIFICATIONS = [
	"EXPECTED_FAILURE",
	"TEST_DID_NOT_FAIL",
	"TEST_WRONG_FAILURE",
	"TEST_SETUP_FAILURE",
	"TEST_TIMEOUT",
	"TEST_RESOURCE_LIMIT",
	"TEST_OUTPUT_LIMIT",
	"CANDIDATE_PASS",
	"CANDIDATE_TEST_FAILURE",
	"CANDIDATE_SETUP_FAILURE",
	"CANDIDATE_TIMEOUT",
	"CANDIDATE_RESOURCE_LIMIT",
	"CANDIDATE_OUTPUT_LIMIT",
	"CONTROL_INVALID",
	"PATCH_APPLY_REJECTED",
	"EXPORT_VIOLATION",
	"SECRET_DETECTED",
	"INFRASTRUCTURE_UNAVAILABLE",
	"PROTOCOL_FAILURE",
] as const;
export const SandboxClassificationSchema = z.enum(SANDBOX_CLASSIFICATIONS);
const Base64BytesSchema = z
	.string()
	.min(1)
	.max(2 * 1024 * 1024)
	.regex(/^[A-Za-z0-9+/]+={0,2}$/, "Expected bounded base64 bytes");

function canonicalContractJson(value: unknown): string {
	if (Array.isArray(value))
		return `[${value.map(canonicalContractJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(
				(key) => `${JSON.stringify(key)}:${canonicalContractJson(record[key])}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export const SandboxControlSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		recordVersion: z.literal(SANDBOX_CONTROL_VERSION),
		stage: SandboxStageSchema,
		commandId: M5_SANDBOX_COMMAND_ID_SCHEMA,
		sourceSnapshotHash: Sha256Schema,
		snapshotFiles: z.array(SnapshotFileSchema).min(1).max(512),
		testDiffBase64: Base64BytesSchema,
		testDiffHash: Sha256Schema,
		sourceDiffBase64: Base64BytesSchema.nullable(),
		sourceDiffHash: Sha256Schema.nullable(),
		combinedDiffBase64: Base64BytesSchema.nullable(),
		combinedDiffHash: Sha256Schema.nullable(),
		toolingRevision: Sha256Schema,
		expectedSeedId: z.literal(SEED_IDS[0]),
		assertionId: z.literal(M5_MONONYM_ASSERTION_ID),
		assertionFragment: z.literal(M5_MONONYM_ASSERTION_FRAGMENT),
		controlHash: Sha256Schema,
	})
	.strict()
	.superRefine((control, context) => {
		const expectedCommand =
			control.stage === "test-proof"
				? M5_TEST_COMMAND_ID
				: M5_CANDIDATE_COMMAND_ID;
		if (control.commandId !== expectedCommand)
			context.addIssue({
				code: "custom",
				path: ["commandId"],
				message: "Sandbox stage is bound to a fixed command ID",
			});
		const testBytes = Buffer.from(control.testDiffBase64, "base64");
		if (
			testBytes.length === 0 ||
			createHash("sha256").update(testBytes).digest("hex") !==
				control.testDiffHash
		)
			context.addIssue({
				code: "custom",
				path: ["testDiffHash"],
				message: "Test diff bytes do not match their hash",
			});
		if (
			control.stage === "test-proof" &&
			(control.sourceDiffBase64 !== null ||
				control.sourceDiffHash !== null ||
				control.combinedDiffBase64 !== null ||
				control.combinedDiffHash !== null)
		) {
			context.addIssue({
				code: "custom",
				path: ["stage"],
				message: "Test-proof control cannot carry source or combined bytes",
			});
		}
		if (
			control.stage === "combined" &&
			(control.sourceDiffBase64 === null ||
				control.sourceDiffHash === null ||
				control.combinedDiffBase64 === null ||
				control.combinedDiffHash === null)
		) {
			context.addIssue({
				code: "custom",
				path: ["stage"],
				message: "Combined control must carry source and combined bytes",
			});
		}
		if (
			control.sourceDiffBase64 !== null &&
			control.sourceDiffHash !== null &&
			createHash("sha256")
				.update(Buffer.from(control.sourceDiffBase64, "base64"))
				.digest("hex") !== control.sourceDiffHash
		)
			context.addIssue({
				code: "custom",
				path: ["sourceDiffHash"],
				message: "Source diff bytes do not match their hash",
			});
		if (
			control.combinedDiffBase64 !== null &&
			control.combinedDiffHash !== null &&
			createHash("sha256")
				.update(Buffer.from(control.combinedDiffBase64, "base64"))
				.digest("hex") !== control.combinedDiffHash
		)
			context.addIssue({
				code: "custom",
				path: ["combinedDiffHash"],
				message: "Combined diff bytes do not match their hash",
			});
		if (
			control.stage === "combined" &&
			control.sourceDiffBase64 !== null &&
			control.combinedDiffBase64 !== null
		) {
			const expectedCombined = Buffer.concat([
				Buffer.from(control.testDiffBase64, "base64"),
				Buffer.from("\n"),
				Buffer.from(control.sourceDiffBase64, "base64"),
			]);
			if (
				!expectedCombined.equals(
					Buffer.from(control.combinedDiffBase64, "base64"),
				)
			)
				context.addIssue({
					code: "custom",
					path: ["combinedDiffBase64"],
					message:
						"Combined diff bytes must equal test bytes, newline, and source bytes",
				});
		}
		const withoutHash = { ...control } as Record<string, unknown>;
		delete withoutHash.controlHash;
		if (
			createHash("sha256")
				.update(canonicalContractJson(withoutHash), "utf8")
				.digest("hex") !== control.controlHash
		)
			context.addIssue({
				code: "custom",
				path: ["controlHash"],
				message: "Sandbox control hash is invalid",
			});
	});

export function hashSandboxControl(
	controlInput: Omit<z.input<typeof SandboxControlSchema>, "controlHash">,
): string {
	return createHash("sha256")
		.update(canonicalContractJson(controlInput), "utf8")
		.digest("hex");
}

export const SourceSnapshotSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		recordVersion: z.literal(SOURCE_SNAPSHOT_VERSION),
		sourceRevision: z
			.string()
			.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64}|sha256:[a-f0-9]{64})$/),
		/** Digest of the exact files copied into the disposable candidate projection. */
		projectionRevision: Sha256Schema,
		/** Digest of the complete trusted M5 host/tooling manifest. */
		toolingRevision: Sha256Schema,
		toolingFiles: z.array(SnapshotFileSchema).min(1).max(2048),
		baselineRunId: EntityIdSchema,
		expectedIndexHash: Sha256Schema,
		expectedRootHash: Sha256Schema,
		analysisId: EntityIdSchema,
		expectedAnalysisHash: Sha256Schema,
		files: z.array(SnapshotFileSchema).min(1).max(512),
		snapshotHash: Sha256Schema,
	})
	.strict()
	.superRefine((snapshot, context) => {
		const paths = snapshot.files.map(({ path: filePath }) => filePath);
		if (new Set(paths).size !== paths.length) {
			context.addIssue({
				code: "custom",
				path: ["files"],
				message: "Source snapshot paths must be unique",
			});
		}
		const sorted = [...paths].sort((left, right) => left.localeCompare(right));
		if (paths.some((filePath, index) => filePath !== sorted[index])) {
			context.addIssue({
				code: "custom",
				path: ["files"],
				message: "Source snapshot files must be in canonical order",
			});
		}
		const toolingPaths = snapshot.toolingFiles.map(
			({ path: filePath }) => filePath,
		);
		if (new Set(toolingPaths).size !== toolingPaths.length) {
			context.addIssue({
				code: "custom",
				path: ["toolingFiles"],
				message: "Tooling manifest paths must be unique",
			});
		}
		const sortedToolingPaths = [...toolingPaths].sort((left, right) =>
			left.localeCompare(right),
		);
		if (
			toolingPaths.some(
				(filePath, index) => filePath !== sortedToolingPaths[index],
			)
		) {
			context.addIssue({
				code: "custom",
				path: ["toolingFiles"],
				message: "Tooling manifest files must be in canonical order",
			});
		}
		const withoutHash = { ...snapshot } as Record<string, unknown>;
		delete withoutHash.snapshotHash;
		if (
			createHash("sha256")
				.update(canonicalContractJson(withoutHash), "utf8")
				.digest("hex") !== snapshot.snapshotHash
		) {
			context.addIssue({
				code: "custom",
				path: ["snapshotHash"],
				message: "Source snapshot hash is invalid",
			});
		}
	});

export const CandidateDiffArtifactSchema = z
	.object({
		operation: z.enum(["test-only", "source-only", "combined"]),
		artifactPath: DiffPathSchema,
		byteLength: z
			.number()
			.int()
			.positive()
			.max(2 * 1024 * 1024),
		sha256: Sha256Schema,
	})
	.strict();

export const TestFailureProofSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		recordVersion: z.literal(TEST_FAILURE_PROOF_VERSION),
		baselineRunId: EntityIdSchema,
		sourceSnapshotHash: Sha256Schema,
		testDiffHash: Sha256Schema,
		sourceRevision: z
			.string()
			.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64}|sha256:[a-f0-9]{64})$/),
		toolingRevision: Sha256Schema,
		commandId: z.literal(M5_TEST_COMMAND_ID),
		argvDigest: z.literal(M5_TEST_COMMAND_ARGV_DIGEST),
		controlHash: Sha256Schema,
		sandboxResultHash: Sha256Schema,
		sandboxEvidenceHash: Sha256Schema,
		exitCode: z.literal(1),
		signal: z.null(),
		classification: z.literal("EXPECTED_FAILURE"),
		expectedSeedId: z.literal(SEED_IDS[0]),
		assertionId: z.literal(M5_MONONYM_ASSERTION_ID),
		assertionFragment: z.literal(M5_MONONYM_ASSERTION_FRAGMENT),
		observedFailureHash: Sha256Schema,
		proofHash: Sha256Schema,
	})
	.strict()
	.superRefine((proof, context) => {
		const withoutHash = { ...proof } as Record<string, unknown>;
		delete withoutHash.proofHash;
		if (
			createHash("sha256")
				.update(canonicalContractJson(withoutHash), "utf8")
				.digest("hex") !== proof.proofHash
		) {
			context.addIssue({
				code: "custom",
				path: ["proofHash"],
				message: "Test-failure proof hash is invalid",
			});
		}
	});

export const CandidatePolicyEvidenceSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		recordVersion: z.literal(CANDIDATE_POLICY_EVIDENCE_VERSION),
		operation: AuthoringOperationSchema,
		sourceSnapshotHash: Sha256Schema,
		diffHash: Sha256Schema,
		filesChanged: z.number().int().nonnegative().max(5),
		linesAdded: z.number().int().nonnegative(),
		linesDeleted: z.number().int().nonnegative(),
		changedLines: z.number().int().nonnegative().max(250),
		accepted: z.boolean(),
		violations: z.array(z.string().trim().min(1).max(256)).max(64),
	})
	.strict()
	.superRefine((evidence, context) => {
		if (evidence.changedLines !== evidence.linesAdded + evidence.linesDeleted) {
			context.addIssue({
				code: "custom",
				path: ["changedLines"],
				message: "Changed lines must equal additions plus deletions",
			});
		}
		if (evidence.accepted && evidence.violations.length > 0) {
			context.addIssue({
				code: "custom",
				path: ["violations"],
				message: "Accepted policy evidence cannot contain violations",
			});
		}
		if (!evidence.accepted && evidence.violations.length === 0) {
			context.addIssue({
				code: "custom",
				path: ["violations"],
				message: "Rejected policy evidence must explain a violation",
			});
		}
	});

export const SandboxResultSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		recordVersion: z.literal(SANDBOX_RESULT_VERSION),
		stage: SandboxStageSchema,
		commandId: M5_SANDBOX_COMMAND_ID_SCHEMA,
		controlHash: Sha256Schema,
		started: z.boolean(),
		exitCode: z.number().int().nullable(),
		signal: z.string().trim().min(1).max(64).nullable(),
		timedOut: z.boolean(),
		outputLimitExceeded: z.boolean(),
		resourceLimitExceeded: z.boolean(),
		setupError: z.string().trim().min(1).max(256).nullable(),
		protocolError: z.string().trim().min(1).max(256).nullable(),
		patchApplyError: z.string().trim().min(1).max(256).nullable(),
		exportViolation: z.string().trim().min(1).max(256).nullable(),
		secretDetected: z.boolean(),
		infrastructureError: z.string().trim().min(1).max(256).nullable(),
		stdoutSha256: Sha256Schema,
		stderrSha256: Sha256Schema,
		appliedDiffHash: Sha256Schema.nullable(),
		matchedExpectedFailure: z.boolean(),
		observedFailureHash: Sha256Schema.nullable(),
		resultHash: Sha256Schema,
	})
	.strict()
	.superRefine((result, context) => {
		const withoutHash = { ...result } as Record<string, unknown>;
		delete withoutHash.resultHash;
		if (
			createHash("sha256")
				.update(canonicalContractJson(withoutHash), "utf8")
				.digest("hex") !== result.resultHash
		)
			context.addIssue({
				code: "custom",
				path: ["resultHash"],
				message: "Sandbox result hash is invalid",
			});
		if (!result.started && (result.exitCode !== null || result.signal !== null))
			context.addIssue({
				code: "custom",
				path: ["exitCode"],
				message: "A non-started sandbox cannot contain a process result",
			});
	});

export const SandboxCommandEvidenceSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		recordVersion: z.literal(SANDBOX_COMMAND_EVIDENCE_VERSION),
		stage: SandboxStageSchema,
		commandId: M5_SANDBOX_COMMAND_ID_SCHEMA,
		classification: SandboxClassificationSchema,
		argvDigest: Sha256Schema,
		image: z.string().regex(/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/),
		network: z.literal("none"),
		readOnlyRoot: z.literal(true),
		pullPolicy: z.literal("never"),
		capabilitiesDropped: z.literal("ALL"),
		noNewPrivileges: z.literal(true),
		pidsLimit: z.number().int().positive().max(128),
		memoryLimit: z.string().regex(/^[1-9][0-9]*(?:m|g)$/),
		cpuLimit: z.string().regex(/^\d+(?:\.\d+)?$/),
		timeoutMs: z.number().int().positive().max(300_000),
		started: z.boolean(),
		exitCode: z.number().int().nullable(),
		signal: z.string().trim().min(1).max(64).nullable(),
		timedOut: z.boolean(),
		outputLimitExceeded: z.boolean(),
		resourceLimitExceeded: z.boolean(),
		setupError: z.string().trim().min(1).max(256).nullable(),
		protocolError: z.string().trim().min(1).max(256).nullable(),
		patchApplyError: z.string().trim().min(1).max(256).nullable(),
		secretDetected: z.boolean(),
		infrastructureError: z.string().trim().min(1).max(256).nullable(),
		exportViolation: z.string().trim().min(1).max(256).nullable(),
		stdoutSha256: Sha256Schema,
		stderrSha256: Sha256Schema,
		toolingRevision: Sha256Schema,
		controlHash: Sha256Schema,
		resultHash: Sha256Schema,
		evidenceHash: Sha256Schema,
		durationMs: z.number().finite().nonnegative(),
		exportedFiles: z.array(SnapshotFileSchema),
	})
	.strict()
	.superRefine((evidence, context) => {
		if (
			evidence.argvDigest !==
			M5_SANDBOX_COMMAND_ARGV_DIGESTS[evidence.commandId]
		)
			context.addIssue({
				code: "custom",
				path: ["argvDigest"],
				message:
					"Sandbox command argv digest does not match its fixed command ID",
			});
		const withoutHash = { ...evidence } as Record<string, unknown>;
		delete withoutHash.evidenceHash;
		if (
			createHash("sha256")
				.update(canonicalContractJson(withoutHash), "utf8")
				.digest("hex") !== evidence.evidenceHash
		)
			context.addIssue({
				code: "custom",
				path: ["evidenceHash"],
				message: "Sandbox evidence hash is invalid",
			});
		if (
			!evidence.started &&
			(evidence.exitCode !== null || evidence.signal !== null)
		)
			context.addIssue({
				code: "custom",
				path: ["exitCode"],
				message: "A command that did not start cannot have a process result",
			});
		if (evidence.started && evidence.infrastructureError !== null)
			context.addIssue({
				code: "custom",
				path: ["infrastructureError"],
				message:
					"Started commands cannot report an infrastructure preflight error",
			});
	});

export const M5CandidateEnvelopeSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		recordVersion: z.literal(M5_CANDIDATE_VERSION),
		candidateId: EntityIdSchema,
		baselineRunId: EntityIdSchema,
		analysisId: EntityIdSchema,
		expectedIndexHash: Sha256Schema,
		expectedRootHash: Sha256Schema,
		expectedAnalysisHash: Sha256Schema,
		sourceRevision: z
			.string()
			.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64}|sha256:[a-f0-9]{64})$/),
		toolingRevision: Sha256Schema,
		sourceSnapshotHash: Sha256Schema,
		testDiffHash: Sha256Schema,
		sourceDiffHash: Sha256Schema,
		combinedDiffHash: Sha256Schema,
		testDiffArtifact: CandidateDiffArtifactSchema,
		sourceDiffArtifact: CandidateDiffArtifactSchema,
		combinedDiffArtifact: CandidateDiffArtifactSchema,
		testFailureProofHash: Sha256Schema,
		testControlHash: Sha256Schema,
		combinedControlHash: Sha256Schema,
		testSandboxEvidenceHash: Sha256Schema,
		combinedSandboxEvidenceHash: Sha256Schema,
		testSandboxResultHash: Sha256Schema,
		combinedSandboxResultHash: Sha256Schema,
		testFailureProof: TestFailureProofSchema,
		testPolicy: CandidatePolicyEvidenceSchema,
		sourcePolicy: CandidatePolicyEvidenceSchema,
		sandbox: z.tuple([
			SandboxCommandEvidenceSchema,
			SandboxCommandEvidenceSchema,
		]),
		state: z.literal("SANDBOX_GATING"),
		outcome: z.literal("PASS"),
	})
	.strict()
	.superRefine((candidate, context) => {
		if (candidate.testFailureProofHash !== candidate.testFailureProof.proofHash)
			context.addIssue({
				code: "custom",
				path: ["testFailureProofHash"],
				message: "Candidate proof hash does not match the proof",
			});
		if (
			candidate.testFailureProof.baselineRunId !== candidate.baselineRunId ||
			candidate.testFailureProof.sourceSnapshotHash !==
				candidate.sourceSnapshotHash ||
			candidate.testFailureProof.testDiffHash !== candidate.testDiffHash ||
			candidate.testFailureProof.sourceRevision !== candidate.sourceRevision ||
			candidate.testFailureProof.toolingRevision !== candidate.toolingRevision
		)
			context.addIssue({
				code: "custom",
				message: "Candidate proof does not match candidate provenance",
			});
		if (
			candidate.testPolicy.operation !== "test-only" ||
			candidate.sourcePolicy.operation !== "source-only" ||
			candidate.testPolicy.diffHash !== candidate.testDiffHash ||
			candidate.sourcePolicy.diffHash !== candidate.sourceDiffHash ||
			candidate.testPolicy.sourceSnapshotHash !==
				candidate.sourceSnapshotHash ||
			candidate.sourcePolicy.sourceSnapshotHash !== candidate.sourceSnapshotHash
		)
			context.addIssue({
				code: "custom",
				message:
					"Candidate policy evidence does not match operation-specific diff hashes",
			});
		if (
			!candidate.testPolicy.accepted ||
			!candidate.sourcePolicy.accepted ||
			candidate.testPolicy.violations.length > 0 ||
			candidate.sourcePolicy.violations.length > 0
		)
			context.addIssue({
				code: "custom",
				path: ["testPolicy"],
				message: "A passing candidate requires two accepted policy records",
			});
		if (
			candidate.testPolicy.filesChanged + candidate.sourcePolicy.filesChanged >
			5
		)
			context.addIssue({
				code: "custom",
				path: ["testPolicy", "filesChanged"],
				message: "Combined candidate file budget exceeds 5",
			});
		if (
			candidate.testPolicy.changedLines + candidate.sourcePolicy.changedLines >
			250
		)
			context.addIssue({
				code: "custom",
				path: ["testPolicy", "changedLines"],
				message: "Combined candidate changed-line budget exceeds 250",
			});
		if (
			candidate.testDiffArtifact.operation !== "test-only" ||
			candidate.sourceDiffArtifact.operation !== "source-only" ||
			candidate.combinedDiffArtifact.operation !== "combined" ||
			candidate.testDiffArtifact.sha256 !== candidate.testDiffHash ||
			candidate.sourceDiffArtifact.sha256 !== candidate.sourceDiffHash ||
			candidate.combinedDiffArtifact.sha256 !== candidate.combinedDiffHash
		)
			context.addIssue({
				code: "custom",
				path: ["testDiffArtifact"],
				message:
					"Candidate artifact bytes are not cross-bound to their operation hashes",
			});
		const [testSandbox, combinedSandbox] = candidate.sandbox;
		if (
			testSandbox.stage !== "test-proof" ||
			testSandbox.commandId !== M5_TEST_COMMAND_ID ||
			testSandbox.controlHash !== candidate.testFailureProof.controlHash ||
			testSandbox.controlHash !== candidate.testControlHash ||
			testSandbox.resultHash !== candidate.testFailureProof.sandboxResultHash ||
			testSandbox.classification !== "EXPECTED_FAILURE" ||
			testSandbox.toolingRevision !== candidate.toolingRevision
		)
			context.addIssue({
				code: "custom",
				path: ["sandbox", 0],
				message:
					"Test sandbox evidence does not cross-bind to the expected-failure proof",
			});
		if (
			combinedSandbox.stage !== "combined" ||
			combinedSandbox.commandId !== M5_CANDIDATE_COMMAND_ID ||
			combinedSandbox.controlHash !== candidate.combinedControlHash ||
			combinedSandbox.classification !== "CANDIDATE_PASS" ||
			combinedSandbox.toolingRevision !== candidate.toolingRevision
		)
			context.addIssue({
				code: "custom",
				path: ["sandbox", 1],
				message:
					"Combined sandbox evidence is not a successful fixed candidate stage",
			});
		if (testSandbox.controlHash === combinedSandbox.controlHash)
			context.addIssue({
				code: "custom",
				path: ["sandbox"],
				message: "Test and combined stages must use distinct controls",
			});
		if (
			candidate.testSandboxEvidenceHash !== testSandbox.evidenceHash ||
			candidate.combinedSandboxEvidenceHash !== combinedSandbox.evidenceHash ||
			candidate.testSandboxResultHash !== testSandbox.resultHash ||
			candidate.combinedSandboxResultHash !== combinedSandbox.resultHash
		)
			context.addIssue({
				code: "custom",
				path: ["sandbox"],
				message:
					"Candidate sandbox evidence/result hashes do not match evidence records",
			});
		for (const [index, evidence] of candidate.sandbox.entries()) {
			if (
				!evidence.started ||
				(index === 1 && evidence.exitCode !== 0) ||
				evidence.signal !== null ||
				evidence.timedOut ||
				evidence.outputLimitExceeded ||
				evidence.resourceLimitExceeded ||
				evidence.infrastructureError !== null ||
				evidence.exportViolation !== null ||
				evidence.protocolError !== null ||
				evidence.patchApplyError !== null ||
				evidence.secretDetected
			)
				context.addIssue({
					code: "custom",
					path: ["sandbox", index],
					message:
						"A passing candidate requires successful started sandbox evidence",
				});
		}
	});

export const RepairStatusRecordSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		recordVersion: z.literal("repair-status-v1"),
		candidateId: EntityIdSchema,
		baselineRunId: EntityIdSchema,
		stage: z.enum([
			"admission",
			"snapshot",
			"preflight",
			"test-authoring",
			"test-policy",
			"test-proof",
			"source-authoring",
			"source-policy",
			"combined",
			"cleanup",
			"sandbox-gating",
		]),
		status: z.enum(["UNVERIFIED", "INCONCLUSIVE", "REJECTED", "PASS"]),
		candidateEnvelopeHash: Sha256Schema.nullable(),
		message: z.string().trim().min(1).max(512),
		occurredAt: TimestampSchema,
	})
	.strict()
	.superRefine((status, context) => {
		if (status.status === "PASS" && status.candidateEnvelopeHash === null)
			context.addIssue({
				code: "custom",
				path: ["candidateEnvelopeHash"],
				message: "PASS status requires a candidate envelope hash",
			});
		if (status.status !== "PASS" && status.candidateEnvelopeHash !== null)
			context.addIssue({
				code: "custom",
				path: ["candidateEnvelopeHash"],
				message: "Only PASS status may bind a candidate envelope",
			});
	});

export const ApprovalDecisionSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		candidateId: EntityIdSchema,
		diffHash: Sha256Schema,
		decision: z.enum(["APPROVED", "REJECTED"]),
		actor: z.string().min(1),
		decidedAt: TimestampSchema,
		comment: z.string().min(1).optional(),
	})
	.strict();

/**
 * The origin input must be loaded from the immutable provenance store, never
 * reconstructed from candidate fields supplied by a caller.
 */
export function validateCandidateForOrigin(
	originInput: unknown,
	candidateInput: unknown,
) {
	const origin = RunOriginSchema.parse(originInput);
	const candidate = CandidateRecordSchema.parse(candidateInput);
	assertMatchingOrigin(origin, candidate);
	return candidate;
}

/** The origin input must be the candidate's record from the immutable provenance store. */
export function validateApprovalForCandidate(
	originInput: unknown,
	candidateInput: unknown,
	decisionInput: unknown,
) {
	const origin = RunOriginSchema.parse(originInput);
	const candidate = CandidateRecordSchema.parse(candidateInput);
	const decision = ApprovalDecisionSchema.parse(decisionInput);
	assertMatchingOrigin(origin, candidate);
	if (origin.mode !== "real")
		throw new Error(
			"Fixture-origin candidates cannot pass approval validation",
		);
	if (candidate.state !== "READY_FOR_HUMAN_REVIEW")
		throw new Error("Candidate is not ready for human review");
	if (candidate.candidateId !== decision.candidateId)
		throw new Error("Approval candidate ID does not match current candidate");
	if (candidate.diffHash !== decision.diffHash)
		throw new Error("Approval diff hash is stale or mismatched");
	return decision;
}

// Milestone 6 clean-verification contracts. The verifier independently re-applies
// the persisted candidate diff in a fresh disposable workspace, runs verifier-owned
// tests and the original Indonesia Mobile journey under the frozen profile, and
// persists a before/after report. Only a fully verified real candidate may become
// READY_FOR_HUMAN_REVIEW; fixture approval remains impossible (see isAllowedTransition).
export const VERIFICATION_REPORT_VERSION = "verification-report-v1" as const;
export const VERIFICATION_EXPORT_VERSION = "verification-export-v1" as const;
/** Frozen M6 verification budgets: encoded transfer bytes and journey duration. */
export const VERIFICATION_BUDGET = Object.freeze({
	encodedBytes: 2_000_000 as const,
	durationMs: 8_000 as const,
});
export const VerificationVerdictSchema = z.enum([
	"PASS",
	"FAIL",
	"INCONCLUSIVE",
]);

export const VerificationReportSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		recordVersion: z.literal(VERIFICATION_REPORT_VERSION),
		candidateId: EntityIdSchema,
		baselineRunId: EntityIdSchema,
		combinedDiffHash: Sha256Schema,
		sourceSnapshotHash: Sha256Schema,
		/** Hash of the fresh verifier workspace file tree after re-applying the combined diff. */
		verifierWorkspaceHash: Sha256Schema,
		/** Independent verifier-owned test result: regression + invariants pass (exit 0) in the fresh Docker workspace. */
		unitVerdict: z.literal("PASS"),
		/** The original Indonesia Mobile journey verdict under the frozen profile. */
		journeyVerdict: VerificationVerdictSchema,
		/** Verification evidence run id (null when the journey did not complete). */
		verificationRunId: EntityIdSchema.nullable(),
		transferredBytes: z.number().int().nonnegative(),
		durationMs: z.number().finite().nonnegative(),
		orderId: z.string().min(1).nullable(),
		durableOrderCount: z.number().int().nonnegative(),
		budgetEncodedBytes: z.literal(VERIFICATION_BUDGET.encodedBytes),
		budgetDurationMs: z.literal(VERIFICATION_BUDGET.durationMs),
		budgetPassed: z.boolean(),
		/** Baseline evidence anchor (the before state). */
		beforeEvidenceRef: ArtifactReferenceSchema,
		/** Verification evidence anchor (the after state; null when the journey was inconclusive). */
		afterEvidenceRef: ArtifactReferenceSchema.nullable(),
		createdAt: TimestampSchema,
		reportHash: Sha256Schema,
	})
	.strict()
	.superRefine((report, context) => {
		if (
			report.journeyVerdict === "PASS" &&
			(report.verificationRunId === null ||
				report.orderId === null ||
				report.durableOrderCount !== 1 ||
				!report.budgetPassed ||
				report.afterEvidenceRef === null)
		) {
			context.addIssue({
				code: "custom",
				message:
					"A passing journey requires exactly one durable order, passed budgets, and after-evidence",
			});
		}
		if (report.journeyVerdict !== "PASS" && report.budgetPassed) {
			context.addIssue({
				code: "custom",
				path: ["budgetPassed"],
				message: "budgetPassed requires a passing journey verdict",
			});
		}
		const withoutHash = { ...report } as Record<string, unknown>;
		delete withoutHash.reportHash;
		if (
			createHash("sha256")
				.update(canonicalContractJson(withoutHash), "utf8")
				.digest("hex") !== report.reportHash
		) {
			context.addIssue({
				code: "custom",
				path: ["reportHash"],
				message: "Verification report hash is invalid",
			});
		}
	});

/** Hash a verification report input (without reportHash) using the canonical contract form. */
export function hashVerificationReport(
	reportInput: Omit<z.input<typeof VerificationReportSchema>, "reportHash">,
): string {
	return createHash("sha256")
		.update(canonicalContractJson(reportInput), "utf8")
		.digest("hex");
}

export const VerificationExportSchema = z
	.object({
		schemaVersion: SchemaVersionSchema,
		recordVersion: z.literal(VERIFICATION_EXPORT_VERSION),
		candidateId: EntityIdSchema,
		combinedDiffHash: Sha256Schema,
		testDiffArtifact: CandidateDiffArtifactSchema,
		sourceDiffArtifact: CandidateDiffArtifactSchema,
		combinedDiffArtifact: CandidateDiffArtifactSchema,
		/** Human-readable rollback instruction: revert the three seed files to their baseline. */
		rollbackNote: z.string().min(1),
		exportedAt: TimestampSchema,
	})
	.strict();

export type TargetId = z.infer<typeof TargetIdSchema>;
export type JourneyId = z.infer<typeof JourneyIdSchema>;
export type ProfileId = z.infer<typeof ProfileIdSchema>;
export type SeedId = z.infer<typeof SeedIdSchema>;
export type RunVerdict = z.infer<typeof RunVerdictSchema>;
export type RunOrigin = z.infer<typeof RunOriginSchema>;
export type StateTransition = z.infer<typeof StateTransitionSchema>;
export type JobRequest = z.infer<typeof JobRequestSchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
export type ControlJobCreate = z.infer<typeof ControlJobCreateSchema>;
export type ControlJobRecord = z.infer<typeof ControlJobRecordSchema>;
export type ControlIdempotencyRecord = z.infer<
	typeof ControlIdempotencyRecordSchema
>;
export type LatestJobPointer = z.infer<typeof LatestJobPointerSchema>;
export type FixtureDashboardSnapshot = z.infer<
	typeof FixtureDashboardSnapshotSchema
>;
export type ControlJobView = z.infer<typeof ControlJobViewSchema>;
export type AnalysisHypothesis = z.infer<typeof AnalysisHypothesisSchema>;
export type AnalysisModelOutput = z.infer<typeof AnalysisModelOutputSchema>;
export type CodexUsage = z.infer<typeof CodexUsageSchema>;
export type AnalysisInputArtifact = z.infer<typeof AnalysisInputArtifactSchema>;
export type AnalysisReport = z.infer<typeof AnalysisReportSchema>;
export type AnalysisAttemptRecord = z.infer<typeof AnalysisAttemptRecordSchema>;
export type ModelAdapterErrorCode = z.infer<typeof ModelAdapterErrorCodeSchema>;
export type AnalysisStage = z.infer<typeof AnalysisStageSchema>;
export type FixtureAnalysis = z.infer<typeof FixtureAnalysisSchema>;
export type CandidateRecord = z.infer<typeof CandidateRecordSchema>;
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
export type TestAuthoringDiff = z.infer<typeof TestAuthoringDiffSchema>;
export type SourceAuthoringDiff = z.infer<typeof SourceAuthoringDiffSchema>;
export type CanonicalDiffMetadata = z.infer<typeof CanonicalDiffMetadataSchema>;
export type AuthoringAttemptRecord = z.infer<
	typeof AuthoringAttemptRecordSchema
>;
export type SourceSnapshot = z.infer<typeof SourceSnapshotSchema>;
export type TestFailureProof = z.infer<typeof TestFailureProofSchema>;
export type CandidateDiffArtifact = z.infer<typeof CandidateDiffArtifactSchema>;
export type CandidatePolicyEvidence = z.infer<
	typeof CandidatePolicyEvidenceSchema
>;
export type SandboxControl = z.infer<typeof SandboxControlSchema>;
export type SandboxResult = z.infer<typeof SandboxResultSchema>;
export type SandboxClassification = z.infer<typeof SandboxClassificationSchema>;
export type SandboxStage = z.infer<typeof SandboxStageSchema>;
export type SandboxCommandEvidence = z.infer<
	typeof SandboxCommandEvidenceSchema
>;
export type SandboxCommandId = z.infer<typeof M5_SANDBOX_COMMAND_ID_SCHEMA>;
export type M5CandidateEnvelope = z.infer<typeof M5CandidateEnvelopeSchema>;
export type RepairStatusRecord = z.infer<typeof RepairStatusRecordSchema>;
export type AuthoringOperation = z.infer<typeof AuthoringOperationSchema>;
export type AuthoringErrorCode = z.infer<typeof AuthoringErrorCodeSchema>;
export type EvidenceRunKind = z.infer<typeof EvidenceRunKindSchema>;
export type JourneyVerdict = z.infer<typeof JourneyVerdictSchema>;
export type JourneyAssertionStatus = z.infer<
	typeof JourneyAssertionStatusSchema
>;
export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;
export type EvidenceResult = z.infer<typeof EvidenceResultSchema>;
export type JourneyAssertions = z.infer<typeof JourneyAssertionsSchema>;
export type EvidenceMetrics = z.infer<typeof EvidenceMetricsSchema>;
export type ArtifactIndex = z.infer<typeof ArtifactIndexSchema>;
export type EvidenceAnchor = z.infer<typeof EvidenceAnchorSchema>;
export type VerificationVerdict = z.infer<typeof VerificationVerdictSchema>;
export type VerificationReport = z.infer<typeof VerificationReportSchema>;
export type VerificationExport = z.infer<typeof VerificationExportSchema>;
