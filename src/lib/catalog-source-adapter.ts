import type { CatalogSource } from "payz-core/contracts";
import {
  getPersonalAuthHeader,
  performSync,
  refreshStoredUsdPricing,
} from "./bitrefill-catalog";

export const catalogSource: CatalogSource = {
  id: "bitrefill",
  isConfigured: () => Boolean(getPersonalAuthHeader()),
  refreshPrices: refreshStoredUsdPricing,
  synchronize: performSync,
};
