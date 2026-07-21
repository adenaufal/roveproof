import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

export const SYNTHETIC_CART_ID = "cart-bandung-001" as const;
export const SYNTHETIC_ORDER_TOTAL = 637_000 as const;

export type SyntheticOrder = Readonly<{
  orderId: string;
  cartId: typeof SYNTHETIC_CART_ID;
  total: typeof SYNTHETIC_ORDER_TOTAL;
  currency: "IDR";
  createdAt: string;
  timeZone: "Asia/Jakarta";
}>;

type StoredOrder = SyntheticOrder & Readonly<{
  schemaVersion: 1;
  idempotencyKeyHash: string;
  requestFingerprint: string;
  synthetic: true;
}>;

export type OrderPublicationFaultStage =
  | "after-temp-create"
  | "before-temp-write"
  | "after-temp-partial-write"
  | "after-temp-write"
  | "before-publish"
  | "after-publish";

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key was already used for a different synthetic request");
    this.name = "IdempotencyConflictError";
  }
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{8,128}$/;
const ORDER_FILE = /^[a-f0-9]{64}\.json$/;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

export function isValidIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY.test(value);
}

function publicOrder(stored: StoredOrder): SyntheticOrder {
  const { orderId, cartId, total, currency, createdAt, timeZone } = stored;
  return Object.freeze({ orderId, cartId, total, currency, createdAt, timeZone });
}

async function readExistingOrder(
  orderPath: string,
  idempotencyKeyHash: string,
  requestFingerprint: string,
): Promise<SyntheticOrder> {
  const stored = JSON.parse(await readFile(orderPath, "utf8")) as StoredOrder;
  if (stored.idempotencyKeyHash !== idempotencyKeyHash || stored.requestFingerprint !== requestFingerprint) {
    throw new IdempotencyConflictError();
  }
  return publicOrder(stored);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    // Windows does not expose fsync for directory handles. The file itself was synced before publication.
    if (process.platform !== "win32" || !["EACCES", "EINVAL", "EISDIR", "EPERM"].includes(errorCode(error) ?? "")) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
    if (bytesWritten === 0) throw new Error("Unable to complete synthetic order temp write");
    offset += bytesWritten;
  }
}

export async function createSyntheticOrder(options: {
  ordersDirectory: string;
  idempotencyKey: string;
  cartId: string;
  now?: () => Date;
  fault?: (stage: OrderPublicationFaultStage) => void | Promise<void>;
}): Promise<{ order: SyntheticOrder; replayed: boolean }> {
  if (!isValidIdempotencyKey(options.idempotencyKey)) {
    throw new TypeError("A valid idempotency key is required");
  }
  if (options.cartId !== SYNTHETIC_CART_ID) {
    throw new TypeError("Only the fixed synthetic cart is supported");
  }

  await mkdir(options.ordersDirectory, { recursive: true });
  const idempotencyKeyHash = sha256(options.idempotencyKey);
  const fileName = `${idempotencyKeyHash}.json`;
  if (!ORDER_FILE.test(fileName)) throw new Error("Invalid synthetic order path");

  const orderPath = path.join(options.ordersDirectory, fileName);
  const requestFingerprint = sha256(JSON.stringify({ cartId: options.cartId }));
  try {
    return {
      order: await readExistingOrder(orderPath, idempotencyKeyHash, requestFingerprint),
      replayed: true,
    };
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const stored: StoredOrder = Object.freeze({
    schemaVersion: 1,
    orderId: `RVP-${idempotencyKeyHash.slice(0, 10).toUpperCase()}`,
    cartId: SYNTHETIC_CART_ID,
    total: SYNTHETIC_ORDER_TOTAL,
    currency: "IDR",
    createdAt,
    timeZone: "Asia/Jakarta",
    idempotencyKeyHash,
    requestFingerprint,
    synthetic: true,
  });

  const bytes = Buffer.from(`${JSON.stringify(stored, null, 2)}\n`, "utf8");
  const tempPath = path.join(options.ordersDirectory, `.${idempotencyKeyHash}.${randomUUID()}.tmp`);
  let tempHandle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    tempHandle = await open(tempPath, "wx", 0o600);
    await options.fault?.("after-temp-create");
    await options.fault?.("before-temp-write");

    const split = Math.ceil(bytes.length / 2);
    await writeAll(tempHandle, bytes.subarray(0, split));
    await options.fault?.("after-temp-partial-write");
    await writeAll(tempHandle, bytes.subarray(split));
    await options.fault?.("after-temp-write");
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = undefined;

    await options.fault?.("before-publish");
    try {
      // A same-directory hard link publishes the fully synced inode atomically and never overwrites a winner.
      await link(tempPath, orderPath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      return {
        order: await readExistingOrder(orderPath, idempotencyKeyHash, requestFingerprint),
        replayed: true,
      };
    }
    await syncDirectory(options.ordersDirectory);
    await options.fault?.("after-publish");

    return { order: publicOrder(stored), replayed: false };
  } finally {
    await tempHandle?.close();
    await rm(tempPath, { force: true });
  }
}
