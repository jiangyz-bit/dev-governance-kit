# API Rules

- All backend requests should go through a single API client module.
- Do not call `fetch` or HTTP clients directly from page components.
- Keep request and response field names compatible with server APIs.
- Do not swallow API errors silently.
- Public runtime config must contain no secrets.

