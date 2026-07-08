# AGENTS.md

This file is the entry point for AI coding agents working in this backend repository.
Keep hard rules here and route detailed rules to `docs/`.

## Repository Overview

`{{SERVER_NAME}}` is the backend service for `{{PRODUCT_NAME}}`.
It owns business rules, persistence, authentication, authorization, API contracts, and status enum definitions.

## Tech Stack

- {{LANGUAGE_AND_VERSION}}
- {{WEB_FRAMEWORK}}
- {{ORM_OR_DATA_ACCESS}}
- {{MIGRATION_TOOL}}
- {{DATABASE}}
- {{BUILD_TOOL}}

## Required Reading Rules

- Before changing product behavior, read `docs/API_RULES.md` and `docs/status-enums.json`.
- Before changing business status values or transitions, update `docs/status-enums.json` first, then run `node scripts/generate-status-registry.mjs`.
- Before changing schema, seed data, or database behavior, read `docs/DATABASE_RULES.md`.
- Before changing local startup, deployment, or environment variables, read `docs/LOCAL_RUNBOOK.md`.
- Before final delivery, check `docs/RELEASE_CHECKLIST.md`.

## Hard Rules

- Keep business rules in the service layer.
- Keep database access behind the repository/mapper/dao layer.
- Database status columns store enum `code`; UI displays `desc`.
- Do not introduce unregistered status values.
- Database changes must use migrations.
- Do not commit secrets, tokens, private keys, production passwords, or real user data.
- Do not introduce mock data into production runtime paths.

## Common Commands

```bash
{{START_DATABASE_COMMAND}}
{{START_SERVER_COMMAND}}
{{TEST_COMMAND}}
node scripts/generate-status-registry.mjs
node scripts/check-status-registry.mjs
```

## Done Definition

A backend task is not complete until:

- Relevant tests pass.
- New or changed statuses are registered, generated, and validated.
- Schema changes have migrations.
- API changes are checked against all callers.
- Final response states what was changed, what was verified, and any remaining risk.

