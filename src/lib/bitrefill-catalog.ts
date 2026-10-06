import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  catalogSyncStateTable,
  db,
  productDenominationsTable,
  productsTable,
  regionsTable,
} from "payz-core/db";
import { logger } from "./logger";
import { waitForBitrefillCatalogSlot } from "./provider-rate-limit";
import { CatalogUnavailableError } from "./catalog-errors";
import { canonicalBrandName, catalogGroupId } from "./catalog-identity";
import { publishCuratedCatalog } from "./catalog-publication";
import { CURATED_CATALOG_VERSION, SUPPORTED_COUNTRIES } from "./catalog-policy";
import { SERVICE_PROVIDER_PRODUCTS } from "./service-provider-products";
import {
  firstEligibleRangeAmountForRate,
  isEligibleCatalogUsdValue,
} from "./catalog-eligibility";
import { getUsdRate } from "./currency-conversion";
export { CatalogSyncInProgressError, CatalogUnavailableError } from "./catalog-errors";

const PROVIDER = "bitrefill";
const CATALOG_VERSION = CURATED_CATALOG_VERSION;
const PAGE_SIZE = 50;
const MAX_PAGES_PER_SYNC = 500;
const FAILURE_RETRY_COOLDOWN_MS = 15 * 60 * 1000;

type JsonObject = Record<string, unknown>;
type NormalizedPackage = {
  id: string;
  providerPackageId: string;
  value: string;
  currency: string;
  usdValue: string | null;
  inStock: boolean;
};
type NormalizedRange = { min: string; max: string; step: string } | null;
type NormalizedProduct = {
  id: string;
  providerProductId: string;
  productGroupId: string;
  brand: string;
  name: string;
  description: string;
  sourceCategory: string;
  categoryId: string;
  currency: string;
  usdRate: string | null;
  providerType: string;
  productType: string;
  providerMetadata: JsonObject;
  regionCode: string;
  regionName: string;
  imageUrl: string | null;
  inStock: boolean;
  range: NormalizedRange;
  featured: boolean;
  denominations: NormalizedPackage[];
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result.length ? result : null;
}

function providerId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return nonEmptyString(value);
}

function positiveNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function providerCategories(raw: JsonObject): string[] {
  const values: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) values.push(value.trim().toLowerCase());
    else if (isObject(value)) {
      const name = nonEmptyString(value.name) ?? nonEmptyString(value.id);
      if (name) values.push(name.toLowerCase());
    }
  };
  add(raw.category);
  if (Array.isArray(raw.categories)) raw.categories.forEach(add);
  if (Array.isArray(raw.tags)) raw.tags.forEach(add);
  return [...new Set(values)];
}

function providerType(raw: JsonObject): string {
  return (nonEmptyString(raw.type) ?? "").toLowerCase().replaceAll(/[^a-z0-9]+/g, "_");
}

function hasNumericPackage(raw: JsonObject): boolean {
  const packages = Array.isArray(raw.packages)
    ? raw.packages
    : isObject(raw.packages)
      ? [raw.packages]
      : [];
  return packages.some(
    (item) =>
      isObject(item) &&
      packageValue(item, (SERVICE_PROVIDER_PRODUCTS as readonly string[]).includes(providerId(raw.id) ?? "")) !== null,
  );
}
function hasNumericRange(raw: JsonObject): boolean {
  if (!isObject(raw.range)) return false;
  const min = nonNegativeNumber(raw.range.min);
  const max = positiveNumber(raw.range.max);
  const step = positiveNumber(raw.range.step);
  return min !== null && max !== null && step !== null && max >= min;
}

function isFulfillableGiftCard(raw: JsonObject): boolean {
  const type = providerType(raw);
  const categories = providerCategories(raw).map((category) => category.toLowerCase());
  const identity = [
    nonEmptyString(raw.name),
    nonEmptyString(raw.base_name),
    nonEmptyString(raw.brand),
  ].filter(Boolean).join(" ");
  const metadata = `${identity} ${categories.join(" ")}`;
  if (/\bbitrefill\b/i.test(identity)) return false;
  if (/\b(esim|e-sim|top.?up|refill|airtime|bill.?payment|utility|mobile data|data bundle)\b/i.test(metadata)) {
    return false;
  }
  if (categories.some((category) => ["pin", "bill", "data"].includes(category.trim()))) return false;
  if (type) return type === "gift_card" || type === "giftcard";

  const recipientType = nonEmptyString(raw.recipient_type)?.toLowerCase();
  return recipientType === "none" && (hasNumericPackage(raw) || hasNumericRange(raw));
}

function sourceCategoryFor(raw: JsonObject): string {
  return providerCategories(raw).join(", ").slice(0, 500);
}

function payzCategoryFor(raw: JsonObject, brand: string): string {
  const providerMeta = providerCategories(raw).join(" ").toLowerCase();
  const identity = `${brand} ${nonEmptyString(raw.name) ?? ""}`.toLowerCase();
  const hasIdentity = (pattern: RegExp) => pattern.test(identity);
  const hasMeta = (pattern: RegExp) => pattern.test(providerMeta);
  const type = providerType(raw);

  // Brand and product names are more reliable than free-form descriptions,
  // which can list unrelated redemption examples.
  if (type === "phone_refill" || type === "esim" || type === "mobile_topup") return "mobile";
  if (hasIdentity(/\b(uber eats|ubereats|doordash|deliveroo|foodpanda|restaurant|beverage|coffee|cafe|café|grocery|groceries|pizza|dining|starbucks|mcdonald'?s|kfc)\b/)) {
    return "food-beverage";
  }
  if (hasIdentity(/\b(sport|sports|football|soccer|basketball|tennis|racing|sportsbook|stadium)\b/)) {
    return "sports";
  }
  if (hasIdentity(/\b(game|games|gaming|steam|playstation|xbox|nintendo|google play|epic games|game credit|console|roblox)\b/)) {
    return "gaming";
  }
  if (hasIdentity(/\b(airbnb|uber|bolt|travel|hotel|hotels|flight|flights|transport|transit|mobility|rideshare|booking|airline|trainline)\b/)) {
    return "travel";
  }
  if (hasIdentity(/\b(netflix|disney\+?|disney plus|spotify|hulu|youtube|streaming|music|movie|movies|cinema|entertainment|media|theatre|theater|literature)\b/)) {
    return "entertainment";
  }
  if (hasIdentity(/\b(mobile|phone|telecom|carrier|prepaid|esim|e-sim|sim card)\b/)) {
    return "mobile";
  }
  if (hasIdentity(/\b(claude|gemini|chatgpt|openai|nordvpn|microsoft 365|adobe|canva|notion|1password|dropbox|software|saas|vpn|cloud|developer tool|productivity|app subscription|digital service)\b/)) {
    return "services";
  }
  if (hasIdentity(/\b(amazon|walmart|target|best buy|apple|nike|adidas|puma|shopping|retail|marketplace|ecommerce|department store|electronics|fashion retailer|flowers|pet supplies|petsmart|chewy)\b/)) {
    return "shopping";
  }
  if (hasIdentity(/\b(lifestyle|wellness|beauty|cosmetics|fitness|fashion|personal care|health|pharmacy|spa|jewelry|jewellery|perfume|skincare)\b/)) {
    return "lifestyle";
  }

  // Prefer structured provider categories over incidental description text.
  if (hasMeta(/\b(food|restaurants?|beverage|groceries|food-delivery)\b/)) return "food-beverage";
  if (hasMeta(/\b(sports-n-outdoors|sports?)\b/)) return "sports";
  if (hasMeta(/\b(games?|game-stores|in-game-currencies)\b/)) return "gaming";
  if (hasMeta(/\b(travel|transportation)\b/)) return "travel";
  if (hasMeta(/\b(entertainment|streaming|literature|dth)\b/)) return "entertainment";
  if (hasMeta(/\b(health-beauty|apparel)\b/)) return "lifestyle";
  if (hasMeta(/\b(vpn|software|saas|digital-service)\b/)) return "services";
  if (hasMeta(/\b(home|home-n-diy|department-stores|online-marketplaces|multi-brand|gifts|kids|pets|electronics|retail|ecommerce)\b/)) {
    return "shopping";
  }
  if (hasMeta(/\b(mobile|telecom|airtime|digital-wallet|payment-cards|gasoline|bitcoin)\b/)) {
    return "services";
  }
  return "services";
}

function stableProductId(region: string, providerProductId: string): string {
  const digest = createHash("sha256")
    .update(`${PROVIDER}\0${region}\0${providerProductId}`)
    .digest("hex")
    .slice(0, 32);
  return `pz_${digest}`;
}

function stableProductGroupId(brand: string, categoryId: string): string {
  return catalogGroupId(brand, categoryId);
}

function imageUrlFor(raw: JsonObject): string | null {
  for (const candidate of [raw.image, raw.image_url, raw.logo, raw.logo_url]) {
    const value = typeof candidate === "string"
      ? candidate
      : isObject(candidate)
        ? nonEmptyString(candidate.url) ?? nonEmptyString(candidate.src)
        : null;
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === "https:") return parsed.toString();
    } catch {
      continue;
    }
  }
  return null;
}

function normalizePackage(
  raw: unknown,
  productId: string,
  productCurrency: string,
  productInStock: boolean,
  allowNamedServicePackage = false,
): NormalizedPackage | null {
  if (!isObject(raw)) return null;
  const packageId = providerId(raw.package_id) ?? providerId(raw.id);
  const value = packageValue(raw, allowNamedServicePackage);
  const currency = (nonEmptyString(raw.currency) ?? productCurrency).toUpperCase();
  if (!packageId || value === null || !/^[A-Z]{3}$/.test(currency)) return null;
  const providerPackageId = `package:${packageId}`;
  return {
    id: createHash("sha256").update(`${productId}\0${providerPackageId}`).digest("hex").slice(0, 32),
    providerPackageId,
    value: value.toFixed(2),
    currency,
    usdValue: currency === "USD" ? value.toFixed(2) : null,
    inStock: typeof raw.in_stock === "boolean" ? raw.in_stock : productInStock,
  };
}

function packageValue(raw: JsonObject, allowNamedServicePackage: boolean): number | null {
  const legacyValue = positiveNumber(raw.value ?? raw.amount ?? raw.denomination ?? raw.face_value);
  return legacyValue ?? (allowNamedServicePackage ? positiveNumber(raw.amount) : null);
}

function normalizeRange(raw: unknown): NormalizedRange {
  if (!isObject(raw)) return null;
  const min = nonNegativeNumber(raw.min);
  const max = positiveNumber(raw.max);
  const step = positiveNumber(raw.step);
  if (min === null || max === null || step === null || max < min) return null;
  return { min: min.toFixed(2), max: max.toFixed(2), step: step.toFixed(2) };
}

export function normalizeProduct(value: unknown): NormalizedProduct | null {
  if (!isObject(value)) return null;
  const providerProductId = providerId(value.id);
  const name = nonEmptyString(value.name);
  const regionCode = (
    nonEmptyString(value.country_code) ?? nonEmptyString(value.country)
  )?.toUpperCase();
  const regionName =
    nonEmptyString(value.country_name) ??
    nonEmptyString(value.countryName) ??
    regionCode;
  const currency = nonEmptyString(value.currency)?.toUpperCase();
  if (
    !providerProductId ||
    !name ||
    !regionCode ||
    !/^[A-Z]{2}$/.test(regionCode) ||
    !regionName ||
    !currency ||
    !/^[A-Z]{3}$/.test(currency)
  ) {
    return null;
  }

  const id = stableProductId(regionCode, providerProductId);
  const packageValues = Array.isArray(value.packages)
    ? value.packages
    : isObject(value.packages)
      ? [value.packages]
      : [];
  const inStock = value.in_stock === true;
  const denominations = packageValues
    .map((item) => normalizePackage(item, id, currency, inStock,
      (SERVICE_PROVIDER_PRODUCTS as readonly string[]).includes(providerProductId)))
    .filter((item): item is NormalizedPackage => item !== null);
  const brand = canonicalBrandName(
    nonEmptyString(value.base_name) ??
    nonEmptyString(value.brand) ??
    name);
  const categoryId = payzCategoryFor(value, brand);
  return {
    id,
    providerProductId,
    productGroupId: stableProductGroupId(brand, categoryId),
    brand,
    name,
    description: nonEmptyString(value.description) ?? "",
    sourceCategory: sourceCategoryFor(value),
    categoryId,
    currency,
    usdRate: currency === "USD" ? "1.0000000000" : null,
    providerType: providerType(value),
    productType: isFulfillableGiftCard(value) ? "gift-card" : "unsupported",
    providerMetadata: value,
    regionCode,
    regionName,
    imageUrl: imageUrlFor(value),
    inStock,
    range: normalizeRange(value.range),
    featured: value.featured === true,
    denominations,
  };
}

export function normalizeSupportedProducts(value: unknown): NormalizedProduct[] {
  const product = normalizeProduct(value);
  if (!product) return [];
  if (SUPPORTED_COUNTRIES[product.regionCode]) return [product];
  if (product.regionCode !== "XI" ||
      !(SERVICE_PROVIDER_PRODUCTS as readonly string[]).includes(product.providerProductId) ||
      !isObject(value)) return [];
  return [product, ...Object.entries(SUPPORTED_COUNTRIES).flatMap(([country, name]) => {
    const variant = normalizeProduct({ ...value, country_code: country, country_name: name });
    return variant ? [variant] : [];
  })];
}

export function getPersonalAuthHeader(): string | null {
  const apiKey =
    process.env.PAYZ_PROVIDER_ACCESS_TOKEN?.trim() ||
    process.env.BITREFILL_PERSONAL_API?.trim();
  return apiKey ? `Bearer ${apiKey}` : null;
}

export function getBaseUrl(): URL {
  const configured = process.env.PAYZ_FULFILLMENT_API_BASE_URL?.trim();
  const baseUrl = new URL(configured || "https://api-bitrefill.com/v2");
  if (baseUrl.protocol !== "https:") throw new CatalogUnavailableError();
  return new URL(`${baseUrl.toString().replace(/\/+$/, "")}/`);
}

function retryDelayFromResponse(response: Response): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date) && date > Date.now()) return date - Date.now();
  }
  for (const header of ["ratelimit-reset", "x-ratelimit-reset"]) {
    const reset = Number(response.headers.get(header));
    if (Number.isFinite(reset) && reset > 0) {
      const resetAt = reset > 1_000_000_000 ? reset * 1000 : Date.now() + reset * 1000;
      if (resetAt > Date.now()) return resetAt - Date.now();
    }
  }
  return FAILURE_RETRY_COOLDOWN_MS;
}

function nextPageStart(meta: JsonObject | null, pageUrl: URL, start: number, count: number): number | null {
  const next = meta?._next ?? meta?.next;
  if (next === null || meta?.has_more === false) return null;
  if (typeof next === "string" && next.trim()) {
    let nextUrl: URL;
    try {
      nextUrl = new URL(next, pageUrl);
    } catch {
      throw new CatalogUnavailableError("Bitrefill returned invalid pagination metadata.");
    }
    if (nextUrl.origin !== pageUrl.origin || nextUrl.pathname !== pageUrl.pathname) {
      throw new CatalogUnavailableError("Bitrefill returned unsafe pagination metadata.");
    }
    const nextStart = Number(nextUrl.searchParams.get("start"));
    if (Number.isSafeInteger(nextStart) && nextStart > start) return nextStart;
    throw new CatalogUnavailableError("Bitrefill returned a non-advancing page link.");
  }
  const limit = positiveNumber(meta?.limit) ?? PAGE_SIZE;
  if (count < limit) return null;
  const pageStart = nonNegativeNumber(meta?.start) ?? start;
  const nextStart = pageStart + limit;
  if (nextStart <= start) throw new CatalogUnavailableError("Bitrefill pagination did not advance.");
  return nextStart;
}

async function fetchCatalogPage(
  pageUrl: URL,
  authorization: string,
  page: number,
  start: number,
): Promise<Response> {
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      await waitForBitrefillCatalogSlot();
      const response = await fetch(pageUrl, {
        headers: { accept: "application/json", authorization },
        signal: AbortSignal.timeout(12_000),
      });
      if (response.ok) return response;

      const transientServerError = response.status >= 500 && response.status <= 599;
      if (transientServerError && attempt < maxRetries) {
        logger.warn(
          { page, start, status: response.status, attempt: attempt + 1 },
          "Bitrefill returned a transient catalog error; retrying",
        );
        await response.body?.cancel();
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(8_000, 1_000 * 2 ** attempt)),
        );
        continue;
      }

      const retryAfterMs =
        response.status === 429 || transientServerError
          ? retryDelayFromResponse(response)
          : undefined;
      logger.warn(
        {
          page,
          start,
          status: response.status,
          ...(retryAfterMs ? { retryAfterMs } : {}),
        },
        "Bitrefill Personal API catalog request was rejected",
      );
      throw new CatalogUnavailableError(undefined, retryAfterMs);
    } catch (error) {
      if (error instanceof CatalogUnavailableError) throw error;
      if (attempt < maxRetries) {
        logger.warn(
          { page, start, attempt: attempt + 1 },
          "Bitrefill catalog request failed; retrying",
        );
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(8_000, 1_000 * 2 ** attempt)),
        );
        continue;
      }
      logger.warn({ page, start }, "Bitrefill Personal API catalog request failed");
      throw new CatalogUnavailableError();
    }
  }
  throw new CatalogUnavailableError();
}

async function getProductsFromProvider(): Promise<NormalizedProduct[]> {
  const authorization = getPersonalAuthHeader();
  if (!authorization) {
    throw new CatalogUnavailableError("The fulfillment provider is not configured.");
  }
  const baseUrl = getBaseUrl();
  const productsById = new Map<string, NormalizedProduct>();
  let start = 0;
  for (let page = 0; page < MAX_PAGES_PER_SYNC; page += 1) {
    const pageUrl = new URL("products", baseUrl);
    pageUrl.searchParams.set("limit", String(PAGE_SIZE));
    pageUrl.searchParams.set("start", String(start));
    const response = await fetchCatalogPage(pageUrl, authorization, page, start);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      logger.warn({ page, start }, "Bitrefill Personal API returned invalid JSON");
      throw new CatalogUnavailableError();
    }
    if (!isObject(payload) || !Array.isArray(payload.data)) {
      logger.warn({ page, start }, "Bitrefill Personal API response shape was invalid");
      throw new CatalogUnavailableError();
    }
    const meta = isObject(payload.meta) ? payload.meta : null;
    if (page === 0) {
      logger.info(
        {
          itemCount: payload.data.length,
          normalizedProducts: payload.data.filter((item) => normalizeProduct(item) !== null).length,
          hasNextPage: Boolean(meta?._next ?? meta?.next),
        },
        "Bitrefill full catalog page received",
      );
    }
    for (const item of payload.data) {
      for (const product of normalizeSupportedProducts(item)) productsById.set(product.id, product);
    }
    if (page > 0 && page % 25 === 0) {
      logger.info(
        { pagesRead: page + 1, productCount: productsById.size, start },
        "Bitrefill global catalog sync is progressing",
      );
    }
    const nextStart = nextPageStart(meta, pageUrl, start, payload.data.length);
    if (nextStart === null) {
      const products = [...productsById.values()];
      if (!products.length) {
        throw new CatalogUnavailableError("Bitrefill returned no supported products.");
      }
      return products;
    }
    start = nextStart;
  }
  throw new CatalogUnavailableError(
    `The Bitrefill catalog exceeded the ${PAGE_SIZE * MAX_PAGES_PER_SYNC}-product sync safety limit.`,
  );
}

async function addUsdPricing(products: NormalizedProduct[]): Promise<NormalizedProduct[]> {
  const currencies = new Set(products.flatMap((product) => [
    product.currency,
    ...product.denominations.map((denomination) => denomination.currency),
  ]));
  const rates = new Map<string, number>();

  for (const currency of currencies) {
    try {
      rates.set(currency, (await getUsdRate(currency)).rate);
    } catch {
      const [storedRate] = await db
        .select({ usdRate: productsTable.usdRate })
        .from(productsTable)
        .where(and(
          eq(productsTable.provider, PROVIDER),
          eq(productsTable.currency, currency),
        ))
        .limit(1);
      const fallback = Number(storedRate?.usdRate);
      if (Number.isFinite(fallback) && fallback > 0) rates.set(currency, fallback);
      else logger.warn({ currency }, "No USD conversion rate available; catalog offers in this currency remain hidden");
    }
  }

  return products.map((product) => {
    const productRate = rates.get(product.currency);
    return {
      ...product,
      usdRate: productRate?.toFixed(10) ?? null,
      denominations: product.denominations.map((denomination) => {
        const rate = rates.get(denomination.currency);
        if (rate === undefined) return { ...denomination, usdValue: null };
        const cents = Math.floor((Number(denomination.value) * rate + 1e-9) * 100);
        return {
          ...denomination,
          usdValue: cents > 0 ? (cents / 100).toFixed(2) : "0.00",
        };
      }),
    };
  });
}

export async function refreshStoredUsdPricing(): Promise<void> {
  const productCurrencies = await db
    .select({ currency: productsTable.currency })
    .from(productsTable)
    .where(eq(productsTable.provider, PROVIDER));
  const denominationCurrencies = await db
    .select({ currency: productDenominationsTable.currency })
    .from(productDenominationsTable)
    .where(inArray(
      productDenominationsTable.productId,
      db.select({ id: productsTable.id }).from(productsTable)
        .where(eq(productsTable.provider, PROVIDER)),
    ));
  const currencies = new Set([
    ...productCurrencies.map((row) => row.currency),
    ...denominationCurrencies.map((row) => row.currency),
  ]);
  await Promise.all([...currencies].map(async (currency) => {
    let rate: number;
    try {
      rate = (await getUsdRate(currency)).rate;
    } catch {
      return;
    }
    try {
      await db.transaction(async (tx) => {
        await tx.update(productsTable)
          .set({ usdRate: rate.toFixed(10) })
          .where(and(eq(productsTable.provider, PROVIDER), eq(productsTable.currency, currency)));
        await tx.update(productDenominationsTable)
          .set({
            usdValue: sql`floor(${productDenominationsTable.value} * ${rate} * 100) / 100`,
          })
          .where(and(
            eq(productDenominationsTable.currency, currency),
            inArray(
              productDenominationsTable.productId,
              tx.select({ id: productsTable.id }).from(productsTable)
                .where(eq(productsTable.provider, PROVIDER)),
            ),
          ));
      });
    } catch {
      logger.warn({ currency }, "Stored catalog USD pricing could not be refreshed");
    }
  }));
}

function currencySymbolFor(currency: string): string {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).formatToParts(0).find((part) => part.type === "currency")?.value ?? currency;
  } catch {
    return currency;
  }
}

function hasEligibleAmount(product: NormalizedProduct): boolean {
  if (!product.inStock) return false;
  if (product.denominations.some((item) =>
    item.inStock && item.usdValue !== null &&
    isEligibleCatalogUsdValue(item.usdValue),
  )) return true;
  if (!product.range) return false;
  const usdRate = product.usdRate === null ? NaN : Number(product.usdRate);
  return firstEligibleRangeAmountForRate(
    Number(product.range.min),
    Number(product.range.max),
    Number(product.range.step),
    usdRate,
  ) !== null;
}

function getRegionSummaries(products: NormalizedProduct[]) {
  const byRegion = new Map<string, {
    name: string;
    currencies: Map<string, number>;
    enabled: boolean;
  }>();
  for (const product of products) {
    const purchasable = product.productType === "gift-card" && hasEligibleAmount(product);
    const summary = byRegion.get(product.regionCode) ?? {
      name: product.regionName,
      currencies: new Map<string, number>(),
      enabled: false,
    };
    if (purchasable) {
      summary.currencies.set(
        product.currency,
        (summary.currencies.get(product.currency) ?? 0) + 1,
      );
      summary.enabled = true;
    }
    byRegion.set(product.regionCode, summary);
  }
  return [...byRegion].map(([code, summary]) => {
    const currency = [...summary.currencies].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";
    return {
      code,
      name: summary.name,
      currency,
      currencySymbol: currencySymbolFor(currency),
      enabled: summary.enabled,
    };
  });
}

export async function performSync(): Promise<void> {
  const products = await addUsdPricing(await getProductsFromProvider());
  const now = new Date();
  const regions = getRegionSummaries(products);
  await db.transaction(async (tx) => {
    await tx.update(regionsTable).set({ enabled: false, updatedAt: now });
    await tx
      .update(productsTable)
      .set({
        inStock: false,
        presentInLatestSync: false,
        syncedAt: now,
        updatedAt: now,
      })
      .where(eq(productsTable.provider, PROVIDER));
    await tx
      .update(productDenominationsTable)
      .set({ inStock: false, syncedAt: now })
      .where(
        inArray(
          productDenominationsTable.productId,
          tx
            .select({ id: productsTable.id })
            .from(productsTable)
            .where(eq(productsTable.provider, PROVIDER)),
        ),
      );

    for (const region of regions) {
      await tx
        .insert(regionsTable)
        .values(region)
        .onConflictDoUpdate({
          target: regionsTable.code,
          set: {
            name: region.name,
            currency: region.currency,
            currencySymbol: region.currencySymbol,
            enabled: region.enabled,
            updatedAt: now,
          },
        });
    }

    for (const product of products) {
      await tx
        .insert(productsTable)
        .values({
          id: product.id,
          provider: PROVIDER,
          providerProductId: product.providerProductId,
          regionCode: product.regionCode,
          brand: product.brand,
          name: product.name,
          description: product.description,
          sourceCategory: product.sourceCategory,
          categoryId: product.categoryId,
          currency: product.currency,
          providerType: product.providerType,
          productType: product.productType,
          productGroupId: product.productGroupId,
          providerMetadata: product.providerMetadata,
          imageUrl: product.imageUrl,
          inStock: product.inStock,
          presentInLatestSync: true,
          featured: product.featured,
          usdRate: product.usdRate,
          rangeMin: product.range?.min ?? null,
          rangeMax: product.range?.max ?? null,
          rangeStep: product.range?.step ?? null,
          syncedAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            productsTable.provider,
            productsTable.providerProductId,
            productsTable.regionCode,
          ],
          set: {
            brand: product.brand,
            name: product.name,
            description: product.description,
            sourceCategory: product.sourceCategory,
            categoryId: product.categoryId,
            currency: product.currency,
            providerType: product.providerType,
            productType: product.productType,
            productGroupId: product.productGroupId,
            providerMetadata: product.providerMetadata,
            imageUrl: product.imageUrl,
            inStock: product.inStock,
            presentInLatestSync: true,
            featured: product.featured,
            usdRate: product.usdRate,
            rangeMin: product.range?.min ?? null,
            rangeMax: product.range?.max ?? null,
            rangeStep: product.range?.step ?? null,
            syncedAt: now,
            updatedAt: now,
          },
        });

      for (const denomination of product.denominations) {
        await tx
          .insert(productDenominationsTable)
          .values({
            id: denomination.id,
            productId: product.id,
            providerPackageId: denomination.providerPackageId,
            value: denomination.value,
            currency: denomination.currency,
            usdValue: denomination.usdValue,
            inStock: denomination.inStock,
            syncedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              productDenominationsTable.productId,
              productDenominationsTable.providerPackageId,
            ],
            set: {
              value: denomination.value,
              currency: denomination.currency,
              usdValue: denomination.usdValue,
              inStock: denomination.inStock,
              syncedAt: now,
            },
          });
      }
      const currentIds = product.denominations.map((item) => item.providerPackageId);
      await tx
        .update(productDenominationsTable)
        .set({ inStock: false, syncedAt: now })
        .where(
          and(
            eq(productDenominationsTable.productId, product.id),
            currentIds.length
              ? sql`${productDenominationsTable.providerPackageId} not in (${sql.join(
                  currentIds.map((id) => sql`${id}`),
                  sql`, `,
                )})`
              : sql`true`,
          ),
        );
    }

    await publishCuratedCatalog(tx, now);
    await tx
      .insert(catalogSyncStateTable)
      .values({
        provider: PROVIDER,
        catalogVersion: CATALOG_VERSION,
        lastCompletedAt: now,
        retryAfter: null,
        syncStatus: "succeeded",
        syncCompletedAt: now,
        syncError: null,
        leaseExpiresAt: null,
      })
      .onConflictDoUpdate({
        target: catalogSyncStateTable.provider,
        set: {
          catalogVersion: CATALOG_VERSION,
          lastCompletedAt: now,
          retryAfter: null,
          syncStatus: "succeeded",
          syncCompletedAt: now,
          syncError: null,
          leaseExpiresAt: null,
          updatedAt: now,
        },
      });
  });
  logger.info(
    {
      productCount: products.length,
      availableProductCount: products.filter(hasEligibleAmount).length,
      regionCount: regions.filter((region) => region.enabled).length,
    },
    "Payz catalog synchronized",
  );
}
