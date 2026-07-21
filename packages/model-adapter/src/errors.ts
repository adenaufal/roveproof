import type { AnalysisStage, CodexUsage, ModelAdapterErrorCode } from "@roveproof/contracts";

export type SafeFailureProvenance = Readonly<{
  cliVersion?: string | null;
  threadId?: string | null;
  terminalStatus?: "turn.completed" | "turn.failed" | null;
  usage?: CodexUsage | null;
  exitStatus?: number | null;
  signal?: string | null;
}>;

export class ModelAdapterError extends Error {
  readonly code: ModelAdapterErrorCode;
  readonly stage: AnalysisStage;
  readonly retryable: boolean;
  readonly provenance: SafeFailureProvenance;

  constructor(
    code: ModelAdapterErrorCode,
    stage: AnalysisStage,
    options: Readonly<{ retryable?: boolean; provenance?: SafeFailureProvenance }> = {},
  ) {
    super(`${code} at ${stage}`);
    this.name = "ModelAdapterError";
    this.code = code;
    this.stage = stage;
    this.retryable = options.retryable ?? false;
    this.provenance = options.provenance ?? {};
  }
}

export function asModelAdapterError(error: unknown, fallbackCode: ModelAdapterErrorCode, stage: AnalysisStage): ModelAdapterError {
  return error instanceof ModelAdapterError ? error : new ModelAdapterError(fallbackCode, stage);
}
