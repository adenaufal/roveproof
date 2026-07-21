const MAX_JOB_REQUEST_BYTES = 1_024;

export class ControlApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ControlApiError";
    this.status = status;
    this.code = code;
  }
}

export function requireSameOrigin(request: Request): void {
  const suppliedOrigin = request.headers.get("origin");
  if (!suppliedOrigin) throw new ControlApiError(403, "ORIGIN_REJECTED", "A matching Origin header is required");
  try {
    const origin = new URL(suppliedOrigin);
    const configuredOrigin = process.env.ROVEPROOF_CONTROL_ORIGIN;
    if (configuredOrigin) {
      if (origin.origin !== new URL(configuredOrigin).origin) throw new Error("origin mismatch");
      return;
    }
    const requestUrl = new URL(request.url);
    const expectedHost = request.headers.get("host") || requestUrl.host;
    const expected = new URL(`${requestUrl.protocol}//${expectedHost}`);
    const loopback = expected.hostname === "localhost" || expected.hostname === "127.0.0.1" || expected.hostname === "[::1]";
    if (!loopback || origin.origin !== expected.origin) throw new Error("origin mismatch");
  } catch {
    throw new ControlApiError(403, "ORIGIN_REJECTED", "A matching Origin header is required");
  }
}

export async function readBoundedJson(request: Request): Promise<unknown> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new ControlApiError(415, "JSON_REQUIRED", "Content-Type must be application/json");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_JOB_REQUEST_BYTES)) {
    throw new ControlApiError(413, "BODY_TOO_LARGE", "Control job requests are limited to 1024 bytes");
  }
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let receivedBytes = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_JOB_REQUEST_BYTES) {
        await reader.cancel();
        throw new ControlApiError(413, "BODY_TOO_LARGE", "Control job requests are limited to 1024 bytes");
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ControlApiError(400, "INVALID_JSON", "Request body must contain valid JSON");
  }
}

export function noStoreHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store");
  return headers;
}

export function apiErrorResponse(error: unknown): Response {
  if (error instanceof ControlApiError) {
    return Response.json({ error: { code: error.code, message: error.message } }, {
      status: error.status,
      headers: noStoreHeaders(),
    });
  }
  return Response.json({ error: { code: "CONTROL_REQUEST_REJECTED", message: "The control request was rejected" } }, {
    status: 400,
    headers: noStoreHeaders(),
  });
}
