import { PROFILE_ID } from "../../packages/contracts/src/index.js";
import profile from "./indonesia-mobile-v1.json";

if (profile.id !== PROFILE_ID) throw new Error("Indonesia Mobile profile ID does not match the fixed contract");

export const indonesiaMobileProfile = Object.freeze({
  ...profile,
  id: PROFILE_ID,
  viewport: Object.freeze({ ...profile.viewport }),
  network: Object.freeze({ ...profile.network }),
  jitter: Object.freeze({
    ...profile.jitter,
    events: Object.freeze(profile.jitter.events.map((event) => Object.freeze({ ...event }))),
  }),
});
