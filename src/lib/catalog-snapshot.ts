import { eq } from "drizzle-orm";
import { db, catalogSyncStateTable } from "payz-core/db";
import { CatalogSyncInProgressError, CatalogUnavailableError } from "./catalog-errors";
import { CURATED_CATALOG_VERSION } from "./catalog-policy";

// This compatibility name is a readiness check, not a refresh trigger.
// Expired or failed refreshes never block a previously published good snapshot.
export async function ensureCatalogFresh(): Promise<void> {
  const [state] = await db.select().from(catalogSyncStateTable)
    .where(eq(catalogSyncStateTable.provider, "bitrefill")).limit(1);
  if (state?.lastCompletedAt && state.catalogVersion === CURATED_CATALOG_VERSION) return;
  if (state?.syncStatus === "running") throw new CatalogSyncInProgressError();
  throw new CatalogUnavailableError();
}
