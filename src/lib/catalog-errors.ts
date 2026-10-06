export class CatalogUnavailableError extends Error {
  constructor(
    message = "The product catalog is temporarily unavailable.",
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "CatalogUnavailableError";
  }
}

export class CatalogSyncInProgressError extends Error {
  constructor() {
    super("The product catalog is still synchronizing.");
    this.name = "CatalogSyncInProgressError";
  }
}
