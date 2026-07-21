import path from "node:path";
import {
  createSyntheticOrder,
  IdempotencyConflictError,
  isValidIdempotencyKey,
  SYNTHETIC_CART_ID,
} from "@/lib/order-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ORDER_BODY_BYTES = 4_096;

function ordersDirectory(): string {
  if (process.env.ROVEPROOF_DATA_DIR) {
    return path.resolve(process.env.ROVEPROOF_DATA_DIR, "synthetic-orders");
  }

  const currentDirectory = process.cwd();
  const workspaceRoot = currentDirectory.endsWith(path.join("apps", "target"))
    ? path.resolve(currentDirectory, "..", "..")
    : currentDirectory;
  return path.join(workspaceRoot, "var", "roveproof", "synthetic-orders");
}

function errorResponse(message: string, status: number): Response {
  return Response.json(
    { synthetic: true, error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function isApplicationJson(contentType: string | null): boolean {
  return contentType?.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function declaredContentLength(request: Request): { invalid: boolean; tooLarge: boolean } {
  const header = request.headers.get("Content-Length");
  if (header === null) return { invalid: false, tooLarge: false };
  const value = header.trim();
  if (!/^(0|[1-9]\d*)$/.test(value)) return { invalid: true, tooLarge: false };
  return { invalid: false, tooLarge: BigInt(value) > BigInt(MAX_ORDER_BODY_BYTES) };
}

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_ORDER_BODY_BYTES) {
        try {
          await reader.cancel("Order request body exceeds 4096 bytes");
        } catch {
          // The 413 response must not depend on producer cancellation support.
        }
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function POST(request: Request): Promise<Response> {
  const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";
  if (!isValidIdempotencyKey(idempotencyKey)) {
    return errorResponse("Kunci idempotensi tidak valid.", 400);
  }

  if (!isApplicationJson(request.headers.get("Content-Type"))) {
    return errorResponse("Tipe konten harus application/json.", 415);
  }

  const contentLength = declaredContentLength(request);
  if (contentLength.invalid) return errorResponse("Content-Length tidak valid.", 400);
  if (contentLength.tooLarge) return errorResponse("Permintaan simulasi terlalu besar.", 413);

  const encodedBody = await readBoundedBody(request);
  if (encodedBody === null) return errorResponse("Permintaan simulasi terlalu besar.", 413);

  let input: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(encodedBody);
    input = JSON.parse(text) as unknown;
  } catch {
    return errorResponse("Permintaan simulasi tidak valid.", 400);
  }

  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    (input as { cartId?: unknown }).cartId !== SYNTHETIC_CART_ID
  ) {
    return errorResponse("Keranjang sintetis tidak valid.", 400);
  }

  try {
    const result = await createSyntheticOrder({
      ordersDirectory: ordersDirectory(),
      idempotencyKey,
      cartId: SYNTHETIC_CART_ID,
    });

    return Response.json(
      { synthetic: true, replayed: result.replayed, order: result.order },
      { status: result.replayed ? 200 : 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof TypeError) return errorResponse("Kunci idempotensi tidak valid.", 400);
    if (error instanceof IdempotencyConflictError) return errorResponse("Kunci idempotensi sudah digunakan.", 409);
    return errorResponse("Pesanan simulasi belum dapat dibuat. Silakan coba lagi.", 500);
  }
}
