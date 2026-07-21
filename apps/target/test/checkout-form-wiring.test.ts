import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const CHECKOUT_FORM_PATH = new URL("../src/app/checkout/checkout-form.tsx", import.meta.url);
const CHECKOUT_PAGE_PATH = new URL("../src/app/checkout/page.tsx", import.meta.url);

describe("CheckoutForm seed wiring guard", () => {
  it("keeps submission validation and the eager network behavior connected to the form", async () => {
    const source = await readFile(CHECKOUT_FORM_PATH, "utf8");

    expect(source).toContain("validateCheckoutValues(checkoutValues(event.currentTarget))");
    expect(source).toContain("recommendationRequestRef.current ??= loadEagerCheckoutRecommendations()");
    expect(source).toMatch(/useEffect\(\(\) => \{[\s\S]*loadEagerCheckoutRecommendations\(\)[\s\S]*\}, \[\]\);/);
    expect(source).toContain("defaultValue={SYNTHETIC_SHOPPER.fullName}");
    expect(source).toContain("defaultValue={SYNTHETIC_SHOPPER.phoneDisplay}");
  });

  it("starts and consumes the same heavy recommendations request before hydration", async () => {
    const [pageSource, behaviorSource] = await Promise.all([
      readFile(CHECKOUT_PAGE_PATH, "utf8"),
      readFile(new URL("../src/app/checkout/checkout-behavior.ts", import.meta.url), "utf8"),
    ]);

    expect(pageSource).toContain("window.__roveproofRecommendationsRequest=fetch");
    expect(pageSource).toContain("response.arrayBuffer()");
    expect(behaviorSource).toContain("window.__roveproofRecommendationsRequest");
    expect(behaviorSource).toContain("const loaded = await bootstrapped");
  });
});
