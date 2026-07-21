export const MONONYM_SEED_ID = "ID-MONONYM-REQUIRED-LAST-NAME" as const;

export type IdentityValidation =
  | { valid: true }
  | { valid: false; seedId: typeof MONONYM_SEED_ID; message: string };

/** Intentional baseline seed: this incorrectly requires a given and family name. */
export function validateBaselineLegalName(value: string): IdentityValidation {
  const nameParts = value.trim().split(/\s+/).filter(Boolean);
  if (nameParts.length < 2) {
    return {
      valid: false,
      seedId: MONONYM_SEED_ID,
      message: "Masukkan nama depan dan nama belakang.",
    };
  }

  return { valid: true };
}
