import { connection } from "next/server";
import DashboardClient from "./dashboard-client";
import { controlStore, fixturePreview, readReviewCandidate, resumeFixtureWorker, type ReviewCandidate } from "../lib/control-server";
import type { ControlJobView } from "@roveproof/contracts";

export default async function ControlHome() {
  await connection();
  let initialView: ControlJobView | null = null;
  let initialLoadError: string | null = null;
  let reviewCandidate: ReviewCandidate | null = null;
  try {
    const store = controlStore();
    initialView = await store.readLatestView();
    if (initialView) resumeFixtureWorker(store, initialView);
    reviewCandidate = await readReviewCandidate(store);
  } catch {
    initialLoadError = "Persisted control data failed validation. New work is blocked until the store is repaired or safely reset.";
  }

  return (
    <DashboardClient
      initialView={initialView}
      preview={fixturePreview()}
      initialLoadError={initialLoadError}
      reviewCandidate={reviewCandidate}
    />
  );
}
