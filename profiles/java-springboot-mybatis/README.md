# Java Spring Boot MyBatis Profile

Use this profile when the backend stack is Java, Spring Boot, MyBatis, Flyway, and MySQL.

## Recommended Layers

```text
controller -> service -> dao.mapper / dao.entity -> database
```

## Rules

- Controllers handle HTTP mapping and request/response adaptation only.
- Services own business rules, permission checks, transactions, and status transitions.
- MyBatis mappers own SQL.
- Flyway migrations own schema history.
- Status code changes start in `docs/status-enums.json`.

## Typical Commands

```bash
mvn test
mvn package
node scripts/generate-status-registry.mjs
node scripts/check-status-registry.mjs
```

