# Local Runbook

## Prerequisites

- Node.js
- Backend API running locally or configured through environment variables.

## Start

```bash
{{INSTALL_COMMAND}}
{{DEV_COMMAND}}
```

## Verify

```bash
{{TEST_COMMAND}}
{{TYPECHECK_COMMAND}}
{{BUILD_COMMAND}}
node scripts/generate-status-registry.mjs
node scripts/check-status-registry.mjs
```

