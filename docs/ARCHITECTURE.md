# CK SYS V3 architecture

CK SYS V3 is split into three hard boundaries:

1. **React client** — presentation, memory-only Supabase Auth, form validation, and bounded in-memory query coordination.
2. **FastAPI service** — JWT verification, role checks, request validation, pagination, observability, and the only application-facing data API.
3. **Supabase Postgres** — normalized source of truth, row-level security, atomic posting functions, stock locks, idempotency records, audit history, and reporting views.

The browser never receives a Supabase secret key and never writes ERP tables directly. It sends the signed-in user's short-lived access token to FastAPI. FastAPI validates the ES256 signature and claims against the project's JWKS, then forwards the same user context to Supabase. Database row-level security therefore remains authoritative.

## Write path

```text
React form
  -> Zod validation
  -> FastAPI/Pydantic validation
  -> role check + Idempotency-Key
  -> erp_execute(...) Postgres RPC
  -> row locks + authoritative recalculation
  -> document + stock movement + balanced journal + audit event
  -> commit once
```

The RPC is the transaction boundary. FastAPI does not attempt a chain of independent REST inserts and compensate later. A failed validation, stock check, accounting check, or audit insert rolls back the whole operation.

Posted operational documents are reversed, not physically edited. This preserves audit evidence and ensures the reversal itself is an atomic stock/accounting event.

## Inventory costing

Stock is keyed by UUID-backed inventory items instead of free-text names. Quantities and unit costs use fixed-precision Postgres `numeric`, while posted currency values use two decimal places. Every stock-changing RPC locks the relevant balance rows before checking availability and posting movements. This removes the legacy overselling race and the lifetime-average drift caused by rebuilding stock from browser JSON.

## Accounting

Every operational event owns one posted journal. Journal lines enforce one positive side per row. The posting function requires at least two lines and exact equality between currency-rounded debit and credit totals. Posted journals and lines are immutable; corrections link a reversal journal to the original.

## Authentication and roles

Supabase Auth owns identities and passwords. `profiles`, `company_memberships`, `company_user_roles`, roles, and permissions authorize each legal company independently:

- `admin`: user and configuration administration, all ERP functions
- `accountant`: accounting, sales settlements, payroll, and reporting
- `operations`: procurement, conversion, production, inventory, and sales capture
- `payroll`: employee, daily-work, payroll, and payroll reporting
- `viewer`: read-only access

The database policies and FastAPI both enforce access. UI guards are convenience only.

Group super administrators can use the server-only Auth Admin endpoint to create an identity, then the database atomically assigns CK, AR, or both plus the selected roles. If database provisioning fails immediately after Auth creation, FastAPI deletes the just-created orphan identity as a compensating action. The secret Auth key never reaches the browser.

## Failure behavior

There is deliberately no CSV, localStorage, or Google Sheet fallback. TanStack Query may retain in-memory display data while a request refreshes, but a backend failure is shown as an error and cannot turn stale browser data into an accepted write.
