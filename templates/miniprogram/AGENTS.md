# AGENTS.md

This file is the entry point for AI coding agents working in this mini program repository.

## Repository Overview

`{{MINIPROGRAM_NAME}}` is the mini program client for `{{PRODUCT_NAME}}`.
The backend repository owns business rules and status enum definitions.

## Required Reading Rules

- Before changing pages or user flows, read `docs/MINIPROGRAM_RULES.md`.
- Before changing API calls, read `docs/API_RULES.md`.
- Before changing status display, update the server repository `docs/status-enums.json` first, then run `node scripts/generate-status-registry.mjs`.
- Before final delivery, check `docs/RELEASE_CHECKLIST.md`.

## Hard Rules

- All backend calls must go through the shared API utility.
- Do not commit secrets, private keys, user data, or test passwords.
- Do not add production mock data paths.
- Pages must show explicit loading, empty, and error states for remote data.

## Common Commands

```bash
{{INSTALL_COMMAND}}
{{TEST_COMMAND}}
node scripts/generate-status-registry.mjs
node scripts/check-status-registry.mjs
```

