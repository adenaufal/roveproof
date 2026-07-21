"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { VERIFICATION_BUDGET } from "@roveproof/contracts";
import type {
  ControlJobView,
  FixtureDashboardSnapshot,
  RunEvent,
  RunState,
} from "@roveproof/contracts";
import type { ReviewCandidate } from "../lib/control-server";

const TERMINAL_STATES = new Set<RunState>(["APPROVED", "REJECTED", "INCONCLUSIVE"]);

const PHASES: ReadonlyArray<Readonly<{ state: RunState; label: string; code: string }>> = [
  { state: "REQUESTED", label: "Request sealed", code: "RQ" },
  { state: "BASELINE_RUNNING", label: "Baseline capture", code: "BL" },
  { state: "BASELINE_FAILED_EXPECTED", label: "Expected failure", code: "FL" },
  { state: "ANALYZING", label: "Evidence analysis", code: "AN" },
  { state: "TEST_AUTHORING", label: "Regression test", code: "TS" },
  { state: "TEST_FAILED_AS_EXPECTED", label: "Red test replay", code: "RD" },
  { state: "PATCH_AUTHORING", label: "Candidate fixture", code: "PT" },
  { state: "SANDBOX_GATING", label: "Sandbox gates", code: "SG" },
  { state: "VERIFYING_CLEAN", label: "Clean verification", code: "VR" },
  { state: "INCONCLUSIVE", label: "Rehearsal complete", code: "FC" },
];

const STATE_LABELS: Partial<Record<RunState, string>> = {
  REQUESTED: "Queued",
  BASELINE_RUNNING: "Capturing baseline",
  BASELINE_FAILED_EXPECTED: "Failures reproduced",
  ANALYZING: "Reading evidence",
  TEST_AUTHORING: "Authoring test fixture",
  TEST_FAILED_AS_EXPECTED: "Red test confirmed",
  PATCH_AUTHORING: "Loading candidate fixture",
  SANDBOX_GATING: "Checking gates",
  VERIFYING_CLEAN: "Loading verification",
  INCONCLUSIVE: "Rehearsal complete",
};

type ConnectionState = "idle" | "connecting" | "live" | "reconnecting" | "complete";

function RouteMark({ small = false }: { small?: boolean }) {
  return (
    <svg className={small ? "routeMark routeMarkSmall" : "routeMark"} viewBox="0 0 36 36" aria-hidden="true">
      <path d="M8 28V9h11.5c5.2 0 8.5 2.7 8.5 7 0 3.1-1.8 5.4-4.8 6.4L29 28h-6.3l-5.1-5H14v5H8Zm6-10h5.1c1.9 0 3-1 3-2.6 0-1.5-1.1-2.4-3-2.4H14v5Z" />
      <circle cx="8" cy="7" r="2.2" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 32 16" aria-hidden="true">
      <path d="M1 8h27M22 2l6 6-6 6" />
    </svg>
  );
}

function formatJakartaTime(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

function formatDurationMs(ms: number): string {
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

// Percent change from before→after as a signed, human string ("−83%" / "+12%").
function signedPercent(before: number, after: number): string {
  if (before <= 0) return "—";
  const change = Math.round(((after - before) / before) * 100);
  return change <= 0 ? `−${Math.abs(change)}%` : `+${change}%`;
}

// Collapse a long id/hash to head…tail; the full value stays in the title/copy.
function shortHash(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

const DIFF_LINE_CAP = 400;

function diffLineClass(line: string): string {
  if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---")) return "diffMeta";
  if (line.startsWith("@@")) return "diffHunk";
  if (line.startsWith("+")) return "diffAdd";
  if (line.startsWith("-")) return "diffDel";
  return "diffCtx";
}

function CopyableValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="copyable">
      <code title={value}>{shortHash(value)}</code>
      <button
        type="button"
        className="copyButton"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1_200);
            },
            () => undefined,
          );
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: string } };
    return payload.error?.message ?? `Control request failed (${response.status})`;
  } catch {
    return `Control request failed (${response.status})`;
  }
}

export default function DashboardClient({
  initialView,
  preview,
  initialLoadError,
  reviewCandidate,
}: {
  initialView: ControlJobView | null;
  preview: FixtureDashboardSnapshot;
  initialLoadError: string | null;
  reviewCandidate: ReviewCandidate | null;
}) {
  const [view, setView] = useState<ControlJobView | null>(initialView);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(initialLoadError);
  const [deciding, setDeciding] = useState<null | "approve" | "reject">(null);
  const [confirming, setConfirming] = useState<null | "approve" | "reject">(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionOutcome, setDecisionOutcome] = useState<{ decision: string; state: string } | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(
    initialView && TERMINAL_STATES.has(initialView.job.state) ? "complete" : "idle",
  );
  const [streamNotice, setStreamNotice] = useState<string | null>(null);

  const snapshot = view?.snapshot ?? preview;
  const jobId = view?.job.jobId ?? null;
  const terminal = view ? TERMINAL_STATES.has(view.job.state) : false;
  const running = Boolean(view && !terminal);
  const lastEvent = view?.events.at(-1);
  const eventsByState = useMemo(
    () => new Map((view?.events ?? []).map((event) => [event.state, event])),
    [view?.events],
  );
  const baselineReproduced = eventsByState.has("BASELINE_FAILED_EXPECTED");
  const storeBlocked = initialLoadError !== null;

  // Per-phase elapsed time = gap between an event and the next persisted event.
  const durationByState = useMemo(() => {
    const events = view?.events ?? [];
    const map = new Map<RunState, string>();
    for (let i = 0; i < events.length - 1; i += 1) {
      const ms = new Date(events[i + 1].occurredAt).getTime() - new Date(events[i].occurredAt).getTime();
      if (Number.isFinite(ms) && ms >= 0) map.set(events[i].state, formatDurationMs(ms));
    }
    return map;
  }, [view?.events]);

  const diffLines = useMemo(() => (reviewCandidate?.combinedDiff ?? "").split("\n"), [reviewCandidate?.combinedDiff]);
  const diffStat = useMemo(() => {
    let added = 0;
    let removed = 0;
    let files = 0;
    for (const line of diffLines) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("diff --git")) files += 1;
      else if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
    return { added, removed, files };
  }, [diffLines]);

  const refreshView = useCallback(async (id: string): Promise<void> => {
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      const response = await fetch(`/api/jobs/${id}`, { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      const nextView = await response.json() as ControlJobView;
      setView(nextView);
      if (nextView.job.state !== "INCONCLUSIVE" || nextView.snapshot.completion.status !== "PENDING") return;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }, []);

  useEffect(() => {
    if (!jobId || terminal) return;
    const source = new EventSource(`/api/jobs/${jobId}/events?after=0`);
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

    const onRunEvent = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as RunEvent;
      if (event.jobId !== jobId || !Number.isInteger(event.sequence)) return;
      setConnection("live");
      setStreamNotice(null);
      setView((current) => {
        if (!current || current.job.jobId !== event.jobId) return current;
        const events = current.events.some(({ sequence }) => sequence === event.sequence)
          ? current.events
          : [...current.events, event].sort((left, right) => left.sequence - right.sequence);
        return {
          ...current,
          job: {
            ...current.job,
            state: event.state,
            lastSequence: event.sequence,
            updatedAt: event.occurredAt,
          },
          events,
        };
      });
      if (TERMINAL_STATES.has(event.state)) {
        source.close();
        setConnection("complete");
        void refreshView(jobId).catch(() => setError("The final persisted fixture snapshot could not be read."));
      }
    };

    source.addEventListener("run-event", onRunEvent as EventListener);
    source.onopen = () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      setConnection("live");
      setStreamNotice(null);
    };
    source.onerror = () => {
      setConnection("reconnecting");
      setStreamNotice("Live updates were interrupted. Reading the persisted ledger while the stream reconnects.");
      if (fallbackTimer) clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(() => {
        void refreshView(jobId).catch(() => setStreamNotice("Persisted status is temporarily unavailable. Retry the safe refresh below."));
      }, 1_000);
    };
    return () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      source.close();
    };
  }, [jobId, terminal, refreshView]);

  async function startFixture(): Promise<void> {
    setStarting(true);
    setError(null);
    setStreamNotice(null);
    setConnection("connecting");
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `fixture:${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ schemaVersion: 1, mode: "fixture" }),
      });
      if (!response.ok) throw new Error(await readError(response));
      setView(await response.json() as ControlJobView);
    } catch (requestError) {
      setConnection("idle");
      setError(requestError instanceof Error ? requestError.message : "The fixture rehearsal could not start.");
    } finally {
      setStarting(false);
    }
  }

  async function refreshPersistedStatus(): Promise<void> {
    if (!jobId) return;
    setStreamNotice("Reading persisted status…");
    try {
      await refreshView(jobId);
      setStreamNotice(null);
    } catch {
      setStreamNotice("Persisted status is temporarily unavailable. You can retry without starting another job.");
    }
  }

  async function submitDecision(decision: "approve" | "reject"): Promise<void> {
    if (!reviewCandidate || deciding) return;
    setDeciding(decision);
    setDecisionError(null);
    try {
      // Post the CURRENT server-rendered hash. The route re-checks it against the
      // store's authoritative value and rejects a stale hash with 409.
      const response = await fetch(`/api/candidates/${reviewCandidate.candidateId}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, combinedDiffHash: reviewCandidate.combinedDiffHash }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const result = await response.json() as { decision: string; state: string };
      setDecisionOutcome({ decision: result.decision, state: result.state });
    } catch (requestError) {
      setDecisionError(requestError instanceof Error ? requestError.message : "The decision could not be recorded.");
    } finally {
      setDeciding(null);
      setConfirming(null);
    }
  }

  const currentLabel = view ? STATE_LABELS[view.job.state] ?? view.job.state : "Ready for fixture replay";
  const connectionLabel = connection === "live" ? "Live event stream" : connection === "reconnecting" ? "Reconnecting" : connection === "complete" ? "Persisted" : "Local control";

  return (
    <div className="controlCanvas">
      <header className="appHeader">
        <a className="brand" href="#top" aria-label="Roveproof proof ledger home">
          <span className="brandMark"><RouteMark /></span>
          <span><strong>Roveproof</strong><small>Journey proof ledger</small></span>
        </a>
        <div className="headerContext" aria-label="Environment" role="status" aria-live="polite">
          <span className="liveDot" data-live={connection === "live"} aria-hidden="true" />
          <span>{connectionLabel}</span>
          <span className="headerDivider" />
          <span>Checkout v1</span>
        </div>
      </header>

      <main id="top" className="proofWorkspace">
        {reviewCandidate ? (
          <section className="reviewPanel" aria-labelledby="review-title">
            <div className="reviewPanelHead">
              <div>
                <p className="kicker">Real candidate · hash-bound human review</p>
                <h2 id="review-title">Approve or reject the verified fix</h2>
              </div>
              <span className="readyBadge">READY_FOR_HUMAN_REVIEW</span>
            </div>

            {reviewCandidate.verification ? (
              <div className="reviewVerdict">
                <div className="verdictCell">
                  <span className="verdictKey">Journey</span>
                  <strong>{reviewCandidate.verification.journeyVerdict}</strong>
                </div>
                <div className="verdictCell">
                  <span className="verdictKey">Transferred</span>
                  <strong>{formatBytes(reviewCandidate.verification.transferredBytes)}</strong>
                  <span className="budgetLine" data-pass={reviewCandidate.verification.transferredBytes <= reviewCandidate.verification.budgetEncodedBytes}>
                    ≤ {formatBytes(reviewCandidate.verification.budgetEncodedBytes)} {reviewCandidate.verification.transferredBytes <= reviewCandidate.verification.budgetEncodedBytes ? "✓" : "✗"}
                  </span>
                </div>
                <div className="verdictCell">
                  <span className="verdictKey">Duration</span>
                  <strong>{formatDurationMs(reviewCandidate.verification.durationMs)}</strong>
                  <span className="budgetLine" data-pass={reviewCandidate.verification.durationMs <= reviewCandidate.verification.budgetDurationMs}>
                    ≤ {formatDurationMs(reviewCandidate.verification.budgetDurationMs)} {reviewCandidate.verification.durationMs <= reviewCandidate.verification.budgetDurationMs ? "✓" : "✗"}
                  </span>
                </div>
                <div className="verdictCell">
                  <span className="verdictKey">Budgets</span>
                  <strong data-pass={reviewCandidate.verification.budgetPassed}>{reviewCandidate.verification.budgetPassed ? "PASS" : "FAIL"}</strong>
                  <span className="budgetLine">order {reviewCandidate.verification.orderId ?? "—"}</span>
                </div>
              </div>
            ) : (
              <p className="reviewNote">Verification report unavailable — do not approve until it can be read.</p>
            )}

            {reviewCandidate.combinedDiff ? (
              <details className="diffPanel">
                <summary>
                  <span>Combined diff</span>
                  <span className="diffStat">{diffStat.files} file{diffStat.files === 1 ? "" : "s"} · <ins>+{diffStat.added}</ins> <del>−{diffStat.removed}</del></span>
                </summary>
                <pre className="diffBody" aria-label="Combined unified diff">
                  {diffLines.slice(0, DIFF_LINE_CAP).map((line, index) => (
                    <span key={index} className={diffLineClass(line)}>{line || " "}</span>
                  ))}
                </pre>
                {diffLines.length > DIFF_LINE_CAP ? (
                  <p className="diffTruncated">Showing first {DIFF_LINE_CAP} of {diffLines.length} lines. The decision is bound to the full diff hash below.</p>
                ) : null}
              </details>
            ) : (
              <p className="reviewNote">Combined diff text could not be read or failed its hash check. Inspect the candidate out of band before deciding.</p>
            )}

            <dl className="reviewFacts">
              <div><dt>Candidate</dt><dd><CopyableValue value={reviewCandidate.candidateId} label="candidate id" /></dd></div>
              <div><dt>Combined diff hash</dt><dd><CopyableValue value={reviewCandidate.combinedDiffHash} label="combined diff hash" /></dd></div>
            </dl>

            {decisionOutcome ? (
              <p className="reviewOutcome" role="status" aria-live="polite" data-decision={decisionOutcome.decision}>
                Decision recorded: <strong>{decisionOutcome.decision.toUpperCase()}</strong> · candidate state <code>{decisionOutcome.state}</code>
              </p>
            ) : confirming ? (
              <div className="reviewConfirm" role="group" aria-label={`Confirm ${confirming}`}>
                <p>
                  Confirm <strong>{confirming === "approve" ? "approve" : "reject"}</strong>, bound to hash <code title={reviewCandidate.combinedDiffHash}>{shortHash(reviewCandidate.combinedDiffHash)}</code>. This is final and cannot be undone.
                </p>
                <div className="reviewActions">
                  <button
                    type="button"
                    className={`decisionButton ${confirming === "approve" ? "decisionPrimary" : "decisionDanger"}`}
                    onClick={() => void submitDecision(confirming)}
                    disabled={deciding !== null}
                  >
                    {deciding ? "Recording…" : confirming === "approve" ? "Confirm approve" : "Confirm reject"}
                  </button>
                  <button type="button" className="decisionGhost" onClick={() => setConfirming(null)} disabled={deciding !== null}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="reviewActions">
                <button type="button" className="decisionButton decisionPrimary" onClick={() => setConfirming("approve")}>
                  Approve fix
                </button>
                <button type="button" className="decisionButton decisionSecondary" onClick={() => setConfirming("reject")}>
                  Reject
                </button>
              </div>
            )}

            {decisionError ? <p className="errorNotice" role="alert">{decisionError}</p> : null}
            <p className="profileNote">
              Approval exports the verified diff and rollback handle only — it never merges, deploys, or executes anything. The current hash is posted from the server-rendered record; a stale hash is rejected.
            </p>
          </section>
        ) : null}

        <section className="fixtureBanner" aria-label="Fixture safety notice">
          <span className="fixtureBannerIcon"><LockIcon /></span>
          <div>
            <strong>Fixture rehearsal · not approvable</strong>
            <span>Golden evidence is for control-plane demonstration only. It cannot become a trusted run.</span>
          </div>
          <span className="fixtureStamp">FIXTURE / GOLDEN-CONTROL-V1</span>
        </section>

        <section className="hero" aria-labelledby="page-title">
          <div className="heroCopy">
            <p className="kicker">Proof run / Indonesia mobile</p>
            <h1 id="page-title">One checkout.<br />Every claim tied to proof.</h1>
            <p className="heroSummary">
              Replay the fixed Roveproof journey, watch each phase land in the file-backed ledger, and inspect the evidence behind three deterministic failures.
            </p>
          </div>
          <div className="runConsole">
            <div className="runConsoleTop" role="status" aria-live="polite">
              <span className="statusPulse" data-running={running} aria-hidden="true" />
              <div>
                <span className="runConsoleLabel">Control status</span>
                <strong>{currentLabel}</strong>
              </div>
            </div>
            <button className="runButton" type="button" onClick={() => void startFixture()} disabled={starting || running || storeBlocked}>
              <span>{starting ? "Starting…" : running ? "Rehearsal running" : terminal ? "Run fixture again" : "Run fixture rehearsal"}</span>
              <ArrowIcon />
            </button>
            {connection === "reconnecting" && jobId ? (
              <button className="refreshStatusButton" type="button" onClick={() => void refreshPersistedStatus()}>
                Refresh persisted status
              </button>
            ) : null}
            <div className="runMeta">
              <span>{view ? view.job.jobId.slice(-12) : "No job created"}</span>
              <span>Single worker</span>
            </div>
            {streamNotice ? <p className="streamNotice" role="status" aria-live="polite">{streamNotice}</p> : null}
          </div>
        </section>

        {error ? <div className="errorNotice" role="alert"><strong>Control plane unavailable.</strong> {error}</div> : null}

        <section className="comparison" aria-labelledby="comparison-title">
          <div className="sectionHeading comparisonHeading">
            <div>
              <p className="kicker">Before / expected after</p>
              <h2 id="comparison-title">The bounded proof target</h2>
            </div>
            <p>Single-observation fixture values. No aggregate, no confidence claim.</p>
          </div>
          <div className="proofRoute">
            <article className="measureSlot measureBefore">
              <div className="measureTopline">
                <span>01 · {baselineReproduced ? "Fixture baseline" : "Fixture baseline reference"}</span>
                <span className={`verdict ${baselineReproduced ? "verdictFail" : "verdictReference"}`}>{baselineReproduced ? "Blocked" : "Reference"}</span>
              </div>
              <h3>{snapshot.baseline.outcomeLabel}</h3>
              <div className="measureValues">
                <div><strong>{snapshot.baseline.displayMegabytes}</strong><span>Transferred</span></div>
                <div><strong>{snapshot.baseline.displayDuration}</strong><span>Journey</span></div>
              </div>
              <p>{baselineReproduced ? "Reproduced golden fixture" : "Reference fixture · not a live measurement"} · n={snapshot.baseline.sampleCount} · {snapshot.baseline.verdict}</p>
            </article>
            <div className="routeBridge" aria-hidden="true">
              <span className="routeBridgeLine" />
              <span className="routeBridgeMark"><RouteMark small /></span>
              <span className="routeBridgeArrow"><ArrowIcon /></span>
            </div>
            <article className="measureSlot measureAfter">
              <div className="measureTopline"><span>02 · Expected fixture after</span><span className="verdict verdictPass">Pass</span></div>
              <h3>{snapshot.verification.outcomeLabel}</h3>
              <div className="measureValues">
                <div><strong>{snapshot.verification.displayMegabytes}</strong><span>Transferred</span></div>
                <div><strong>{snapshot.verification.displayDuration}</strong><span>Journey</span></div>
              </div>
              <div className="afterMeta">
                <span className="deltaChip">{signedPercent(snapshot.baseline.transferredBytes, snapshot.verification.transferredBytes)} transfer</span>
                <span className="deltaChip">{signedPercent(snapshot.baseline.durationMs, snapshot.verification.durationMs)} time</span>
                <span className="budgetTag">criterion ≤ {formatBytes(VERIFICATION_BUDGET.encodedBytes)} · ≤ {formatDurationMs(VERIFICATION_BUDGET.durationMs)}</span>
              </div>
              <p>Expected golden output · n={snapshot.verification.sampleCount} · not a live measurement</p>
            </article>
          </div>
        </section>

        <div className="ledgerGrid">
          <section className="timelinePanel" aria-labelledby="timeline-title">
            <div className="panelHeading">
              <div><p className="kicker">Persisted event log</p><h2 id="timeline-title">Journey spine</h2></div>
              <span className="eventCounter">{String(view?.events.length ?? 0).padStart(2, "0")} / {PHASES.length}</span>
            </div>
            <ol className="journeySpine">
              {PHASES.map((phase) => {
                const event = eventsByState.get(phase.state);
                const isCurrent = Boolean(event && lastEvent?.sequence === event.sequence && !terminal);
                const phaseStatus = event ? (isCurrent ? "current" : "complete") : "pending";
                return (
                  <li key={phase.state} className="journeyStep" data-status={phaseStatus} aria-current={isCurrent ? "step" : undefined}>
                    <span className="phaseNode" aria-hidden="true"><span>{event ? "✓" : phase.code}</span></span>
                    <div className="phaseCopy">
                      <div>
                        <strong>{phase.label}</strong>
                        {event ? (
                          <span className="phaseMeta">
                            <time dateTime={event.occurredAt}>{formatJakartaTime(event.occurredAt)} WIB</time>
                            {durationByState.get(phase.state) ? <span className="phaseDuration">{durationByState.get(phase.state)}</span> : null}
                          </span>
                        ) : (
                          <span>Awaiting event</span>
                        )}
                      </div>
                      <p>{event?.message ?? "This phase will be written by the sole fixture worker."}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
            {terminal ? (
              <div className="stateTruth">
                <strong>Presentation: REHEARSAL_COMPLETE</strong>
                <span>State-machine truth: INCONCLUSIVE · fixture provenance cannot enter human review.</span>
              </div>
            ) : null}
          </section>

          <aside className="profilePanel" aria-labelledby="profile-title">
            <div className="profileTop">
              <div>
                <p className="kicker">Constraint passport</p>
                <h2 id="profile-title">{snapshot.profile.label}</h2>
              </div>
              <span className="profileSeal">ID<br /><small>01</small></span>
            </div>
            <div className="deviceOutline" aria-hidden="true">
              <div className="deviceNotch" />
              <div className="deviceMap">
                <span>360</span><i /><strong>Checkout</strong><i /><span>800</span>
              </div>
            </div>
            <dl className="profileFacts">
              <div><dt>Viewport</dt><dd>{snapshot.profile.viewport.width} × {snapshot.profile.viewport.height} @ {snapshot.profile.deviceScaleFactor}×</dd></div>
              <div><dt>Locale</dt><dd>{snapshot.profile.locale}</dd></div>
              <div><dt>Time zone</dt><dd>{snapshot.profile.timeZone}</dd></div>
              <div><dt>CPU</dt><dd>{snapshot.profile.cpuSlowdown}× slowdown</dd></div>
              <div><dt>Network</dt><dd>{snapshot.profile.networkLabel}</dd></div>
              <div><dt>Latency</dt><dd>{snapshot.profile.latencyMs} ms RTT</dd></div>
              <div><dt>Down / up</dt><dd>3.6 / 0.75 Mbit/s</dd></div>
            </dl>
            <p className="profileNote">Server-owned profile. Values are fixed and cannot be edited from this dashboard.</p>
          </aside>
        </div>

        <section className="failuresSection" aria-labelledby="failures-title">
          <div className="sectionHeading">
            <div><p className="kicker">{baselineReproduced ? "Baseline oracle" : "Baseline oracle reference"}</p><h2 id="failures-title">Three deterministic failures</h2></div>
            <span className="countBadge">{baselineReproduced ? "03 / 03 reproduced" : "03 fixture seeds"}</span>
          </div>
          <ol className="failureLedger">
            {snapshot.failures.map((failure, index) => (
              <li key={failure.seedId}>
                <div className="failureIndex">0{index + 1}</div>
                <div className="failureCopy">
                  <span className="seedId">{failure.seedId}</span>
                  <h3>{failure.title}</h3>
                  <p>{failure.summary}</p>
                </div>
                <div className="evidenceRefs" aria-label="Evidence references">
                  {failure.evidenceRefs.map((reference) => <code key={reference}>{reference}</code>)}
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="evidenceSection" aria-labelledby="evidence-title">
          <div className="sectionHeading">
            <div><p className="kicker">Golden bundle</p><h2 id="evidence-title">Evidence, not assertions alone</h2></div>
            <p>Paths are canonical fixture references. Live artifacts are never fabricated by the UI.</p>
          </div>
          <div className="evidenceGrid">
            <figure className="screenshotEvidence">
              <div className="screenshotFrame">
                <Image src="/fixtures/baseline-failure.png" alt="Synthetic checkout fixture showing the terminal validation failures" fill sizes="(max-width: 760px) 92vw, 46vw" priority />
                <span className="fixtureWatermark">FIXTURE</span>
              </div>
              <figcaption>
                <span>screenshots/failure-or-confirmation.png</span>
                <strong>Terminal oracle · synthetic checkout</strong>
              </figcaption>
            </figure>
            <div className="artifactLedger">
              <div className="artifactLedgerHead"><span>Artifact</span><span>Type</span></div>
              <ul>
                {snapshot.evidence.map((artifact) => (
                  <li key={artifact.id}>
                    <span className="artifactGlyph">{artifact.type.slice(0, 2).toUpperCase()}</span>
                    <span><strong>{artifact.label}</strong><code>{artifact.artifactPath}</code><small>{artifact.note}</small></span>
                    <em>{artifact.type}</em>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {!reviewCandidate ? (
          <section className="approvalLock" aria-labelledby="approval-title">
            <span className="approvalIcon"><LockIcon /></span>
            <div>
              <p className="kicker">Decision boundary</p>
              <h2 id="approval-title">Approval is outside this fixture.</h2>
              <p>{snapshot.approval.reason}. A fixture run terminates as <code>INCONCLUSIVE</code>, even when its rehearsal completes cleanly.</p>
            </div>
            <button type="button" disabled><LockIcon /> Approval unavailable</button>
          </section>
        ) : null}
      </main>

      <footer className="appFooter">
        <span><RouteMark small /> Roveproof / local-first control</span>
        <span>One journey · one profile · three seeds · one worker</span>
      </footer>
    </div>
  );
}
