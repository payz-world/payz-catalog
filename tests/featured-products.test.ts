import assert from "node:assert/strict";
import { test } from "node:test";
import type { Product } from "payz-core/types";
import { selectFeaturedProducts } from "../src/lib/catalog-curation";

function product(brand: string, overrides: Partial<Product> = {}): Product {
  const region = { code: "US", name: "United States", currency: "USD", currencySymbol: "$" };
  return {
    id: brand.toLowerCase(), variantId: `${brand}-us`, brand, name: brand,
    description: `${brand} product`, categoryId: "shopping", categoryName: "Shopping",
    regionCode: "US", currency: "USD", currencySymbol: "$", startingPrice: 20,
    denominations: [20], range: null, regions: [region], availableRegions: [region],
    currencies: ["USD"], available: true, featured: true, isPreview: false,
    logoKey: brand.toLowerCase(), brandColor: "#fff", image: "https://example.com/logo.png",
    ...overrides,
  };
}

test("Featured selects major brands in editorial order, not alphabetically", () => {
  const input = ["Academy Sports + Outdoors", "Adidas", "Airbnb", "AJIO", "Alfamart",
    "Amazon Fresh", "Amazon", "Apple", "Netflix", "Spotify", "Steam"].map((brand) => product(brand));
  const snapshot = input.map((item) => item.brand);
  assert.deepEqual(selectFeaturedProducts(input, 8).map((item) => item.brand),
    ["Amazon", "Netflix", "Spotify", "Steam", "Apple", "Airbnb", "Adidas"]);
  assert.deepEqual(input.map((item) => item.brand), snapshot);
  assert.ok(input.some((item) => item.brand === "Alfamart"));
});

test("Featured puts McDonald's and KFC first without duplicating McDonald's aliases", () => {
  const selected = selectFeaturedProducts([
    product("Amazon"),
    product("KFC USA"),
    product("McDonald's South Korea"),
    product("McDonalds"),
  ], 4);
  assert.deepEqual(selected.map((item) => item.brand), [
    "McDonalds", "KFC USA", "Amazon",
  ]);
});

test("Featured never fills empty slots with Alfamart or unavailable offers", () => {
  assert.deepEqual(selectFeaturedProducts([
    product("Alfamart"), product("Netflix", { available: false }),
    product("Amazon", { availableRegions: [] }),
  ], 8), []);
  assert.deepEqual(selectFeaturedProducts([product("Amazon")], 0), []);
});

test("Featured respects its limit, canonical brands, and real regional variants", () => {
  const selected = selectFeaturedProducts([
    product("Spotify"), product("Amazon Fresh"), product("Amazon"),
    product("Amazon", { id: "amazon-other" }), product("Netflix"),
  ], 2);
  assert.deepEqual(selected.map((item) => item.brand), ["Amazon", "Netflix"]);
  assert.equal(selectFeaturedProducts([product("Google Play US")], 8)[0]?.brand, "Google Play US");
});
