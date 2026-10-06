const FX_API_BASE = "https://api.frankfurter.dev/v2";
const FX_CACHE_MS = 6 * 60 * 60 * 1000;

type FxRate = {
  base: string;
  quote: string;
  rate: number;
  date: string;
};

type CachedFxRate = {
  value: FxRate;
  expiresAt: number;
};

type JsonObject = Record<string, unknown>;

const cachedRates = new Map<string, CachedFxRate>();

export class CurrencyConversionUnavailableError extends Error {
  constructor(message = "A current currency conversion rate is unavailable.") {
    super(message);
    this.name = "CurrencyConversionUnavailableError";
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function roundFiatAmount(amount: number, currency: string): number {
  if (!Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency)) {
    throw new CurrencyConversionUnavailableError();
  }
  let fractionDigits: number | undefined;
  try {
    fractionDigits = new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits;
  } catch {
    throw new CurrencyConversionUnavailableError();
  }
  if (fractionDigits === undefined || fractionDigits > 2) {
    throw new CurrencyConversionUnavailableError(
      "This currency requires more precision than the catalog supports.",
    );
  }
  const scale = 10 ** fractionDigits;
  return Math.round((amount + Number.EPSILON) * scale) / scale;
}

export function convertToUsdCents(amount: number, rate: number): number {
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !Number.isFinite(rate) ||
    rate <= 0
  ) {
    throw new CurrencyConversionUnavailableError();
  }
  const cents = Math.round((amount * rate + Number.EPSILON) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : 0;
}

export async function getUsdRate(currency: string): Promise<FxRate> {
  const base = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(base)) throw new CurrencyConversionUnavailableError();
  if (base === "USD") {
    return { base: "USD", quote: "USD", rate: 1, date: new Date().toISOString().slice(0, 10) };
  }

  const cached = cachedRates.get(base);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let response: Response;
  try {
    response = await fetch(
      `${FX_API_BASE}/rate/${encodeURIComponent(base.toLowerCase())}/usd`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      },
    );
  } catch {
    throw new CurrencyConversionUnavailableError();
  }
  if (!response.ok) throw new CurrencyConversionUnavailableError();

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new CurrencyConversionUnavailableError();
  }
  if (!isObject(result)) throw new CurrencyConversionUnavailableError();

  const quote = typeof result.quote === "string" ? result.quote.toUpperCase() : "";
  const responseBase = typeof result.base === "string" ? result.base.toUpperCase() : "";
  const rate = typeof result.rate === "number" ? result.rate : Number(result.rate);
  const date = typeof result.date === "string" ? result.date : "";
  if (
    responseBase !== base ||
    quote !== "USD" ||
    !Number.isFinite(rate) ||
    rate <= 0 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
  ) {
    throw new CurrencyConversionUnavailableError();
  }

  const value = { base, quote, rate, date };
  cachedRates.set(base, { value, expiresAt: Date.now() + FX_CACHE_MS });
  return value;
}
