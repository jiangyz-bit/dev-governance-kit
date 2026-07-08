# Local Runbook

## Prerequisites

- {{RUNTIME}}
- {{BUILD_TOOL}}
- {{DATABASE_RUNTIME}}
- Node.js for governance scripts

## Start Database

```bash
{{START_DATABASE_COMMAND}}
```

## Start Server

```bash
{{START_SERVER_COMMAND}}
```

## Verify

```bash
{{TEST_COMMAND}}
node scripts/generate-status-registry.mjs
node scripts/check-status-registry.mjs
```

