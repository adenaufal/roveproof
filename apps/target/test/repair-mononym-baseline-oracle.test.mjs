// Immutable verifier-owned proof-stage oracle. The model cannot modify this
// target; it confirms the exact untouched mononym defect while the generated
// regression assertion independently fails in the same fixed test command.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MONONYM_SEED_ID,
  validateBaselineLegalName,
} from "../src/lib/seeds/identity.ts";

test("roveproof.verifier.baseline-mononym-defect", () => {
  assert.equal(MONONYM_SEED_ID, "ID-MONONYM-REQUIRED-LAST-NAME");
  assert.deepEqual(validateBaselineLegalName("Sari"), {
    valid: false,
    seedId: "ID-MONONYM-REQUIRED-LAST-NAME",
    message: "Masukkan nama depan dan nama belakang.",
  });
});
