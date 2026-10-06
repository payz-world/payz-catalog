import { eq, sql } from "drizzle-orm";
import { db, catalogSyncStateTable } from "payz-core/db";
import { CatalogUnavailableError } from "./catalog-errors";
import { publishCuratedCatalog } from "./catalog-publication";
import { CATALOG_SYNC_INTERVAL_MS, CURATED_CATALOG_VERSION } from "./catalog-policy";
import { logger } from "./logger";
import { catalogSource } from "./catalog-source-adapter";

const PROVIDER = catalogSource.id;
const RETRY_COOLDOWN_MS = CATALOG_SYNC_INTERVAL_MS;
const LEASE_MS = 2 * 60 * 60 * 1000;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let currentSync: Promise<void> | null = null;

async function readSyncState() {
  const [state] = await db.select().from(catalogSyncStateTable)
    .where(eq(catalogSyncStateTable.provider, PROVIDER)).limit(1);
  return state;
}

// A durable lease and due time prevent process restarts / multiple API instances
// from running another successful refresh before the 24-hour interval.
export async function attemptScheduledCatalogSync(
  runSync = catalogSource.synchronize,
): Promise<void> {
  if (currentSync) return currentSync;
  const now = new Date();
  const leases = await db.update(catalogSyncStateTable).set({
    syncStartedAt: now, syncCompletedAt: null, syncStatus: "running", syncError: null,
    leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
    nextSyncAt: new Date(now.getTime() + CATALOG_SYNC_INTERVAL_MS), updatedAt: now,
  }).where(sql`
    ${catalogSyncStateTable.provider} = ${PROVIDER}
    AND (${catalogSyncStateTable.leaseExpiresAt} IS NULL OR ${catalogSyncStateTable.leaseExpiresAt} <= ${now})
    AND (
      (${catalogSyncStateTable.retryAfter} IS NOT NULL AND ${catalogSyncStateTable.retryAfter} <= ${now})
      OR (${catalogSyncStateTable.retryAfter} IS NULL AND
        (${catalogSyncStateTable.nextSyncAt} IS NULL OR ${catalogSyncStateTable.nextSyncAt} <= ${now}))
    )
  `).returning({ provider: catalogSyncStateTable.provider });
  if (!leases.length) return;
  currentSync = runSync().catch(async (error: unknown) => {
    const retryAfterMs = error instanceof CatalogUnavailableError && error.retryAfterMs
      ? Math.max(CATALOG_SYNC_INTERVAL_MS, error.retryAfterMs) : RETRY_COOLDOWN_MS;
    const failedAt = new Date();
    await db.update(catalogSyncStateTable).set({
      syncStatus: "failed", syncCompletedAt: failedAt,
      syncError: error instanceof CatalogUnavailableError
        ? error.message : "Catalog synchronization or publication failed.",
      retryAfter: new Date(failedAt.getTime() + retryAfterMs),
      leaseExpiresAt: null, updatedAt: failedAt,
    }).where(eq(catalogSyncStateTable.provider, PROVIDER));
    // lastCompletedAt, catalogVersion, inventory and approvals remain untouched.
    logger.warn({ retryAfterMs }, "Catalog refresh failed; retaining the published snapshot");
  }).finally(() => { currentSync = null; });
  return currentSync;
}

async function scheduleNextRefresh(): Promise<void> {
  if (refreshTimer) clearTimeout(refreshTimer);
  const state = await readSyncState();
  const dueAt = state?.leaseExpiresAt?.getTime() ??
    state?.retryAfter?.getTime() ?? state?.nextSyncAt?.getTime() ?? Date.now();
  refreshTimer = setTimeout(() => {
    void attemptScheduledCatalogSync()
      .catch(() => logger.error("Catalog job could not acquire its scheduling state"))
      .finally(() => void scheduleNextRefresh().catch(() => undefined));
  }, Math.max(1_000, dueAt - Date.now()));
  refreshTimer.unref();
}

async function initializeCatalogJob(): Promise<void> {
  await catalogSource.refreshPrices();
  await db.insert(catalogSyncStateTable).values({
    provider: PROVIDER, catalogVersion: CURATED_CATALOG_VERSION, nextSyncAt: new Date(),
  }).onConflictDoNothing();
  const state = await readSyncState();
  if (state?.lastCompletedAt && state.catalogVersion !== CURATED_CATALOG_VERSION) {
    // Republish the last verified database snapshot for the new Payz curation
    // version. Provider catalog requests remain on the 24-hour sync schedule.
    await db.transaction(async (tx) => {
      const approvedCount = await publishCuratedCatalog(tx, state.lastCompletedAt!);
      await tx.update(catalogSyncStateTable).set({
        catalogVersion: CURATED_CATALOG_VERSION, syncStatus: "succeeded",
        syncCompletedAt: state.lastCompletedAt, syncError: null, retryAfter: null,
        nextSyncAt: new Date(state.lastCompletedAt!.getTime() + CATALOG_SYNC_INTERVAL_MS),
        leaseExpiresAt: null, updatedAt: new Date(),
      }).where(eq(catalogSyncStateTable.provider, PROVIDER));
      logger.info({ approvedCount }, "Published curated catalog from stored inventory");
    });
  }
  if (!catalogSource.isConfigured()) {
    const attemptedAt = new Date();
    await db.update(catalogSyncStateTable).set({
      syncStatus: "failed",
      syncError: "Bitrefill catalog credentials are not configured.",
      updatedAt: attemptedAt,
    }).where(eq(catalogSyncStateTable.provider, PROVIDER));
    logger.info("Catalog synchronization is waiting for provider credentials");
    return;
  }
  await scheduleNextRefresh();
}

export function startCatalogSyncJob(): void {
  void initializeCatalogJob().catch(() =>
    logger.error("Catalog background job initialization failed; existing snapshot retained"),
  );
}
