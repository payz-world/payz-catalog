# Payz Catalog

Payz Catalog manages the product data used throughout Payz.

## Overview

The catalog normalizes product and denomination data, maps categories and supported regions, filters purchasable variants, curates featured products, and publishes catalog snapshots. Customer-facing reads use persisted catalog data; they do not fetch from external sources.

## Architecture

Catalog source adapters implement a shared Payz interface. The existing scheduled synchronization and persistence behavior stays in the catalog service; external source details do not define Payz catalog interfaces.

## Development

Use Node.js 22 or later and pnpm 10. This package depends on `payz-core`; keep both separate repositories in one pnpm workspace:

```sh
mkdir -p payz-catalog-development/repos
cd payz-catalog-development
git clone https://github.com/payz-world/payz-core.git repos/payz-core
git clone https://github.com/payz-world/payz-catalog.git repos/payz-catalog
cp repos/payz-catalog/development/package.json .
cp repos/payz-catalog/development/pnpm-workspace.yaml .
pnpm install
pnpm --filter payz-catalog typecheck
pnpm --filter payz-catalog test:unit
```

When adding this package to another Payz service, add both checkouts to the existing pnpm workspace rather than creating a second workspace.

## Configuration

Copy `.env.example` to a local environment file and use a dedicated local test database, never the production database or a database containing real purchase data:

- `DATABASE_URL`: connection to the local test database.
- `PAYZ_PROVIDER_ACCESS_TOKEN`: server-side credential for the configured catalog source.
- `PAYZ_FULFILLMENT_API_BASE_URL`: optional HTTPS endpoint override for controlled local testing.

Do not commit `.env` files, credentials, or purchase data. Unit tests and typechecking do not require database or provider access. The integration test operates on the database and may modify catalog data. Run it only with a disposable, locally controlled test database:

```sh
pnpm --filter payz-catalog test:integration
```

## Testing

`pnpm --filter payz-catalog test` runs the unit tests. Database-backed integration tests are opt-in and must not use production or application data.

## License

Licensed under [Apache-2.0](LICENSE).
