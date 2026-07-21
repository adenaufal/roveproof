import type { Metadata } from "next";
import { HEAVY_RECOMMENDATIONS_SEED_ID, RECOMMENDATIONS_ROUTE } from "@/lib/seeds/recommendations";
import { CheckoutForm } from "./checkout-form";

export const metadata: Metadata = {
  title: "Checkout sintetis · Rantau Goods",
  description: "Checkout sintetis Indonesia untuk pengujian Roveproof.",
};

const eagerRecommendationsBootstrap = `window.__roveproofRecommendationsRequest=fetch(${JSON.stringify(RECOMMENDATIONS_ROUTE)},{cache:"no-store"}).then(async function(response){return{ok:response.ok,seedId:response.headers.get("X-Roveproof-Seed-Id"),decodedBytes:(await response.arrayBuffer()).byteLength}}).catch(function(){return{ok:false,seedId:null,decodedBytes:0}});`;

export default function CheckoutPage() {
  return (
    <>
      <script
        data-roveproof-seed={HEAVY_RECOMMENDATIONS_SEED_ID}
        dangerouslySetInnerHTML={{ __html: eagerRecommendationsBootstrap }}
      />
      <CheckoutForm />
    </>
  );
}
