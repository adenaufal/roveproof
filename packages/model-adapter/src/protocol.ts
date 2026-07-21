import { CodexUsageSchema, type CodexUsage, type ModelAdapterErrorCode } from "@roveproof/contracts";
import { ModelAdapterError } from "./errors.js";

export type CodexProtocolSuccess = Readonly<{
  threadId: string;
  terminalStatus: "turn.completed";
  usage: CodexUsage;
  finalMessage: string;
}>;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function containsModelRefusal(value: unknown): boolean {
  const text = JSON.stringify(value).toLowerCase();
  return /\b(?:i|we)\s+(?:cannot|can't|won't|will not|am unable to|are unable to)\s+(?:assist|help|comply|analy[sz]e|provide|complete)\b/.test(text) ||
    /\b(?:i|we)\s+refuse\b/.test(text) ||
    /\bunable to assist\b/.test(text);
}

export function classifyCodexFailure(...inputs: readonly string[]): ModelAdapterErrorCode {
  const message = inputs.join("\n").toLowerCase();
  if (/quota|usage limit|rate limit|too many requests|credits? exhausted/.test(message)) return "MODEL_QUOTA_EXHAUSTED";
  if (/unauthori[sz]ed|authentication|not logged in|log in|sign in|access token/.test(message)) return "MODEL_AUTH_LOST";
  if (/model[^\n]*(?:unavailable|not found|unsupported)|no available model/.test(message)) return "MODEL_UNAVAILABLE";
  if (/\brefus(?:al|ed|es|ing)\b|cannot assist/.test(message)) return "MODEL_REFUSAL";
  if (/temporar(?:y|ily)|connection reset|transport|service unavailable|econnreset|eagain/.test(message)) return "MODEL_CLI_TRANSIENT";
  return "MODEL_TURN_FAILED";
}

function usageFromEvent(value: unknown): CodexUsage {
  const usage = objectRecord(value);
  if (!usage) throw new ModelAdapterError("MODEL_PROTOCOL_INVALID", "protocol");
  return CodexUsageSchema.parse({
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
  });
}

function safeUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function parseCodexJsonl(input: string): CodexProtocolSuccess {
  const lines = input.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0 || lines.length > 4_096) throw new ModelAdapterError("MODEL_PROTOCOL_INVALID", "protocol");

  let threadId: string | null = null;
  let turnStarted = false;
  let terminal = false;
  let usage: CodexUsage | null = null;
  let finalMessage: string | null = null;

  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > 1024 * 1024 || terminal) {
      throw new ModelAdapterError("MODEL_PROTOCOL_INVALID", "protocol", { provenance: { threadId } });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new ModelAdapterError("MODEL_PROTOCOL_INVALID", "protocol", { provenance: { threadId } });
    }
    const event = objectRecord(parsed);
    if (!event || typeof event.type !== "string") {
      throw new ModelAdapterError("MODEL_PROTOCOL_INVALID", "protocol", { provenance: { threadId } });
    }

    if (event.type === "thread.started") {
      if (threadId !== null || turnStarted || !safeUuid(event.thread_id)) {
        throw new ModelAdapterError("MODEL_PROTOCOL_INVALID", "protocol");
      }
      threadId = event.thread_id;
      continue;
    }
    if (event.type === "turn.started") {
      if (!threadId || turnStarted) throw new ModelAdapterError("MODEL_PROTOCOL_INVALID", "protocol", { provenance: { threadId } });
      turnStarted = true;
      continue;
    }
    if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
      if (!threadId || !turnStarted) throw new ModelAdapterError("MODEL_PROTOCOL_INVALID", "protocol", { provenance: { threadId } });
      const item = objectRecord(event.item);
      if (!item || (item.type !== "reasoning" && item.type !== "agent_message")) {
        throw new ModelAdapterError("MODEL_PROTOCOL_UNSUPPORTED", "protocol", { provenance: { threadId } });
      }
      if (event.type === "item.completed" && item.type === "agent_message") {
        if (finalMessage !== null || typeof item.text !== "string" || Buffer.byteLength(item.text, "utf8") > 64 * 1024) {
          throw new ModelAdapterError("MODEL_PROTOCOL_INVALID", "protocol", { provenance: { threadId } });
        }
        finalMessage = item.text;
      }
      continue;
    }
    if (event.type === "turn.completed") {
      if (!threadId || !turnStarted || finalMessage === null) {
        throw new ModelAdapterError("MODEL_PROTOCOL_INVALID", "protocol", { provenance: { threadId } });
      }
      try {
        usage = usageFromEvent(event.usage);
      } catch (error) {
        if (error instanceof ModelAdapterError) throw error;
        throw new ModelAdapterError("MODEL_PROTOCOL_INVALID", "protocol", { provenance: { threadId } });
      }
      terminal = true;
      continue;
    }
    if (event.type === "turn.failed" || event.type === "error") {
      const code = classifyCodexFailure(JSON.stringify(event));
      throw new ModelAdapterError(code, "protocol", {
        retryable: code === "MODEL_CLI_TRANSIENT",
        provenance: { threadId, terminalStatus: event.type === "turn.failed" ? "turn.failed" : null },
      });
    }
    throw new ModelAdapterError("MODEL_PROTOCOL_UNSUPPORTED", "protocol", { provenance: { threadId } });
  }

  if (!threadId || !turnStarted || !terminal || !usage || finalMessage === null) {
    throw new ModelAdapterError("MODEL_PROTOCOL_INVALID", "protocol", { provenance: { threadId } });
  }
  return { threadId, terminalStatus: "turn.completed", usage, finalMessage };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
