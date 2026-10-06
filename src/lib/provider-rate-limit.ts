import { createRequestPacer } from "payz-core/request-pacer";

// Stay below both the Personal API's per-minute and 1,000-per-hour product-read limits.
export const waitForBitrefillCatalogSlot = createRequestPacer(3_700);
