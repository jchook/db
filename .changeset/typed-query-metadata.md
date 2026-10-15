---
'@tanstack/db': minor
'@tanstack/react-db': minor
'@tanstack/query-db-collection': minor
'@tanstack/db-sqlite-persistence-core': minor
---

Add optional typed live-query metadata, forwarded to source subset loads and
unloads across joins, pagination, and replay. Include metadata in query and
request identity, isolate Query adapter cache scopes, and preserve context
through persistence coordinator transport. React hooks rebuild queries when
metadata changes; applications can register a shared QueryMeta type.
