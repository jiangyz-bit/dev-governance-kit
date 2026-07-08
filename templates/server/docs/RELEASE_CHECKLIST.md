# Release Checklist

## Backend

- Tests pass.
- Packaging/build passes when deployment packaging changed.
- `node scripts/generate-status-registry.mjs` has been run after any `docs/status-enums.json` change.
- `node scripts/check-status-registry.mjs` passes.
- New database changes have migrations.
- API changes are checked against all callers.

## Security

- No secrets, production passwords, tokens, private keys, or real user data are committed.
- Mutating APIs require authentication and permission checks.
- Error responses do not leak stack traces or internal infrastructure details.

## Deployment

- Runtime port and health checks match the hosting platform.
- Environment variables are documented outside committed secrets.
- If database baseline or migration repair is needed, document the exact operational step before deployment.

