# React Admin Profile

Use this profile for internal operations consoles.

## Rules

- Build task-oriented screens, not marketing pages.
- Keep API access in service modules.
- Keep domain statuses and permission definitions outside page components.
- Handle loading, empty, error, permission denied, and success states.
- Treat frontend permission checks as UX; backend remains authoritative.

## Typical Commands

```bash
npm run test
npm run typecheck
npm run build
node scripts/generate-status-registry.mjs
node scripts/check-status-registry.mjs
```

