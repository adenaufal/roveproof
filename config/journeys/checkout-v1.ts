import { JOURNEY_ID, TARGET_ID } from "../../packages/contracts/src/index.js";

export const checkoutJourney = Object.freeze({
  id: JOURNEY_ID,
  targetId: TARGET_ID,
  version: 1,
} as const);
