import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/orders/route";

const temporaryDirectories: string[] = [];

async function useTemporaryDataDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "roveproof-route-"));
  temporaryDirectories.push(directory);
  vi.stubEnv("ROVEPROOF_DATA_DIR", directory);
  return directory;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function orderRequest(
  key = "rvp:route-order-0001",
  body: BodyInit = JSON.stringify({ cartId: "cart-bandung-001" }),
  headers: Record<string, string> = {},
): Request {
  return new Request("http://target.test/api/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      ...headers,
    },
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

async function expectError(request: Request, status: number, error: string): Promise<void> {
  const response = await POST(request);
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({ synthetic: true, error });
}

describe("synthetic order Route Handler", () => {
  it("returns one durable order and an idempotent replay without duplicating it", async () => {
    const dataDirectory = await useTemporaryDataDirectory();

    const first = await POST(orderRequest());
    const replay = await POST(orderRequest());
    const firstBody = await first.json();
    const replayBody = await replay.json();

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(firstBody).toMatchObject({ synthetic: true, replayed: false });
    expect(replayBody).toMatchObject({ synthetic: true, replayed: true });
    expect(replayBody.order).toEqual(firstBody.order);
    expect(await readdir(path.join(dataDirectory, "synthetic-orders"))).toHaveLength(1);
  });

  it.each(["", "short", "bad key with spaces", `rvp:${"x".repeat(125)}`])(
    "rejects a missing or invalid idempotency key before touching the body: %j",
    async (key) => {
      let bodyAccessed = false;
      const request = {
        headers: new Headers({ "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }),
        get body() {
          bodyAccessed = true;
          throw new Error("body must not be read");
        },
      } as unknown as Request;

      await expectError(request, 400, "Kunci idempotensi tidak valid.");
      expect(bodyAccessed).toBe(false);
    },
  );

  it.each([undefined, "text/plain", "application/json-patch+json"])(
    "requires application/json content type: %j",
    async (contentType) => {
      const headers: Record<string, string> = { "Idempotency-Key": "rvp:route-order-type" };
      if (contentType) headers["Content-Type"] = contentType;
      const request = new Request("http://target.test/api/orders", {
        method: "POST",
        headers,
        body: JSON.stringify({ cartId: "cart-bandung-001" }),
      });
      await expectError(request, 415, "Tipe konten harus application/json.");
    },
  );

  it("accepts a valid request without Content-Length", async () => {
    await useTemporaryDataDirectory();
    const request = orderRequest("rvp:no-content-length");
    expect(request.headers.has("Content-Length")).toBe(false);
    expect((await POST(request)).status).toBe(201);
  });

  it.each(["abc", "-1", "+12", "1.5"])("rejects malformed or negative Content-Length %j", async (value) => {
    await expectError(
      orderRequest("rvp:bad-content-length", JSON.stringify({ cartId: "cart-bandung-001" }), { "Content-Length": value }),
      400,
      "Content-Length tidak valid.",
    );
  });

  it("does not trust a dishonest small Content-Length for an oversized body", async () => {
    await expectError(
      orderRequest("rvp:dishonest-length", "x".repeat(4_097), { "Content-Length": "1" }),
      413,
      "Permintaan simulasi terlalu besar.",
    );
  });

  it("cancels a chunked stream as soon as its actual byte count exceeds 4,096", async () => {
    const cancel = vi.fn();
    let chunk = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunk += 1;
        controller.enqueue(new Uint8Array(1_500));
        if (chunk === 4) controller.close();
      },
      cancel,
    });
    const request = orderRequest("rvp:chunked-oversize", body);
    expect(request.headers.has("Content-Length")).toBe(false);

    await expectError(request, 413, "Permintaan simulasi terlalu besar.");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects a declared body larger than the limit without consuming it", async () => {
    await expectError(
      orderRequest("rvp:declared-oversize", "{}", { "Content-Length": "4097" }),
      413,
      "Permintaan simulasi terlalu besar.",
    );
  });

  it.each([
    ["", "Permintaan simulasi tidak valid."],
    ["{", "Permintaan simulasi tidak valid."],
    ["not-json", "Permintaan simulasi tidak valid."],
    ["[]", "Keranjang sintetis tidak valid."],
    [JSON.stringify([{ cartId: "cart-bandung-001" }]), "Keranjang sintetis tidak valid."],
    [JSON.stringify({ cartId: "real-cart" }), "Keranjang sintetis tidak valid."],
    [JSON.stringify({ cartId: "cart-bandung-001", extra: true }), "Keranjang sintetis tidak valid."],
  ])("strictly rejects invalid JSON or request shape %#", async (body, error) => {
    await expectError(orderRequest("rvp:invalid-shape", body), 400, error);
  });
});
