# AGENTS.md

This file is the entry point for AI coding agents working in this admin frontend repository.

## Repository Overview

`{{ADMIN_NAME}}` is the operations console for `{{PRODUCT_NAME}}`.
The backend repository owns business rules and status enum definitions.

## Tech Stack

- {{FRONTEND_FRAMEWORK}}
- {{LANGUAGE}}
- {{BUILD_TOOL}}
- {{UI_LIBRARY}}

## Required Reading Rules

- Before changing pages or workflows, read `docs/UI_RULES.md`.
- Before changing status display or action availability, update the server repository `docs/status-enums.json` first, then run `node scripts/generate-status-registry.mjs`.
- Before changing API calls or runtime config, read `docs/API_RULES.md`.
- Before final delivery, check `docs/RELEASE_CHECKLIST.md`.

## Hard Rules

- Runtime data must come from the backend API.
- Do not add production mock data paths.
- Status values must come from domain constants, not ad hoc strings.
- Backend permission checks remain authoritative; frontend permissions are UI gating only.
- Do not expose tokens, passwords, internal service credentials, or production secrets in static files.

## Common Commands

```bash
{{INSTALL_COMMAND}}
{{DEV_COMMAND}}
{{TEST_COMMAND}}
{{TYPECHECK_COMMAND}}
{{BUILD_COMMAND}}
node scripts/generate-status-registry.mjs
node scripts/check-status-registry.mjs
```

