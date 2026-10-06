import { and, asc, eq, getTableColumns, ilike, inArray, or } from "drizzle-orm";
import type { Category, Product, Region } from "payz-core/types";
import {
  db,
  catalogCurationTable,
  productDenominationsTable,
  productsTable,
  regionsTable,
} from "payz-core/db";
import { ensureCatalogFresh } from "./catalog-snapshot";
import { selectFeaturedProducts, takeUniqueBrands } from "./catalog-curation";
import {
  denominationLabels,
  eligibleDenominations,
  firstEligibleRangeAmount,
  isAvailableVariant,
  productRange,
} from "./catalog-eligibility";
import { CATEGORY_TAXONOMY, CURATED_CATEGORY_LIMIT, SUPPORTED_COUNTRY_CODES } from "./catalog-policy";
import { catalogGroupId, customerDescription, customerFacingText } from "./catalog-identity";

const PROVIDER = "bitrefill";
const categoryTaxonomy = CATEGORY_TAXONOMY;
const categoryLabels = new Map(categoryTaxonomy.map(({ id, name }) => [id, name]));

type ProductRow = typeof productsTable.$inferSelect;
type DenominationRow = typeof productDenominationsTable.$inferSelect;
const PAGE_DEFAULT = 1;
const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 50;
const GLOBAL_TOP_LIMIT = 10;
const REGIONAL_TOP_LIMIT = 8;
const CATEGORY_SECTION_LIMIT = CURATED_CATEGORY_LIMIT;

function categoryNameFor(id: string): string {
  const known = categoryLabels.get(id);
  if (known) return known;
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ") || "Other";
}

function logoKeyForBrand(brand: string): string {
  return brand
    .toLowerCase()
    .replaceAll("&", "and")
    .replaceAll("+", "plus")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");
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

function regionFromRow(row: typeof regionsTable.$inferSelect | undefined, code: string): Region {
  return row
    ? {
        code: row.code,
        name: row.name,
        currency: row.currency,
        currencySymbol: row.currencySymbol,
      }
    : { code, name: code, currency: "", currencySymbol: "" };
}

async function loadDenominations(products: ProductRow[]): Promise<DenominationRow[]> {
  if (!products.length) return [];
  return db
    .select()
    .from(productDenominationsTable)
    .where(inArray(productDenominationsTable.productId, products.map((product) => product.id)))
    .orderBy(asc(productDenominationsTable.value));
}

export async function getCatalogRegions(): Promise<Region[]> {
  await ensureCatalogFresh();
  const rows = await db
    .select({
      code: regionsTable.code,
      name: regionsTable.name,
      currency: regionsTable.currency,
      currencySymbol: regionsTable.currencySymbol,
    })
    .from(regionsTable)
    .where(and(eq(regionsTable.enabled, true), inArray(regionsTable.code, SUPPORTED_COUNTRY_CODES)))
    .orderBy(asc(regionsTable.name));
  return rows.sort((a, b) => SUPPORTED_COUNTRY_CODES.indexOf(a.code) - SUPPORTED_COUNTRY_CODES.indexOf(b.code));
}

async function buildCatalogProducts(
  regionCode?: string,
  categoryId?: string,
  search?: string,
  currency?: string,
  featuredOnly = false,
): Promise<Product[]> {
  await ensureCatalogFresh();

  const filters = [
    eq(productsTable.provider, PROVIDER),
    eq(productsTable.productType, "gift-card"),
    eq(productsTable.presentInLatestSync, true),
    eq(catalogCurationTable.active, true),
    inArray(productsTable.regionCode, SUPPORTED_COUNTRY_CODES),
  ];
  if (featuredOnly) filters.push(eq(catalogCurationTable.featured, true));
  if (regionCode) filters.push(eq(productsTable.regionCode, regionCode));
  if (categoryId) filters.push(eq(productsTable.categoryId, categoryId));
  if (currency) filters.push(eq(productsTable.currency, currency.toUpperCase()));
  const normalizedSearch = search?.trim();
  if (normalizedSearch) {
    const escaped = normalizedSearch.replaceAll(/[\\%_]/g, "\\$&");
    const pattern = `%${escaped}%`;
    const searchFilter = or(
      ilike(productsTable.brand, pattern),
      ilike(productsTable.name, pattern),
      ilike(productsTable.description, pattern),
    );
    if (searchFilter) filters.push(searchFilter);
  }

  const candidates = await db
    .select({
      ...getTableColumns(productsTable),
      catalogRank: catalogCurationTable.rank,
      catalogFeatured: catalogCurationTable.featured,
    })
    .from(productsTable)
    .innerJoin(catalogCurationTable, eq(catalogCurationTable.productId, productsTable.id))
    .where(and(...filters))
    .orderBy(asc(catalogCurationTable.rank), asc(productsTable.brand), asc(productsTable.name));
  if (!candidates.length) return [];

  const groupIds = [...new Set(candidates.map((product) => product.productGroupId).filter(Boolean))];
  if (!groupIds.length) return [];
  const variants = await db
    .select(getTableColumns(productsTable))
    .from(productsTable)
    .innerJoin(catalogCurationTable, eq(catalogCurationTable.productId, productsTable.id))
    .where(
      and(
        eq(productsTable.provider, PROVIDER),
        eq(productsTable.productType, "gift-card"),
        eq(productsTable.presentInLatestSync, true),
        eq(catalogCurationTable.active, true),
        inArray(productsTable.regionCode, SUPPORTED_COUNTRY_CODES),
        inArray(productsTable.productGroupId, groupIds),
      ),
    )
    .orderBy(asc(productsTable.regionCode), asc(productsTable.name));
  const denominations = await loadDenominations(variants);
  const denominationMap = new Map<string, DenominationRow[]>();
  for (const row of denominations) {
    const productRows = denominationMap.get(row.productId) ?? [];
    productRows.push(row);
    denominationMap.set(row.productId, productRows);
  }

  const regionCodes = [...new Set(variants.map((product) => product.regionCode))];
  const regionRows = regionCodes.length
    ? await db
        .select()
        .from(regionsTable)
        .where(and(inArray(regionsTable.code, regionCodes), eq(regionsTable.enabled, true)))
    : [];
  const regionsByCode = new Map(regionRows.map((region) => [region.code, region]));
  const enabledRegionCodes = new Set(regionRows.map((region) => region.code));

  const candidateGroups = new Set(
    candidates
      .filter((product) =>
        enabledRegionCodes.has(product.regionCode) &&
        isAvailableVariant(product, denominationMap.get(product.id) ?? []),
      )
      .map((product) => product.productGroupId),
  );
  if (!candidateGroups.size) return [];

  const groupedVariants = new Map<string, ProductRow[]>();
  for (const product of variants) {
    if (!candidateGroups.has(product.productGroupId) || !enabledRegionCodes.has(product.regionCode)) continue;
    const group = groupedVariants.get(product.productGroupId) ?? [];
    group.push(product);
    groupedVariants.set(product.productGroupId, group);
  }

  const persistedRanks = new Map<string, number>();
  const featuredGroups = new Set<string>();
  for (const candidate of candidates) {
    persistedRanks.set(candidate.productGroupId, Math.min(
      persistedRanks.get(candidate.productGroupId) ?? Infinity, candidate.catalogRank,
    ));
    if (candidate.catalogFeatured) featuredGroups.add(candidate.productGroupId);
  }
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const products: Product[] = [];
  for (const [groupId, group] of groupedVariants) {
    const availableVariants = group.filter((product) =>
      isAvailableVariant(product, denominationMap.get(product.id) ?? []),
    );
    const supportedRegions = [...new Set(group.map((product) => product.regionCode))]
      .map((code) => regionFromRow(regionsByCode.get(code), code))
      .sort((a, b) => a.name.localeCompare(b.name));
    const availableRegions = [...new Set(availableVariants.map((product) => product.regionCode))]
      .map((code) => regionFromRow(regionsByCode.get(code), code))
      .sort((a, b) => a.name.localeCompare(b.name));
    const currencies = [...new Set(group.map((product) => product.currency))].sort();
    const selectedVariant = regionCode
      ? group.find((product) =>
          product.regionCode === regionCode &&
          candidateIds.has(product.id) &&
          isAvailableVariant(product, denominationMap.get(product.id) ?? []),
        )
      : undefined;
    const selectedDenominations = selectedVariant
      ? eligibleDenominations(selectedVariant, denominationMap.get(selectedVariant.id) ?? [])
      : [];
    const selectedRange = selectedVariant ? productRange(selectedVariant) : null;
    const rangeStartingPrice = selectedVariant ? firstEligibleRangeAmount(selectedVariant) : null;
    const startingPrice = selectedDenominations[0] ?? rangeStartingPrice;
    const representative = selectedVariant ?? group[0];
    const displayCurrency = selectedVariant?.currency ??
      (currencies.length === 1 ? currencies[0] : null);

    products.push({
      id: groupId,
      variantId: selectedVariant?.id ?? null,
      brand: customerFacingText(representative.brand),
      name: customerFacingText(selectedVariant?.name ?? representative.brand),
      description: customerDescription(selectedVariant?.description ?? group.find((product) => product.description)?.description ?? ""),
      categoryId: representative.categoryId,
      categoryName: categoryNameFor(representative.categoryId),
      regionCode: selectedVariant?.regionCode ?? null,
      currency: displayCurrency,
      currencySymbol: displayCurrency ? currencySymbolFor(displayCurrency) : null,
      startingPrice,
      denominations: selectedDenominations,
      denominationLabels: selectedVariant
        ? denominationLabels(selectedVariant, denominationMap.get(selectedVariant.id) ?? [])
        : {},
      range: selectedRange && rangeStartingPrice !== null
        ? { ...selectedRange, min: rangeStartingPrice }
        : null,
      regions: supportedRegions,
      availableRegions,
      currencies,
      available: availableVariants.length > 0,
       featured: featuredGroups.has(groupId),
      isPreview: false,
      logoKey: logoKeyForBrand(representative.brand),
      brandColor: "#e9eef4",
      image: group.find((product) => product.imageUrl)?.imageUrl ?? null,
    });
  }

  return products.sort((a, b) =>
    (persistedRanks.get(a.id) ?? Infinity) - (persistedRanks.get(b.id) ?? Infinity) ||
    a.brand.localeCompare(b.brand) || a.id.localeCompare(b.id),
  );
}

export async function getCatalogProducts(
  regionCode?: string,
  categoryId?: string,
  search?: string,
  currency?: string,
  requestedPage = PAGE_DEFAULT,
  requestedPageSize = PAGE_SIZE_DEFAULT,
): Promise<{
  products: Product[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}> {
  const page = Math.max(PAGE_DEFAULT, Math.trunc(requestedPage));
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Math.trunc(requestedPageSize)));
  const isSearch = Boolean(search?.trim());
  const allProducts = await buildCatalogProducts(regionCode, categoryId, search, currency, !isSearch);
  // All/global browsing includes every featured brand in its scope. A specific
  // country's category stays curated; search can reach approved non-featured offers.
  const rankedProducts = takeUniqueBrands(
    allProducts, isSearch || !regionCode || !categoryId ? Infinity : CURATED_CATEGORY_LIMIT,
  );
  const total = rankedProducts.length;
  const totalPages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize;
  return {
    products: rankedProducts.slice(start, start + pageSize),
    page,
    pageSize,
    total,
    totalPages,
  };
}

export async function getCatalogHome(regionCode?: string): Promise<{
  globalTop: Product[];
  regionalTop: Product[];
  categorySections: Array<{ categoryId: string; categoryName: string; products: Product[] }>;
}> {
  const products = await buildCatalogProducts(regionCode, undefined, undefined, undefined, true);
  const globalTop = selectFeaturedProducts(products, GLOBAL_TOP_LIMIT);
  const globalIds = new Set(globalTop.map((product) => product.id));
  const regionalTop = regionCode
    ? takeUniqueBrands(
        products.filter((product) => !globalIds.has(product.id)),
        REGIONAL_TOP_LIMIT,
      )
    : [];
  const categorySections = categoryTaxonomy.flatMap((category) => {
    const sectionProducts = takeUniqueBrands(
      products.filter((product) => product.categoryId === category.id),
      regionCode ? CATEGORY_SECTION_LIMIT : Infinity,
    );
    return sectionProducts.length
      ? [{ categoryId: category.id, categoryName: category.name, products: sectionProducts }]
      : [];
  });

  return { globalTop, regionalTop, categorySections };
}

export async function getCatalogCategories(regionCode?: string): Promise<Category[]> {
  void regionCode;
  await ensureCatalogFresh();
  return categoryTaxonomy.map((category) => ({ ...category }));
}

export async function getCatalogProduct(
  productGroupId: string,
  regionCode?: string,
): Promise<Product | undefined> {
  const products = await buildCatalogProducts(regionCode);
  const currentProduct = products.find((product) => product.id === productGroupId);
  if (currentProduct) return currentProduct;

  // Preserve old deep links when products moved from the retired tech-apps category.
  return products.find((product) => catalogGroupId(product.brand, "tech-apps") === productGroupId);
}
