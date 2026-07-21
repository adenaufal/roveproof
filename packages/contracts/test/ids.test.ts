import { describe, expect, it } from "vitest";
import { demoConfig } from "../../../config/demo.js";
import { checkoutJourney } from "../../../config/journeys/checkout-v1.js";
import { indonesiaMobileProfile } from "../../../config/profiles/indonesia-mobile-v1.js";
import { roveproofDemoSeeds } from "../../../config/seeds/roveproof-demo-v1.js";
import {
  JobRequestSchema, JOURNEY_ID, JourneyIdSchema, PROFILE_ID, ProfileIdSchema,
  SEED_IDS, TARGET_ID, TargetIdSchema,
} from "../src/index.js";

describe("fixed IDs", () => {
  it.each([
    [TargetIdSchema, "another-target"],
    [JourneyIdSchema, "checkout-v2"],
    [ProfileIdSchema, "desktop-v1"],
  ])("rejects unsupported IDs", (schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it("keeps fixed demo configuration synchronized with contract constants", () => {
    expect(demoConfig.targetId).toBe(TARGET_ID);
    expect(checkoutJourney.id).toBe(JOURNEY_ID);
    expect(checkoutJourney.targetId).toBe(TARGET_ID);
    expect(indonesiaMobileProfile.id).toBe(PROFILE_ID);
    expect(roveproofDemoSeeds).toEqual(SEED_IDS);
    expect(demoConfig.seedIds).toEqual(SEED_IDS);
  });

  it("rejects changed seeds and unknown schema versions", () => {
    const request = {
      schemaVersion: 1, targetId: "seeded-checkout-v1", journeyId: "checkout-v1",
      profileId: "indonesia-mobile-v1", seedIds: ["MOBILE-HEAVY-CHECKOUT-BUNDLE"], mode: "real",
    };
    expect(JobRequestSchema.safeParse(request).success).toBe(false);
    expect(JobRequestSchema.safeParse({ ...request, schemaVersion: 2 }).success).toBe(false);
  });
});
