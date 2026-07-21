import { TARGET_ID } from "../packages/contracts/src/index.js";
import { checkoutJourney } from "./journeys/checkout-v1";
import { indonesiaMobileProfile } from "./profiles/indonesia-mobile-v1";
import { roveproofDemoSeeds } from "./seeds/roveproof-demo-v1";

export const patchBudget = Object.freeze({ maxFiles: 5, maxChangedLines: 250 } as const);
export const performanceBudget = Object.freeze({ encodedBytes: 2_000_000, durationMs: 8_000 } as const);

export const demoConfig = Object.freeze({
  targetId: TARGET_ID,
  journey: checkoutJourney,
  profile: indonesiaMobileProfile,
  seedIds: roveproofDemoSeeds,
  patchBudget,
  performanceBudget,
  maxRepairAttempts: 1,
} as const);
