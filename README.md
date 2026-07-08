# dev-governance-kit

Reusable engineering governance templates for AI-assisted product development.

This repository provides a lightweight structure for keeping product, engineering, status enum, API, database, and release rules executable across multiple repositories.

## Design

Use a layered model:

- `templates/`: files copied into actual project repositories.
- `profiles/`: technology-stack guidance used when adapting templates.
- `docs/status-enums.json`: server-side source of truth for business status codes.
- `STATUS_ENUM_REGISTRY.md`: generated documentation, never edited manually.
- `scripts/`: no-dependency Node.js checks and generators.

## Recommended Project Layout

```text
product-server/
  AGENTS.md
  docs/
  scripts/

product-admin/
  AGENTS.md
  docs/
  scripts/

product-miniprogram/
  AGENTS.md
  docs/
  scripts/
```

The server repository owns `docs/status-enums.json`. Admin and client repositories generate local registry mirrors from the server source.

## Apply To A New Project

1. Copy `templates/server/*` into the backend repository.
2. Copy `templates/admin/*` into the admin frontend repository, if applicable.
3. Copy `templates/miniprogram/*` into the mini program repository, if applicable.
4. Replace placeholder text in `AGENTS.md` and `docs/*.md`.
5. Define business statuses in `server/docs/status-enums.json`.
6. Run the generator and checks in every repository.

## Status Workflow

```bash
cd product-server
node scripts/generate-status-registry.mjs
node scripts/check-status-registry.mjs

cd ../product-admin
node scripts/generate-status-registry.mjs
node scripts/check-status-registry.mjs

cd ../product-miniprogram
node scripts/generate-status-registry.mjs
node scripts/check-status-registry.mjs
```

If repositories are not siblings, set:

```bash
SERVER_REPO_DIR=/path/to/product-server
```

## What This Kit Enforces

- Status enum source of truth is server-owned.
- Databases store stable `code` values, not display labels.
- Generated Markdown cannot drift from JSON.
- UI repositories cannot introduce unregistered status codes.
- AI coding agents have repository-local instructions through `AGENTS.md`.
- Release checks are explicit and repeatable.

