import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSyntheticOrder,
  type OrderPublicationFaultStage,
  SYNTHETIC_CART_ID,
} from "../src/lib/order-store";

const temporaryDirectories: string[] = [];

async function temporaryOrderDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "roveproof-orders-"));
  temporaryDirectories.push(root);
  return path.join(root, "orders");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("durable synthetic order idempotency", () => {
  it("persists one order and replays it for the same key across calls", async () => {
    const ordersDirectory = await temporaryOrderDirectory();
    const idempotencyKey = "rvp:test-order-0001";
    const first = await createSyntheticOrder({
      ordersDirectory,
      idempotencyKey,
      cartId: SYNTHETIC_CART_ID,
      now: () => new Date("2026-07-18T03:00:00.000Z"),
    });
    const repeat = await createSyntheticOrder({
      ordersDirectory,
      idempotencyKey,
      cartId: SYNTHETIC_CART_ID,
      now: () => new Date("2026-07-19T03:00:00.000Z"),
    });

    expect(first.replayed).toBe(false);
    expect(repeat.replayed).toBe(true);
    expect(repeat.order).toEqual(first.order);
    expect(first.order.createdAt).toBe("2026-07-18T03:00:00.000Z");

    const files = await readdir(ordersDirectory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    expect(await readFile(path.join(ordersDirectory, files[0]), "utf8")).not.toContain(idempotencyKey);
  });

  it("atomically resolves concurrent publication races without overwriting the winner", async () => {
    const ordersDirectory = await temporaryOrderDirectory();
    const attempts = await Promise.all(
      Array.from({ length: 5 }, (_, index) => createSyntheticOrder({
        ordersDirectory,
        idempotencyKey: "rvp:concurrent-order-0001",
        cartId: SYNTHETIC_CART_ID,
        now: () => new Date(`2026-07-18T04:00:0${index}.000Z`),
      })),
    );

    expect(attempts.filter((attempt) => !attempt.replayed)).toHaveLength(1);
    expect(new Set(attempts.map((attempt) => attempt.order.orderId))).toHaveLength(1);
    expect(new Set(attempts.map((attempt) => attempt.order.createdAt))).toHaveLength(1);
    const files = await readdir(ordersDirectory);
    expect(files).toHaveLength(1);
    const published = await readFile(path.join(ordersDirectory, files[0]), "utf8");
    expect(() => JSON.parse(published)).not.toThrow();
  });

  it.each([
    "after-temp-create",
    "before-temp-write",
    "after-temp-write",
    "before-publish",
  ] satisfies OrderPublicationFaultStage[])("cleans a failed %s attempt and recovers on a restart with no final partial file", async (faultStage) => {
    const ordersDirectory = await temporaryOrderDirectory();
    const options = {
      ordersDirectory,
      idempotencyKey: `rvp:fault-${faultStage}`,
      cartId: SYNTHETIC_CART_ID,
      now: () => new Date("2026-07-18T05:00:00.000Z"),
    };

    await expect(createSyntheticOrder({
      ...options,
      fault(stage) {
        if (stage === faultStage) throw new Error(`injected ${stage}`);
      },
    })).rejects.toThrow(`injected ${faultStage}`);
    expect(await readdir(ordersDirectory)).toEqual([]);

    const retry = await createSyntheticOrder(options);
    expect(retry.replayed).toBe(false);
    const files = await readdir(ordersDirectory);
    expect(files).toHaveLength(1);
    const stored = await readFile(path.join(ordersDirectory, files[0]), "utf8");
    expect(stored.length).toBeGreaterThan(0);
    expect(() => JSON.parse(stored)).not.toThrow();
  });

  it("never exposes a partially written temp file at the final record path", async () => {
    const ordersDirectory = await temporaryOrderDirectory();
    let observedPartialBytes = 0;

    await expect(createSyntheticOrder({
      ordersDirectory,
      idempotencyKey: "rvp:fault-partial-write",
      cartId: SYNTHETIC_CART_ID,
      fault: async (stage) => {
        if (stage !== "after-temp-partial-write") return;
        const files = await readdir(ordersDirectory);
        const tempFile = files.find((file) => file.endsWith(".tmp"));
        expect(tempFile).toBeDefined();
        const partial = await readFile(path.join(ordersDirectory, tempFile!), "utf8");
        observedPartialBytes = Buffer.byteLength(partial);
        expect(() => JSON.parse(partial)).toThrow();
        expect(files.some((file) => file.endsWith(".json"))).toBe(false);
        throw new Error("injected partial write failure");
      },
    })).rejects.toThrow("injected partial write failure");

    expect(observedPartialBytes).toBeGreaterThan(0);
    expect(await readdir(ordersDirectory)).toEqual([]);
    const retry = await createSyntheticOrder({
      ordersDirectory,
      idempotencyKey: "rvp:fault-partial-write",
      cartId: SYNTHETIC_CART_ID,
    });
    expect(retry.replayed).toBe(false);
  });

  it("recovers after a failure immediately after atomic publication", async () => {
    const ordersDirectory = await temporaryOrderDirectory();
    const options = {
      ordersDirectory,
      idempotencyKey: "rvp:fault-after-publish",
      cartId: SYNTHETIC_CART_ID,
      now: () => new Date("2026-07-18T06:00:00.000Z"),
    };

    await expect(createSyntheticOrder({
      ...options,
      fault(stage) {
        if (stage === "after-publish") throw new Error("lost response after publish");
      },
    })).rejects.toThrow("lost response after publish");

    const filesAfterFault = await readdir(ordersDirectory);
    expect(filesAfterFault).toHaveLength(1);
    const completeRecord = await readFile(path.join(ordersDirectory, filesAfterFault[0]), "utf8");
    expect(() => JSON.parse(completeRecord)).not.toThrow();

    const retry = await createSyntheticOrder(options);
    expect(retry.replayed).toBe(true);
    expect(retry.order.createdAt).toBe("2026-07-18T06:00:00.000Z");
  });

  it("does not let an unrelated stale temp artifact block a retry", async () => {
    const ordersDirectory = await temporaryOrderDirectory();
    await mkdir(ordersDirectory, { recursive: true });
    await writeFile(path.join(ordersDirectory, ".stale-crash.tmp"), "partial", "utf8");

    const result = await createSyntheticOrder({
      ordersDirectory,
      idempotencyKey: "rvp:stale-temp-retry",
      cartId: SYNTHETIC_CART_ID,
    });

    expect(result.replayed).toBe(false);
    const files = await readdir(ordersDirectory);
    expect(files.filter((file) => file.endsWith(".json"))).toHaveLength(1);
  });
});
