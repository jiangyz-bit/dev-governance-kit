# Release Checklist

- Tests pass.
- Typecheck passes.
- Build passes.
- `node scripts/generate-status-registry.mjs` has been run after any server `docs/status-enums.json` change.
- `node scripts/check-status-registry.mjs` passes.
- Runtime API configuration points to the intended backend.
- Static assets and runtime config contain no secrets.

