import { performance } from "node:perf_hooks";
import type { CDPSession, ConsoleMessage, Page } from "playwright";
import { redactHeaders, redactText, redactUrl } from "@roveproof/evidence";

export type RequestEvidence = Readonly<{
  requestKey: string;
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  startedAtMs: number;
  requestHeaders: Record<string, string>;
  requestBody: Readonly<{ present: boolean; redacted: true }>;
  response: Readonly<{
    status: number;
    mimeType: string;
    headers: Record<string, string>;
    fromDiskCache: boolean;
    fromServiceWorker: boolean;
  }> | null;
  finishedAtMs: number | null;
  encodedBytes: number | null;
  failed: boolean;
  failureText: string | null;
  networkRuleId: string | null;
}>;

export type ConsoleEvidence = Readonly<{
  kind: "console" | "pageerror";
  atMs: number;
  level: string;
  text: string;
  location: Readonly<{ url: string; lineNumber: number; columnNumber: number }> | null;
}>;

type RequestEvent = {
  requestId: string;
  type?: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, unknown>;
    hasPostData?: boolean;
  };
  redirectResponse?: ResponseEvent["response"];
};
type ExtraInfoEvent = {
  requestId: string;
  headers: Record<string, unknown>;
  appliedNetworkConditionsId?: string;
};
type ResponseEvent = {
  requestId: string;
  response: {
    status: number;
    mimeType: string;
    headers: Record<string, unknown>;
    fromDiskCache?: boolean;
    fromServiceWorker?: boolean;
    encodedDataLength?: number;
  };
};
type FinishedEvent = { requestId: string; encodedDataLength: number };
type FailedEvent = { requestId: string; errorText: string; canceled?: boolean };
type CacheEvent = { requestId: string };

type MutableRequest = {
  requestKey: string;
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  startedAtMs: number;
  requestHeaders: Record<string, string>;
  requestBody: { present: boolean; redacted: true };
  response: RequestEvidence["response"];
  finishedAtMs: number | null;
  encodedBytes: number | null;
  failed: boolean;
  failureText: string | null;
  networkRuleId: string | null;
  terminal: boolean;
};

function headerValue(headers: Record<string, string>, name: string): string | null {
  const entry = Object.entries(headers).find(([headerName]) => headerName.toLowerCase() === name.toLowerCase());
  return entry?.[1] ?? null;
}

export class NetworkCollector {
  readonly #targetOrigin: string;
  readonly #records: MutableRequest[] = [];
  readonly #current = new Map<string, MutableRequest>();
  readonly #pendingExtra = new Map<string, ExtraInfoEvent>();
  readonly #allowedRuleIds = new Set<string>();
  readonly #idleWaiters = new Set<() => void>();
  #active = false;
  #boundaryStarted = 0;
  #redirectObserved = false;

  constructor(session: CDPSession, targetOrigin: string) {
    this.#targetOrigin = new URL(targetOrigin).origin;
    session.on("Network.requestWillBeSent", (event: RequestEvent) => this.#onRequest(event));
    session.on("Network.requestWillBeSentExtraInfo", (event: ExtraInfoEvent) => this.#onExtraInfo(event));
    session.on("Network.responseReceived", (event: ResponseEvent) => this.#onResponse(event));
    session.on("Network.loadingFinished", (event: FinishedEvent) => this.#onFinished(event));
    session.on("Network.loadingFailed", (event: FailedEvent) => this.#onFailed(event));
    session.on("Network.requestServedFromCache", (event: CacheEvent) => this.#onCache(event));
  }

  beginBoundary(baseRuleId: string): void {
    if (this.#active) throw new Error("Network collection boundary is already active");
    this.#records.length = 0;
    this.#current.clear();
    this.#pendingExtra.clear();
    this.#allowedRuleIds.clear();
    this.#allowedRuleIds.add(baseRuleId);
    this.#redirectObserved = false;
    this.#boundaryStarted = performance.now();
    this.#active = true;
  }

  addAllowedRule(ruleId: string): void {
    this.#allowedRuleIds.add(ruleId);
  }

  stopBoundary(): void {
    this.#active = false;
  }

  get requests(): readonly RequestEvidence[] {
    return this.#records.map((record) => Object.freeze(
      Object.fromEntries(Object.entries(record).filter(([key]) => key !== "terminal")) as RequestEvidence,
    ));
  }

  get transferredBytes(): number {
    return this.#records.reduce((total, record) => total + (record.terminal && !record.failed ? record.encodedBytes ?? 0 : 0), 0);
  }

  get failedRequestCount(): number {
    return this.#records.filter(({ failed }) => failed).length;
  }

  get pendingRequestCount(): number {
    return [...this.#current.values()].filter(({ terminal }) => !terminal).length;
  }

  get redirectObserved(): boolean {
    return this.#redirectObserved;
  }

  get servedFromCache(): boolean {
    return this.#records.some(({ response }) => response?.fromDiskCache);
  }

  get acceptLanguage(): string | null {
    for (const record of this.#records) {
      const value = headerValue(record.requestHeaders, "accept-language");
      if (value) return value;
    }
    return null;
  }

  get allRequestsMatchedAppliedRules(): boolean {
    const completed = this.#records.filter(({ terminal }) => terminal);
    return completed.length > 0 && completed.every(({ networkRuleId }) => networkRuleId !== null && this.#allowedRuleIds.has(networkRuleId));
  }

  async waitForIdle(timeoutMs: number): Promise<boolean> {
    if (this.pendingRequestCount === 0) return true;
    return new Promise<boolean>((resolve) => {
      const finish = () => {
        clearTimeout(timeout);
        this.#idleWaiters.delete(onIdle);
        resolve(true);
      };
      const onIdle = () => {
        if (this.pendingRequestCount === 0) finish();
      };
      const timeout = setTimeout(() => {
        this.#idleWaiters.delete(onIdle);
        resolve(false);
      }, timeoutMs);
      this.#idleWaiters.add(onIdle);
    });
  }

  #atMs(): number {
    return Math.max(0, performance.now() - this.#boundaryStarted);
  }

  #isTargetUrl(value: string): boolean {
    try {
      return new URL(value).origin === this.#targetOrigin;
    } catch {
      return false;
    }
  }

  #onRequest(event: RequestEvent): void {
    if (!this.#active || !this.#isTargetUrl(event.request.url)) return;
    const previous = this.#current.get(event.requestId);
    if (previous && !previous.terminal) {
      this.#redirectObserved = true;
      previous.failed = true;
      previous.failureText = "Redirected response is not admitted into the fixed journey measurement";
      previous.finishedAtMs = this.#atMs();
      previous.terminal = true;
    }
    const redirectIndex = this.#records.filter(({ requestId }) => requestId === event.requestId).length;
    const record: MutableRequest = {
      requestKey: `${event.requestId}:${redirectIndex}`,
      requestId: event.requestId,
      url: redactUrl(event.request.url),
      method: event.request.method,
      resourceType: event.type ?? "Other",
      startedAtMs: this.#atMs(),
      requestHeaders: redactHeaders(event.request.headers),
      requestBody: { present: event.request.hasPostData === true, redacted: true },
      response: null,
      finishedAtMs: null,
      encodedBytes: null,
      failed: false,
      failureText: null,
      networkRuleId: null,
      terminal: false,
    };
    this.#records.push(record);
    this.#current.set(event.requestId, record);
    const pending = this.#pendingExtra.get(event.requestId);
    if (pending) this.#applyExtra(record, pending);
  }

  #onExtraInfo(event: ExtraInfoEvent): void {
    if (!this.#active) return;
    const record = this.#current.get(event.requestId);
    if (record) this.#applyExtra(record, event);
    else this.#pendingExtra.set(event.requestId, event);
  }

  #applyExtra(record: MutableRequest, event: ExtraInfoEvent): void {
    record.requestHeaders = redactHeaders(event.headers);
    record.networkRuleId = typeof event.appliedNetworkConditionsId === "string" ? event.appliedNetworkConditionsId : null;
    this.#pendingExtra.delete(event.requestId);
  }

  #onResponse(event: ResponseEvent): void {
    if (!this.#active) return;
    const record = this.#current.get(event.requestId);
    if (!record) return;
    record.response = {
      status: event.response.status,
      mimeType: event.response.mimeType,
      headers: redactHeaders(event.response.headers),
      fromDiskCache: event.response.fromDiskCache === true,
      fromServiceWorker: event.response.fromServiceWorker === true,
    };
  }

  #onFinished(event: FinishedEvent): void {
    if (!this.#active) return;
    const record = this.#current.get(event.requestId);
    if (!record || record.terminal) return;
    if (!Number.isFinite(event.encodedDataLength) || event.encodedDataLength < 0) {
      record.failed = true;
      record.failureText = "Chromium returned an invalid encoded byte count";
    } else {
      record.encodedBytes = Math.round(event.encodedDataLength);
    }
    record.finishedAtMs = this.#atMs();
    record.terminal = true;
    this.#notifyIdle();
  }

  #onFailed(event: FailedEvent): void {
    if (!this.#active) return;
    const record = this.#current.get(event.requestId);
    if (!record || record.terminal) return;
    record.failed = true;
    record.failureText = redactText(event.canceled ? `Canceled: ${event.errorText}` : event.errorText);
    record.finishedAtMs = this.#atMs();
    record.terminal = true;
    this.#notifyIdle();
  }

  #onCache(event: CacheEvent): void {
    const record = this.#current.get(event.requestId);
    if (record?.response) record.response = { ...record.response, fromDiskCache: true };
  }

  #notifyIdle(): void {
    if (this.pendingRequestCount === 0) {
      for (const waiter of this.#idleWaiters) waiter();
    }
  }
}

export class BrowserLogCollector {
  readonly #messages: ConsoleEvidence[] = [];
  #boundaryStarted = 0;
  #active = false;

  attach(page: Page): void {
    page.on("console", (message) => this.#onConsole(message));
    page.on("pageerror", (error) => {
      if (!this.#active) return;
      this.#messages.push({
        kind: "pageerror",
        atMs: this.#atMs(),
        level: "error",
        text: redactText(error.message),
        location: null,
      });
    });
  }

  beginBoundary(): void {
    this.#messages.length = 0;
    this.#boundaryStarted = performance.now();
    this.#active = true;
  }

  stopBoundary(): void {
    this.#active = false;
  }

  get messages(): readonly ConsoleEvidence[] {
    return this.#messages;
  }

  get consoleErrorCount(): number {
    return this.#messages.filter(({ kind, level }) => kind === "console" && level === "error").length;
  }

  get pageErrorCount(): number {
    return this.#messages.filter(({ kind }) => kind === "pageerror").length;
  }

  #atMs(): number {
    return Math.max(0, performance.now() - this.#boundaryStarted);
  }

  #onConsole(message: ConsoleMessage): void {
    if (!this.#active) return;
    const location = message.location();
    this.#messages.push({
      kind: "console",
      atMs: this.#atMs(),
      level: message.type(),
      text: redactText(message.text()),
      location: location.url ? {
        url: redactUrl(location.url),
        lineNumber: location.lineNumber,
        columnNumber: location.columnNumber,
      } : null,
    });
  }
}
