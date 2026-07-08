# Database Rules

## Source Of Truth

- Migration files are the source of truth for schema changes.
- Data access files are the source of truth for runtime queries.
- `docs/status-enums.json` is the source of truth for status vocabularies.

## Migration Rules

- Add a new migration for every schema or seed-data change.
- Do not modify deployed migrations.
- Migrations must be repeatable in a clean local database.
- Use Unicode-compatible text fields for user-facing content.
- Add indexes when introducing query paths used by list pages, dashboards, or joins.
- Keep seed data minimal and production-safe.

## Status Columns

- Store status enum `code` values only.
- Add database constraints where the target database supports them reliably.
- If constraints are not reliable, enforce values in service code and tests.
- Any status normalization requires a dedicated migration and an update to `docs/status-enums.json`.

