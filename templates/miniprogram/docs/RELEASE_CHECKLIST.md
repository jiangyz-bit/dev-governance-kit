# Release Checklist

- Tests pass.
- Mini program development tool opens the project without config errors.
- `node scripts/generate-status-registry.mjs` has been run after any server `docs/status-enums.json` change.
- `node scripts/check-status-registry.mjs` passes.
- API paths match server routes.
- Public config contains no secrets.

