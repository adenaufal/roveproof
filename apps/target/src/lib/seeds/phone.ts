export const PLUS62_PHONE_SEED_ID = "ID-PHONE-PLUS62-NORMALIZATION" as const;

export type PhoneNormalization =
  | { valid: true; e164: string }
  | { valid: false; seedId: typeof PLUS62_PHONE_SEED_ID; message: string };

const DOMESTIC_PHONE = /^0(8\d{8,11})$/;

/** Intentional baseline seed: valid +62 input is rejected before normalization. */
export function normalizeBaselineIndonesianPhone(value: string): PhoneNormalization {
  const compact = value.trim().replace(/[\s-]/g, "");
  const domesticMatch = DOMESTIC_PHONE.exec(compact);

  if (!domesticMatch) {
    return {
      valid: false,
      seedId: PLUS62_PHONE_SEED_ID,
      message: "Gunakan nomor Indonesia yang diawali 08.",
    };
  }

  return { valid: true, e164: `+62${domesticMatch[1]}` };
}
