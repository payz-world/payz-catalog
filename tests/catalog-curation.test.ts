import assert from "node:assert/strict";
import { after, test } from "node:test";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import {
  db, pool, catalogCurationTable, catalogSyncStateTable, productDenominationsTable, productsTable,
  type ProductDenominationRecord, type ProductRecord,
} from "payz-core/db";
import { getCatalogCategories, getCatalogHome, getCatalogProduct, getCatalogProducts, getCatalogRegions } from "../src/lib/catalog";
import { attemptScheduledCatalogSync } from "../src/lib/catalog-sync-job";
import { CatalogUnavailableError } from "../src/lib/catalog-errors";
import { ensureCatalogFresh } from "../src/lib/catalog-snapshot";
import { publishCuratedCatalog } from "../src/lib/catalog-publication";
import { CATALOG_SYNC_INTERVAL_MS, SUPPORTED_COUNTRY_CODES, SERVICES_CATEGORY_LIMIT } from "../src/lib/catalog-policy";
import { canonicalBrandName, catalogGroupId } from "../src/lib/catalog-identity";
import { normalizeProduct, normalizeSupportedProducts } from "../src/lib/bitrefill-catalog";
import { eligibleDenominations, firstEligibleRangeAmount, MINIMUM_CATALOG_DENOMINATION } from "../src/lib/catalog-eligibility";
import { isCuratedProduct, rankCatalogProducts, selectFeaturedProducts } from "../src/lib/catalog-curation";
import { GLOBAL_REGION, catalogRegionParams, isPayzCatalogRegion, isPayzCountry, payzRegions } from "payz-core/supported-regions";

// Development database integration tests; never run against production.
after(async () => { await pool.end(); });

test("catalog accepts actual Bitrefill denominations at $15 USD-equivalent and above", () => {
  const product = {
    id: "minimum-test",
    currency: "USD",
    rangeMin: "10",
    rangeMax: "60",
    rangeStep: "5",
  } as unknown as ProductRecord;
  const denominations = [
    { productId: "minimum-test", currency: "USD", inStock: true, value: "10.00" },
    { productId: "minimum-test", currency: "USD", inStock: true, value: "14.99" },
    { productId: "minimum-test", currency: "USD", inStock: true, value: "15.00" },
    { productId: "minimum-test", currency: "USD", inStock: true, value: "20.00" },
    { productId: "minimum-test", currency: "USD", inStock: true, value: "25.00" },
    { productId: "minimum-test", currency: "USD", inStock: true, value: "30.00" },
    { productId: "minimum-test", currency: "USD", inStock: true, value: "34.99" },
    { productId: "minimum-test", currency: "USD", inStock: true, value: "35.00" },
    { productId: "minimum-test", currency: "USD", inStock: true, value: "50.00" },
  ] as unknown as ProductDenominationRecord[];
  assert.equal(MINIMUM_CATALOG_DENOMINATION, 15);
  assert.deepEqual(eligibleDenominations(product, denominations), [
    15, 20, 25, 30, 34.99, 35, 50,
  ]);
  assert.equal(firstEligibleRangeAmount(product), 15);
  assert.equal(firstEligibleRangeAmount({
    ...product,
    rangeMin: "20",
    rangeStep: "5",
  } as ProductRecord), 20);
  assert.equal(firstEligibleRangeAmount({
    ...product,
    rangeMin: "29",
    rangeStep: "2",
  } as ProductRecord), 29);
});

test("country whitelist includes only the requested 16 markets and rejects old UI selections", () => {
  assert.deepEqual(SUPPORTED_COUNTRY_CODES, [
    "US", "GB", "CA", "AU", "DE", "FR", "NL", "ES", "IT", "JP", "KR", "IN", "ID", "SG", "AE", "SA",
  ]);
  assert.equal(isPayzCountry("ALL"), false);
  assert.equal(isPayzCountry("JM"), false);
  assert.equal(isPayzCountry("ID"), true);
  assert.equal(isPayzCountry(GLOBAL_REGION), false);
  assert.equal(isPayzCatalogRegion(GLOBAL_REGION), true);
  assert.equal(isPayzCatalogRegion("JM"), false);
  assert.deepEqual(catalogRegionParams(GLOBAL_REGION), {});
  assert.deepEqual(catalogRegionParams("JP"), { region: "JP" });
  assert.deepEqual(payzRegions([
    { code: "JM", name: "Jamaica", currency: "JMD", currencySymbol: "$" },
    { code: "ID", name: "Wrong name", currency: "IDR", currencySymbol: "Rp" },
  ]).map((region) => region.name), ["Indonesia"]);
  assert.equal(canonicalBrandName("Amazon.co.jp"), "Amazon");
  assert.equal(canonicalBrandName("Apple UAE"), "Apple");
  assert.equal(canonicalBrandName("Booking.com"), "Booking.com");
});

test("McDonald's and KFC are recognized and prioritized as real Food & Beverage brands", () => {
  const region = { code: "US", name: "United States", currency: "USD", currencySymbol: "$" };
  const product = (brand: string) => ({
    id: brand.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-"),
    variantId: null,
    brand,
    name: `${brand} USA`,
    description: "Provider-listed gift card.",
    categoryId: "food-beverage",
    categoryName: "Food & Beverage",
    regionCode: "US",
    currency: "USD",
    currencySymbol: "$",
    startingPrice: 20,
    denominations: [20],
    denominationLabels: {},
    range: null,
    regions: [region],
    availableRegions: [region],
    currencies: ["USD"],
    available: true,
    featured: false,
    isPreview: false,
    logoKey: brand.toLowerCase(),
    brandColor: "#e9eef4",
    image: null,
  } as Parameters<typeof rankCatalogProducts>[0][number]);

  const mcdonalds = product("McDonald's");
  assert.equal(isCuratedProduct(mcdonalds), true);
  assert.equal(selectFeaturedProducts([mcdonalds], 1)[0]?.brand, "McDonald's");

  const kfc = product("KFC");
  const currentFeatured = ["Amazon", "Netflix", "Steam", "Apple", "Google Play", "PlayStation Store", "Uber", "Airbnb"]
    .map(product);
  const allFeatured = selectFeaturedProducts([...currentFeatured, kfc, mcdonalds], 10);
  assert.deepEqual(allFeatured.map((item) => item.brand), [
    "McDonald's", "KFC", "Amazon", "Netflix", "Steam", "Apple",
    "Google Play", "PlayStation Store", "Uber", "Airbnb",
  ]);

  const baseline = Array.from({ length: 8 }, (_, index) => product(`Regional Brand ${index + 1}`));
  const ranked = rankCatalogProducts([...baseline, kfc], "US", "regional");
  assert.equal(ranked[0]?.brand, "KFC");

  for (const [id, brand] of [["mcd-test", "McDonald's"], ["kfc-test", "KFC"]] as const) {
    const normalized = normalizeProduct({
      id,
      name: `${brand} USA`,
      base_name: brand,
      country_code: "US",
      country_name: "United States",
      currency: "USD",
      type: "gift_card",
      recipient_type: "none",
      in_stock: true,
      description: "Provider-listed restaurant gift card.",
      categories: ["food"],
      packages: [{ id: `${id}-25`, value: "25", currency: "USD", in_stock: true }],
    });
    assert.equal(normalized?.categoryId, "food-beverage");
    assert.equal(normalized?.productType, "gift-card");
  }
});

test("catalog reads stay database-only and category pages remain curated", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Customer catalog reads must not call upstream"); };
  try {
    const regions = await getCatalogRegions();
    assert.ok(regions.length > 0 && regions.length <= 16);
    assert.ok(regions.every((region) => SUPPORTED_COUNTRY_CODES.includes(region.code)));
    assert.equal(new Set(regions.map((region) => region.code)).size, regions.length);
    assert.deepEqual((await getCatalogCategories()).map((category) => category.name), [
      "Shopping", "Food & Beverage", "Entertainment", "Gaming", "Sports",
      "Travel", "Lifestyle", "Services & Apps",
    ]);
    for (const region of regions) {
      const home = await getCatalogHome(region.code);
      assert.ok(home.globalTop.length <= 8);
      for (const section of home.categorySections) {
        const browse = await getCatalogProducts(region.code, section.categoryId);
        if (!section.products.length) {
          assert.equal(browse.total, 0, "Empty categories must remain visible without invented products");
          continue;
        }
        assert.ok(browse.total > 0 && browse.total <= (section.categoryId === "services" ? SERVICES_CATEGORY_LIMIT : 8));
        assert.equal(new Set(browse.products.map((product) => product.brand.toLowerCase())).size, browse.products.length);
        for (const product of browse.products) {
          assert.equal(product.regionCode, region.code);
          assert.equal(product.available, true);
          assert.ok(product.availableRegions.some((country) => country.code === region.code));
          assert.ok(product.availableRegions.every((country) => SUPPORTED_COUNTRY_CODES.includes(country.code)));
          if (product.denominations.length) {
            assert.ok(product.variantId);
            const storedDenominations = await db.select({
              value: productDenominationsTable.value,
              usdValue: productDenominationsTable.usdValue,
            }).from(productDenominationsTable)
              .where(eq(productDenominationsTable.productId, product.variantId!));
            for (const amount of product.denominations) {
              assert.ok(storedDenominations.some((row) =>
                Number(row.value) === amount &&
                row.usdValue !== null &&
                Number(row.usdValue) >= 15,
              ));
            }
          }
          assert.ok(!/bitrefill/i.test(`${product.brand} ${product.name} ${product.description}`));
        }
      }
    }
    const [extra] = await db.select({
      ...getTableColumns(productsTable), countryCode: catalogCurationTable.countryCode,
    }).from(productsTable).innerJoin(catalogCurationTable, eq(productsTable.id, catalogCurationTable.productId))
      .where(and(eq(catalogCurationTable.active, true), eq(catalogCurationTable.featured, false))).limit(1);
    assert.ok(extra, "Live approved inventory should contain a non-featured search candidate");
    const search = await getCatalogProducts(extra.countryCode, extra.categoryId, extra.brand);
    assert.ok(search.products.some((product) => product.id === extra.productGroupId));
    const category = await getCatalogProducts(extra.countryCode, extra.categoryId);
    assert.ok(!category.products.some((product) => product.id === extra.productGroupId));
    assert.ok(await getCatalogProduct(extra.productGroupId, extra.countryCode));
    assert.equal((await getCatalogProducts("JM", "shopping")).total, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("global and all-category browsing include every curated brand without widening the country whitelist", async () => {
  async function allPages(region?: string, category?: string) {
    const first = await getCatalogProducts(region, category, undefined, undefined, 1, 50);
    const products = [...first.products];
    for (let page = 2; page <= first.totalPages; page++) {
      products.push(...(await getCatalogProducts(region, category, undefined, undefined, page, 50)).products);
    }
    assert.equal(products.length, first.total);
    return products;
  }
  const global = await allPages();
  assert.ok(global.length > 8, "All products must not be capped to one category's eight brands");
  assert.ok(new Set(global.map(product => product.categoryId)).size > 1);
  const brandKey = (brand: string) => brand.toLowerCase().replace(/[^a-z0-9]/g, "");
  const countryBrands = new Set<string>();
  for (const country of await getCatalogRegions()) {
    for (const product of await allPages(country.code)) {
      assert.equal(product.regionCode, country.code);
      countryBrands.add(brandKey(product.brand));
    }
  }
  assert.deepEqual(new Set(global.map(product => brandKey(product.brand))), countryBrands);
  for (const product of global) {
    assert.ok(product.available);
    assert.equal(product.regionCode, null, "Global must not silently choose a fulfillment country");
    assert.equal(product.startingPrice, null, "Country-specific prices require a country selection");
    assert.ok(product.availableRegions.length > 0);
    assert.ok(product.availableRegions.every(country => SUPPORTED_COUNTRY_CODES.includes(country.code)));
  }
  const shopping = await allPages(undefined, "shopping");
  assert.ok(shopping.every(product => product.categoryId === "shopping"));
  assert.ok(shopping.length > 8, "Global categories must include brands from all approved countries");
  const home = await getCatalogHome();
  assert.deepEqual(
    home.categorySections.map(section => section.categoryId),
    (await getCatalogCategories()).map(category => category.id),
    "All must preserve every original category section",
  );
  assert.deepEqual(
    new Set(home.categorySections.flatMap(section => section.products.map(product => brandKey(product.brand)))),
    new Set(global.map(product => brandKey(product.brand))),
    "Global All combines the original category sections, without hiding their brands",
  );
  assert.equal((await getCatalogProducts("GLOBAL")).total, 0, "Global is never a fulfillment country");
   const japanOffer = global.find(product => product.availableRegions.some(country => country.code === "JP" && country.currency === "JPY"));
  assert.ok(japanOffer);
  const japanVariant = await getCatalogProduct(japanOffer.id, "JP");
  assert.equal(japanVariant?.regionCode, "JP");
  assert.equal(japanVariant?.currency, "JPY");
});

test("international service packages retain their original fulfillment IDs within the 16-country scope", () => {
  const variants = normalizeSupportedProducts({
    id: "nordvpn-international", name: "NordVPN International", base_name: "NordVPN",
    country_code: "XI", country_name: "International", currency: "USD",
    categories: ["vpn"], recipient_type: "none", in_stock: true,
    packages: [
      { id: "nordvpn-international<&>1 Year Subscription", value: "1 Year Subscription", amount: 59.88 },
      { id: "nordvpn-international<&>1 Month Subscription", value: "1 Month Subscription", amount: 12.99 },
    ],
  });
  assert.equal(variants.length, 17, "Retain XI inventory plus the 16 approved country contexts");
  assert.deepEqual(variants.filter(p => p.regionCode !== "XI").map(p => p.regionCode), SUPPORTED_COUNTRY_CODES);
  for (const variant of variants) {
    assert.equal(variant.categoryId, "services");
    assert.equal(variant.productType, "gift-card");
    assert.equal(variant.currency, "USD");
    assert.equal(variant.providerProductId, "nordvpn-international");
    assert.equal(variant.denominations[0]?.providerPackageId, "package:nordvpn-international<&>1 Year Subscription");
    assert.equal(variant.denominations[0]?.value, "59.88");
  }
  assert.deepEqual(normalizeSupportedProducts({
    id: "unrequested-international-product", name: "Another Product",
    country_code: "XI", currency: "USD",
  }), []);
  assert.equal(normalizeProduct({
    id: "unrequested-subscription-usa", name: "Another Subscription",
    country_code: "US", currency: "USD", recipient_type: "none", in_stock: true,
    packages: [{ id: "other-plan", value: "Annual", amount: 50 }],
  })?.productType, "unsupported", "Do not change purchase eligibility for unrelated products");
});

test("Services & Apps contains verified requested brands and preserves subscription labels and old links", async () => {
  const global = await getCatalogProducts(undefined, "services", undefined, undefined, 1, 50);
  for (const brand of ["PPQ.ai", "OpenAI", "NordVPN", "Claude", "Surfshark", "Microsoft Office", "Google Workspace", "ExitLag", "My Instant AI", "Gemini", "NordLocker", "NordPass"]) {
    assert.ok(global.products.some(product => product.brand.toLowerCase().startsWith(brand.toLowerCase())), `Missing requested brand: ${brand}`);
  }
  assert.equal((await getCatalogProducts(undefined, "mobile")).total, 0);
  assert.equal((await getCatalogProducts(undefined, "tech-apps")).total, 0);
  const nord = global.products.find(product => product.brand === "NordVPN");
  assert.ok(nord);
  const offer = await getCatalogProduct(nord.id, "US");
  assert.ok(offer?.denominations.length);
  assert.ok(Object.values(offer.denominationLabels ?? {}).some(label => /Year Subscription/.test(label)));
  assert.ok(!offer.denominations.includes(12.99), "Do not expose denominations below the $30 purchase floor");
  assert.ok(await getCatalogProduct(catalogGroupId("NordVPN", "tech-apps"), "US"));
});

test("daily scheduling skips early refreshes and a failed refresh keeps serving the stale good snapshot", async () => {
  const [original] = await db.select().from(catalogSyncStateTable)
    .where(eq(catalogSyncStateTable.provider, "bitrefill"));
  assert.ok(original?.lastCompletedAt);
  const baseline = await getCatalogHome("US");
  let upstreamCalls = 0;
  try {
    await db.update(catalogSyncStateTable).set({
      nextSyncAt: new Date(Date.now() + CATALOG_SYNC_INTERVAL_MS), retryAfter: null, leaseExpiresAt: null,
    }).where(eq(catalogSyncStateTable.provider, "bitrefill"));
    await attemptScheduledCatalogSync(async () => { upstreamCalls += 1; });
    assert.equal(upstreamCalls, 0);
    const staleCompletion = new Date(Date.now() - 3 * CATALOG_SYNC_INTERVAL_MS);
    await db.update(catalogSyncStateTable).set({
      lastCompletedAt: staleCompletion, nextSyncAt: new Date(Date.now() - 1_000),
      retryAfter: null, leaseExpiresAt: null,
    }).where(eq(catalogSyncStateTable.provider, "bitrefill"));
    await attemptScheduledCatalogSync(async () => {
      upstreamCalls += 1;
      throw new CatalogUnavailableError("Simulated upstream outage");
    });
    const [failed] = await db.select().from(catalogSyncStateTable)
      .where(eq(catalogSyncStateTable.provider, "bitrefill"));
    assert.equal(upstreamCalls, 1);
    assert.equal(failed!.syncStatus, "failed");
    assert.equal(failed!.lastCompletedAt!.getTime(), staleCompletion.getTime());
    assert.ok(failed!.syncStartedAt && failed!.syncCompletedAt && failed!.syncError);
    assert.equal(failed!.nextSyncAt!.getTime() - failed!.syncStartedAt!.getTime(), CATALOG_SYNC_INTERVAL_MS);
    await ensureCatalogFresh();
    assert.deepEqual(await getCatalogHome("US"), baseline);
  } finally {
    const { provider, ...values } = original!;
    await db.update(catalogSyncStateTable).set(values).where(eq(catalogSyncStateTable.provider, provider));
  }
});

test("empty publication rolls back inventory changes and leaves the good catalog intact", async () => {
  const baseline = await getCatalogHome("US");
  await assert.rejects(db.transaction(async (tx) => {
    await tx.update(productsTable).set({ inStock: false }).where(eq(productsTable.provider, "bitrefill"));
    await publishCuratedCatalog(tx, new Date());
  }), /no approved purchasable products/);
  assert.deepEqual(await getCatalogHome("US"), baseline);
  const [invalid] = await db.select({ count: sql<number>`count(*)::int` }).from(catalogCurationTable)
    .innerJoin(productsTable, eq(productsTable.id, catalogCurationTable.productId))
    .where(and(eq(catalogCurationTable.active, true), sql`${productsTable.productType} <> 'gift-card'`));
  assert.equal(invalid!.count, 0);
});
