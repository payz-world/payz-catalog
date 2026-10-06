import { eq, inArray } from "drizzle-orm";
import { db, productsTable, productDenominationsTable, regionsTable } from "payz-core/db";
import { getBaseUrl, getPersonalAuthHeader, normalizeSupportedProducts } from "./bitrefill-catalog";
import { SERVICE_PROVIDER_PRODUCTS } from "./service-provider-products";
import { waitForBitrefillCatalogSlot } from "./provider-rate-limit";
import { CatalogUnavailableError } from "./catalog-errors";

// One-time background upgrade. No invoice/order/payment requests are made.
export async function fetchServiceOffers() {
  const authorization = getPersonalAuthHeader();
  if (!authorization) throw new CatalogUnavailableError("The fulfillment provider is not configured.");
  const offers: ReturnType<typeof normalizeSupportedProducts> = [];
  for (const id of SERVICE_PROVIDER_PRODUCTS) {
    await waitForBitrefillCatalogSlot();
    const response = await fetch(new URL(`products/${encodeURIComponent(id)}`, getBaseUrl()), {
      headers: { authorization, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new CatalogUnavailableError("A requested service could not be verified.");
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !("data" in payload) ||
        !payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
      throw new CatalogUnavailableError("A requested service returned invalid metadata.");
    }
    const raw = payload.data as Record<string, unknown>;
    const [stored] = await db.select({ description: productsTable.description }).from(productsTable)
      .where(eq(productsTable.providerProductId, id)).limit(1);
    const normalized = normalizeSupportedProducts({
      ...raw, description: raw.description || stored?.description || undefined,
    });
    if (!normalized.length) throw new CatalogUnavailableError("A requested service returned invalid metadata.");
    offers.push(...normalized);
  }
  return offers;
}

type CatalogTx = Pick<typeof db, "insert" | "update">;
export async function upsertServiceOffers(
  tx: CatalogTx, offers: Awaited<ReturnType<typeof fetchServiceOffers>>, now: Date,
) {
  if (!offers.length) throw new CatalogUnavailableError("No service offers were verified.");
  await tx.update(productDenominationsTable).set({ inStock: false, syncedAt: now })
    .where(inArray(productDenominationsTable.productId, offers.map(offer => offer.id)));
  for (const offer of offers) {
    // Never replace a real country's currency with an international USD offer.
    await tx.insert(regionsTable).values({
      code: offer.regionCode, name: offer.regionName, currency: offer.currency,
      currencySymbol: offer.currency, enabled: false,
    }).onConflictDoNothing();
    const row = {
      id: offer.id, provider: "bitrefill", providerProductId: offer.providerProductId,
      regionCode: offer.regionCode, brand: offer.brand, name: offer.name,
      description: offer.description, sourceCategory: offer.sourceCategory,
      categoryId: offer.categoryId, currency: offer.currency,
      productType: offer.productType, providerType: offer.providerType,
      productGroupId: offer.productGroupId, imageUrl: offer.imageUrl,
      inStock: offer.inStock, presentInLatestSync: true, featured: offer.featured,
      rangeMin: offer.range?.min ?? null, rangeMax: offer.range?.max ?? null,
      rangeStep: offer.range?.step ?? null, syncedAt: now, updatedAt: now,
    };
    await tx.insert(productsTable).values(row).onConflictDoUpdate({ target: productsTable.id, set: row });
    for (const denomination of offer.denominations) {
      const packageRow = { ...denomination, productId: offer.id, syncedAt: now };
      await tx.insert(productDenominationsTable).values(packageRow)
        .onConflictDoUpdate({ target: productDenominationsTable.id, set: packageRow });
    }
  }
}
