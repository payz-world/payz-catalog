import type { ProductRecord, ProductDenominationRecord } from "payz-core/db";

export const MINIMUM_CATALOG_DENOMINATION = 15;

export function isEligibleCatalogUsdCents(cents: number): boolean {
  return Number.isSafeInteger(cents) &&
    cents >= MINIMUM_CATALOG_DENOMINATION * 100;
}

export function isEligibleCatalogUsdValue(value: number | string): boolean {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const cents = Math.round(amount * 100);
  return Math.abs(amount - cents / 100) < 0.000001 &&
    isEligibleCatalogUsdCents(cents);
}

export function productRange(product: ProductRecord): { min: number; max: number; step: number } | null {
  const min = product.rangeMin === null ? NaN : Number(product.rangeMin);
  const max = product.rangeMax === null ? NaN : Number(product.rangeMax);
  const step = product.rangeStep === null ? NaN : Number(product.rangeStep);
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step) ||
      min < 0 || max < min || step <= 0) return null;
  return { min, max, step };
}

export function firstEligibleRangeAmountForRate(
  min: number,
  max: number,
  step: number,
  usdRate: number,
): number | null {
  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    !Number.isFinite(step) ||
    !Number.isFinite(usdRate) ||
    min < 0 ||
    max < min ||
    step <= 0 ||
    usdRate <= 0
  ) {
    return null;
  }
  const requiredLocalValue = MINIMUM_CATALOG_DENOMINATION / usdRate;
  const stepsToMinimum = Math.max(
    0,
    Math.ceil((requiredLocalValue - min) / step - 1e-9),
  );
  const first = Math.round((min + stepsToMinimum * step) * 100) / 100;
  if (first <= max && isEligibleCatalogUsdCents(Math.round(first * usdRate * 100))) {
    return first;
  }
  return null;
}

export function firstEligibleRangeAmount(product: ProductRecord): number | null {
  const range = productRange(product);
  if (!range) return null;
  const usdRate = product.currency === "USD" && !(Number(product.usdRate) > 0)
    ? 1
    : Number(product.usdRate);
  return firstEligibleRangeAmountForRate(range.min, range.max, range.step, usdRate);
}

export function eligibleDenominations(product: ProductRecord, rows: ProductDenominationRecord[]): number[] {
  return [...new Set(rows
    .filter((row) => row.productId === product.id && row.inStock && row.currency === product.currency)
    .filter((row) => {
      const value = Number(row.value);
      const usdValue = row.usdValue == null
        ? product.currency === "USD" ? value : NaN
        : Number(row.usdValue);
      return Number.isFinite(value) && Number.isFinite(usdValue) &&
        isEligibleCatalogUsdValue(usdValue);
    })
    .map((row) => Number(row.value)),
  )].sort((a, b) => a - b);
}

export function denominationLabels(product: ProductRecord, rows: ProductDenominationRecord[]): Record<string, string> {
  const eligible = new Set(eligibleDenominations(product, rows));
  const labels: Record<string, string> = {};
  for (const row of rows) {
    if (row.productId !== product.id || row.currency !== product.currency ||
        !eligible.has(Number(row.value)) || !row.inStock) continue;
    const separator = row.providerPackageId.indexOf("<&>");
    if (separator < 0) continue;
    const label = row.providerPackageId.slice(separator + 3);
    if (label && !Number.isFinite(Number(label))) labels[String(Number(row.value))] = label;
  }
  return labels;
}

export function isAvailableVariant(product: ProductRecord, rows: ProductDenominationRecord[]): boolean {
  return product.inStock &&
    (eligibleDenominations(product, rows).length > 0 || firstEligibleRangeAmount(product) !== null);
}
