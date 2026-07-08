# API Rules

- All backend calls go through the shared API utility.
- Do not scatter request logic across pages.
- Pages should display actionable failure messages and allow retry where appropriate.
- If an API response field changes, update all affected pages in the same task.
- Analytics failures should not block user actions.

