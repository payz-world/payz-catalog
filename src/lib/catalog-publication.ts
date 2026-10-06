import { and, eq, inArray, sql } from "drizzle-orm";
import type { Product, Region } from "payz-core/types";
import {
  db, catalogCurationTable, productsTable, productDenominationsTable, regionsTable,
  type InsertCatalogCuration,
} from "payz-core/db";
import { isCuratedProduct, rankCatalogProducts, takeUniqueBrands } from "./catalog-curation";
import { eligibleDenominations, firstEligibleRangeAmount, isAvailableVariant, productRange } from "./catalog-eligibility";
import { CATEGORY_TAXONOMY, CURATED_CATEGORY_LIMIT, SERVICES_CATEGORY_LIMIT, SUPPORTED_COUNTRIES, SUPPORTED_COUNTRY_CODES } from "./catalog-policy";
import { canonicalBrandName, catalogGroupId } from "./catalog-identity";

type CatalogDb = Pick<typeof db, "select" | "insert" | "update">;

// Called only by background publication (or local migration), never a customer request.
// The caller owns the transaction: an empty or failed publication cannot replace a snapshot.
export async function publishCuratedCatalog(tx: CatalogDb, completedAt: Date): Promise<number> {
  const inventory = await tx.select().from(productsTable).where(and(
    eq(productsTable.provider, "bitrefill"),
    eq(productsTable.productType, "gift-card"),
    eq(productsTable.presentInLatestSync, true),
    inArray(productsTable.regionCode, SUPPORTED_COUNTRY_CODES),
  ));
  // Local upgrades and daily imports share the same identity rules. Raw provider
  // IDs never change, so historical orders retain their references.
  for (const row of inventory) {
    const brand = canonicalBrandName(row.brand);
    const categoryId = row.categoryId === "tech-apps" ? "services" : row.categoryId;
    const productGroupId = catalogGroupId(brand, categoryId);
    if (brand !== row.brand || productGroupId !== row.productGroupId || categoryId !== row.categoryId) {
      await tx.update(productsTable).set({ brand, productGroupId, categoryId })
        .where(eq(productsTable.id, row.id));
      row.brand = brand;
      row.productGroupId = productGroupId;
      row.categoryId = categoryId;
    }
  }
  const packages = inventory.length
    ? await tx.select().from(productDenominationsTable)
        .where(inArray(productDenominationsTable.productId, inventory.map((row) => row.id)))
    : [];
  const packagesByProduct = new Map<string, typeof packages>();
  for (const row of packages) {
    const values = packagesByProduct.get(row.productId) ?? [];
    values.push(row);
    packagesByProduct.set(row.productId, values);
  }
  const eligible = inventory.filter((row) =>
    row.productGroupId && row.brand.trim() && row.name.trim() && row.description.trim() &&
    CATEGORY_TAXONOMY.some((category) => category.id === row.categoryId) &&
    isAvailableVariant(row, packagesByProduct.get(row.id) ?? []),
  );
  const regionRows = await tx.select().from(regionsTable);
  const regionsByCode = new Map(regionRows.map((row) => [row.code, row]));
  const coverage = new Map<string, Region[]>();
  for (const row of eligible) {
    const regions = coverage.get(row.productGroupId) ?? [];
    if (!regions.some((region) => region.code === row.regionCode)) {
      const country = regionsByCode.get(row.regionCode);
      regions.push({
        code: row.regionCode, name: SUPPORTED_COUNTRIES[row.regionCode]!,
        currency: row.currency, currencySymbol: country?.currencySymbol ?? row.currency,
      });
    }
    coverage.set(row.productGroupId, regions);
  }
  const candidates: Product[] = eligible.map((row) => {
    const denominations = eligibleDenominations(row, packagesByProduct.get(row.id) ?? []);
    const regions = coverage.get(row.productGroupId)!;
    return {
      id: row.id, variantId: row.id, brand: row.brand, name: row.name, description: row.description,
      categoryId: row.categoryId, categoryName: row.categoryId,
      regionCode: row.regionCode, currency: row.currency, currencySymbol: row.currency,
      startingPrice: denominations[0] ?? firstEligibleRangeAmount(row),
      denominations, range: productRange(row), regions, availableRegions: regions,
      currencies: [...new Set(regions.map((region) => region.currency))],
      available: true, featured: row.featured, isPreview: false,
      logoKey: row.brand.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-"),
      brandColor: "#e9eef4", image: row.imageUrl,
    };
  }).filter(isCuratedProduct);

  const approvals: InsertCatalogCuration[] = [];
  for (const countryCode of SUPPORTED_COUNTRY_CODES) {
    for (const category of CATEGORY_TAXONOMY) {
      const ranked = takeUniqueBrands(rankCatalogProducts(
        candidates.filter((product) => product.regionCode === countryCode && product.categoryId === category.id),
        countryCode, "regional",
      ), Infinity);
      ranked.forEach((product, index) => approvals.push({
        productId: product.id, countryCode, categoryId: category.id, rank: index + 1,
        featured: index < (category.id === "services" ? SERVICES_CATEGORY_LIMIT : CURATED_CATEGORY_LIMIT), active: true,
        lastSyncedAt: completedAt, updatedAt: completedAt,
      }));
    }
  }
  if (!approvals.length) throw new Error("Catalog publication contained no approved purchasable products.");

  await tx.update(catalogCurationTable).set({ active: false, featured: false, updatedAt: completedAt });
  for (let offset = 0; offset < approvals.length; offset += 200) {
    await tx.insert(catalogCurationTable).values(approvals.slice(offset, offset + 200)).onConflictDoUpdate({
      target: catalogCurationTable.productId,
      set: {
        countryCode: sql`excluded.country_code`, categoryId: sql`excluded.category_id`,
        rank: sql`excluded.rank`, featured: sql`excluded.featured`, active: true,
        lastSyncedAt: completedAt, updatedAt: completedAt,
      },
    });
  }
  await tx.update(regionsTable).set({ enabled: false, updatedAt: completedAt });
  for (const countryCode of new Set(approvals.map((row) => row.countryCode))) {
    await tx.update(regionsTable).set({
      enabled: true, name: SUPPORTED_COUNTRIES[countryCode]!, updatedAt: completedAt,
    }).where(eq(regionsTable.code, countryCode));
  }
  return approvals.length;
}
