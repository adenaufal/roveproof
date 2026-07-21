export const REDACTION_POLICY = "roveproof-redaction-v1" as const;
export const REDACTION_SCOPE = "credentials-secrets-and-unexpected-pii" as const;
export const DATA_CLASSIFICATION = "fixed-synthetic-only" as const;
export const REDACTED_VALUE = "[REDACTED]" as const;

const SENSITIVE_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i;
const SENSITIVE_KEY = /(?:^|[-_.])(?:access[-_.]?token|api[-_.]?key|auth|authorization|code|cookie|credential|key|password|secret|signature|sig|token)(?:$|[-_.])/i;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/gi;
const BEARER_VALUE = /\bBearer\s+(?!\[REDACTED\])[^\s,"'}]+/gi;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const ASSIGNED_SECRET = /\b((?:access[-_]?token|api[-_]?key|password|secret|signature|token)\s*[:=]\s*)(?!\[REDACTED\]|%5BREDACTED%5D)([^\s,;"'}&]+)/gi;
const HEADER_SECRET = /\b((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*)(?!\[REDACTED\])([^\r\n]+)/gi;

export type HeaderInput = Record<string, unknown>;

export function isSensitiveName(name: string): boolean {
  return SENSITIVE_HEADER.test(name) || SENSITIVE_KEY.test(name);
}

export function redactHeaders(headers: HeaderInput): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      isSensitiveName(name) ? REDACTED_VALUE : redactText(String(value)),
    ]),
  );
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = REDACTED_VALUE;
    if (url.password) url.password = REDACTED_VALUE;
    for (const name of [...url.searchParams.keys()]) {
      if (isSensitiveName(name)) url.searchParams.set(name, REDACTED_VALUE);
    }
    return url.toString();
  } catch {
    return value.replace(/([?&])([^=&\s]+)=([^&#\s]+)/g, (match, prefix: string, name: string) =>
      isSensitiveName(name) ? `${prefix}${name}=${encodeURIComponent(REDACTED_VALUE)}` : match,
    );
  }
}

export function redactText(value: string): string {
  return value
    .replace(URL_IN_TEXT, (url) => redactUrl(url))
    .replace(BEARER_VALUE, `Bearer ${REDACTED_VALUE}`)
    .replace(JWT_VALUE, REDACTED_VALUE)
    .replace(ASSIGNED_SECRET, `$1${REDACTED_VALUE}`)
    .replace(HEADER_SECRET, `$1${REDACTED_VALUE}`);
}

function sanitizeNameValueList(value: unknown, kind: "headers" | "cookies" | "query"): unknown {
  if (!Array.isArray(value)) return sanitizeHarNode(value);
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return sanitizeHarNode(entry);
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    const shouldRedact = kind === "cookies" || isSensitiveName(name);
    return Object.fromEntries(Object.entries(record).map(([key, item]) => {
      if (key === "value" && shouldRedact) return [key, REDACTED_VALUE];
      return [key, sanitizeHarNode(item, key)];
    }));
  });
}

function sanitizePostData(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return REDACTED_VALUE;
  const record = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = { _roveproofRedacted: true };
  if (typeof record.mimeType === "string") sanitized.mimeType = redactText(record.mimeType);
  if ("text" in record) sanitized.text = REDACTED_VALUE;
  if (Array.isArray(record.params)) {
    sanitized.params = record.params.map((parameter) => {
      if (!parameter || typeof parameter !== "object" || Array.isArray(parameter)) return REDACTED_VALUE;
      const item = parameter as Record<string, unknown>;
      return {
        ...(typeof item.name === "string" ? { name: redactText(item.name) } : {}),
        value: REDACTED_VALUE,
      };
    });
  }
  return sanitized;
}

function sanitizeContent(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return sanitizeHarNode(value);
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(record).map(([key, item]) => {
    if (key === "text") return [key, REDACTED_VALUE];
    return [key, sanitizeHarNode(item, key)];
  }));
}

function sanitizeHarNode(value: unknown, parentKey = ""): unknown {
  if (typeof value === "string") return parentKey.toLowerCase().includes("url") ? redactUrl(value) : redactText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeHarNode(item, parentKey));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    const normalized = key.toLowerCase();
    if (normalized === "headers") return [key, sanitizeNameValueList(item, "headers")];
    if (normalized === "cookies") return [key, sanitizeNameValueList(item, "cookies")];
    if (normalized === "querystring") return [key, sanitizeNameValueList(item, "query")];
    if (normalized === "postdata") return [key, sanitizePostData(item)];
    if (normalized === "content") return [key, sanitizeContent(item)];
    if (isSensitiveName(key)) return [key, REDACTED_VALUE];
    return [key, sanitizeHarNode(item, key)];
  }));
}

export function sanitizeHar(value: unknown): unknown {
  return sanitizeHarNode(value);
}

export function findSensitiveData(value: string): string | null {
  const checks: Array<[string, RegExp]> = [
    ["bearer token", /\bBearer\s+(?!\[REDACTED\])[^\s,"'}]+/i],
    ["JSON web token", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
    ["sensitive URL parameter", /[?&](?:access[-_]?token|api[-_]?key|auth|code|credential|key|password|secret|signature|sig|token)=(?!%5BREDACTED%5D|\[REDACTED\])[^&#\s]+/i],
    ["assigned secret", /\b(?:access[-_]?token|api[-_]?key|password|secret|signature|token)\s*[:=]\s*(?!\[REDACTED\]|%5BREDACTED%5D)[^\s,;"'}&]+/i],
    ["sensitive header", /\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*(?!\[REDACTED\])[^\r\n,}]+/i],
    ["structured sensitive value", /"(?:access[-_]?token|api[-_]?key|authorization|cookie|password|secret|set-cookie|signature|token|x-api-key)"\s*:\s*"(?!\[REDACTED\])[^"\r\n]+/i],
    ["structured sensitive header", /"name"\s*:\s*"(?:authorization|cookie|set-cookie|x-api-key)"\s*,\s*"value"\s*:\s*"(?!\[REDACTED\])[^"\r\n]+/i],
  ];
  const credentialFinding = checks.find(([, pattern]) => pattern.test(value))?.[0];
  if (credentialFinding) return credentialFinding;

  const withoutFixedSyntheticData = value
    .replace(/(?:\+62[\s-]?812[\s-]?3456[\s-]?7890|\+6281234567890|0812[\s-]?3456[\s-]?7890)/gi, "[SYNTHETIC_PHONE]")
    .replace(/Jl\. Asia Afrika No\. 8/gi, "[SYNTHETIC_ADDRESS]")
    .replace(/page@[a-f0-9-]+\.(?:jpeg|png)/gi, "[TRACE_SCREENSHOT]");
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(withoutFixedSyntheticData)) return "unexpected email address";
  if (/\+62[\s-]?\d(?:[\d\s-]{7,})\d/.test(withoutFixedSyntheticData)) return "unexpected Indonesian phone number";
  if (/\b08\d{1,3}(?:[\s-]\d{3,4}){2,3}\b/.test(withoutFixedSyntheticData)) return "unexpected Indonesian phone number";
  if (/(?:phone|tel|ponsel)[^\r\n]{0,40}\b08\d{8,11}\b/i.test(withoutFixedSyntheticData)) return "unexpected Indonesian phone number";
  if (/\b(?:Jl\.?|Jalan)\s+[A-Za-z]/i.test(withoutFixedSyntheticData)) return "unexpected street address";
  return null;
}
