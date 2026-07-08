# API Rules

## API Shape

- Keep API paths stable and version intentionally.
- Use a consistent response envelope for success and failure.
- Do not return persistence entities directly when a dedicated API view model is needed.

## Error Handling

- Use stable error codes for clients.
- Validation failures must be explicit and actionable.
- Authentication and authorization failures must not leak sensitive account details.
- Do not expose stack traces, SQL details, credentials, or internal addresses in API responses.

## Compatibility

- Any API path, request field, response field, or status value change must be checked against all callers.
- Prefer additive changes unless a coordinated client change is included.

## Authentication And Permissions

- Mutating APIs must validate authentication and authorization server-side.
- Frontend permission checks are UX only; backend checks are authoritative.

## Status Rules

- Workflow transitions must follow `docs/status-enums.json`.
- The service layer is the source of truth for whether an action is allowed.

