import { SYNTHETIC_SHOPPER } from "@/lib/checkout-fixture";
import { validateBaselineLegalName } from "@/lib/seeds/identity";
import { normalizeBaselineIndonesianPhone } from "@/lib/seeds/phone";
import {
  HEAVY_RECOMMENDATIONS_SEED_ID,
  RECOMMENDATIONS_ROUTE,
} from "@/lib/seeds/recommendations";

export type CheckoutFieldName =
  | "fullName"
  | "phone"
  | "addressLine1"
  | "district"
  | "cityRegency"
  | "province"
  | "postalCode";

export type CheckoutValues = Record<CheckoutFieldName, string>;
export type CheckoutFieldErrors = Partial<Record<CheckoutFieldName, { message: string; seedId?: string }>>;

export const GENERIC_ORDER_ERROR = "Pesanan simulasi belum dapat dibuat. Silakan coba lagi.";
const ALLOWED_API_ERRORS = new Set([
  "Permintaan simulasi terlalu besar.",
  "Permintaan simulasi tidak valid.",
  "Tipe konten harus application/json.",
  "Content-Length tidak valid.",
  "Keranjang sintetis tidak valid.",
  "Kunci idempotensi tidak valid.",
  "Kunci idempotensi sudah digunakan.",
  GENERIC_ORDER_ERROR,
]);

export function mapOrderApiError(value: unknown): string {
  return typeof value === "string" && ALLOWED_API_ERRORS.has(value) ? value : GENERIC_ORDER_ERROR;
}

const REQUIRED_FIELDS: Array<[CheckoutFieldName, string]> = [
  ["addressLine1", "Masukkan alamat lengkap."],
  ["district", "Masukkan kecamatan."],
  ["cityRegency", "Masukkan kota atau kabupaten."],
  ["province", "Masukkan provinsi."],
];

export const SYNTHETIC_CHECKOUT_VALUES: CheckoutValues = Object.freeze({
  fullName: SYNTHETIC_SHOPPER.fullName,
  phone: SYNTHETIC_SHOPPER.phoneDisplay,
  addressLine1: SYNTHETIC_SHOPPER.addressLine1,
  district: SYNTHETIC_SHOPPER.district,
  cityRegency: SYNTHETIC_SHOPPER.cityRegency,
  province: SYNTHETIC_SHOPPER.province,
  postalCode: SYNTHETIC_SHOPPER.postalCode,
});

/** The submission behavior used by CheckoutForm, including both intentional identity seeds. */
export function validateCheckoutValues(values: CheckoutValues): CheckoutFieldErrors {
  const value = (name: CheckoutFieldName) => values[name].trim();
  const errors: CheckoutFieldErrors = {};

  const identity = validateBaselineLegalName(value("fullName"));
  if (!identity.valid) errors.fullName = { message: identity.message, seedId: identity.seedId };

  const phone = normalizeBaselineIndonesianPhone(value("phone"));
  if (!phone.valid) errors.phone = { message: phone.message, seedId: phone.seedId };

  for (const [field, message] of REQUIRED_FIELDS) {
    if (!value(field)) errors[field] = { message };
  }
  if (!/^\d{5}$/.test(value("postalCode"))) {
    errors.postalCode = { message: "Kode pos harus terdiri dari 5 angka." };
  }

  return errors;
}

export type RecommendationsLoad = Readonly<{
  seedId: typeof HEAVY_RECOMMENDATIONS_SEED_ID;
  decodedBytes: number;
}>;

type BootstrappedRecommendations = Readonly<{
  ok: boolean;
  seedId: string | null;
  decodedBytes: number;
}>;

declare global {
  interface Window {
    __roveproofRecommendationsRequest?: Promise<BootstrappedRecommendations>;
  }
}

/** The eager network behavior used by CheckoutForm; the full response is deliberately consumed. */
export async function loadEagerCheckoutRecommendations(fetcher: typeof fetch = fetch): Promise<RecommendationsLoad> {
  const bootstrapped = typeof window !== "undefined" && fetcher === fetch
    ? window.__roveproofRecommendationsRequest
    : undefined;
  if (bootstrapped) {
    const loaded = await bootstrapped;
    if (!loaded.ok) throw new Error("Recommendations unavailable");
    if (loaded.seedId !== HEAVY_RECOMMENDATIONS_SEED_ID) throw new Error("Recommendations seed unavailable");
    return { seedId: HEAVY_RECOMMENDATIONS_SEED_ID, decodedBytes: loaded.decodedBytes };
  }

  const response = await fetcher(RECOMMENDATIONS_ROUTE, { cache: "no-store" });
  if (!response.ok) throw new Error("Recommendations unavailable");

  const seedId = response.headers.get("X-Roveproof-Seed-Id");
  if (seedId !== HEAVY_RECOMMENDATIONS_SEED_ID) throw new Error("Recommendations seed unavailable");

  return {
    seedId,
    decodedBytes: (await response.arrayBuffer()).byteLength,
  };
}
