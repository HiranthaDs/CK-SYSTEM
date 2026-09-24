# CK SYS V3

CK SYS V3 is the Supabase-backed replacement for the legacy AR Plastic Google Sheets ERP. It is a React application with a Python FastAPI backend and transactional Postgres accounting/inventory logic.

## What is included

- Supabase Auth with verified ES256 access tokens
- Role-based access for administrators, accountants, operations, payroll, and viewers
- Raw-material purchasing, bulk-to-chip conversion, piecework, production, and finished stock
- Invoices, partial receipts, customer balances, and server-calculated COGS
- Employees, daily work, monthly payroll, deductions, employer contributions, and settlements
- Double-entry journals, ledger, financial dashboard, and reports
- Row locks, idempotency keys, optimistic protection, append-only reversals, and durable audits
- Responsive React UI; no Tailwind CDN, inline event handlers, Google Apps Script, or runtime CSV/localStorage database fallback

The previous seven source files are retained only as a read-only reference in `legacy-html/`. They are not served or imported by the new application.

## Important before deployment

Rotate the `sb_secret_...` key that was shared during development. It is privileged and must be treated as compromised. The application intentionally uses the publishable key plus each signed-in user's JWT; a secret/service-role key is not committed or required for normal operation.

The database API key is not the Postgres password. Since no database password was supplied, this workspace does not automatically alter the live Supabase database. Apply the checked-in SQL migration through the Supabase SQL Editor or a linked Supabase CLI project before starting the app.

## 1. Apply the database

Use one of these methods:

```bash
# After authenticating and linking the Supabase CLI to the correct project
npx supabase db push
```

Or run these files in the Supabase SQL Editor, in this exact order:

1. `supabase/migrations/001_initial_schema.sql`
2. `supabase/migrations/20260916061535_complete_backend_and_security.sql`
3. `supabase/migrations/20260916124032_secure_user_bootstrap.sql`
4. `supabase/migrations/20260916174437_fix_current_date_expressions.sql`

Then run `supabase/tests/001_schema_checks.sql` and `supabase/tests/002_authenticated_access_checks.sql` against a non-production project. The migrations supply the complete transactional dispatcher, database-side dashboard/summary aggregation, reporting views, indexes, explicit grants, RLS policies, and fail-closed account bootstrap; the application is not ready until all migrations and the checks succeed.

Before applying the database, disable public signup in the hosted Supabase Auth settings and review existing Auth users. The earliest existing non-deleted Auth identity is bootstrapped as the sole active administrator, so ensure that identity is the intended owner. Every identity created after migration is inactive with no ERP role until an administrator deliberately approves it.

## 2. Configure the Python API

```powershell
Copy-Item backend/.env.example backend/.env
python -m venv backend/.venv
backend/.venv/Scripts/python -m pip install -r backend/requirements.txt -r backend/requirements-dev.txt
```

Set these values in `backend/.env`:

```ini
SUPABASE_URL=https://wnutabervhntqceselwf.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_replace_me
SUPABASE_JWKS_URL=https://wnutabervhntqceselwf.supabase.co/auth/v1/.well-known/jwks.json
CORS_ORIGINS=["http://localhost:5173"]
```

Do not put the secret key in this file for normal API operation.

## 3. Configure and run React

The local browser configuration is read from `.env.local`:

```ini
VITE_SUPABASE_URL=https://wnutabervhntqceselwf.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_replace_me
VITE_API_URL=/api/v1
```

Install and start both processes:

```bash
npm install
npm run dev
```

`npm run dev` starts both the Python API and Vite, uses `backend/.venv` automatically when it exists, and proxies `/api` to the local API. `npm run dev:all` remains an alias for the same command. Use `npm run dev:web` only when an API is already running separately. For backend-only hot reload, run `npm run dev:api:reload` in a separate terminal.

Open `http://localhost:5173`. API documentation is available at `http://localhost:8000/docs` in development.

`@supabase/supabase-js` and the requested `@supabase/ssr` package are installed. This build is a Vite SPA, so browser authentication uses `supabase-js`; `@supabase/ssr` is retained for a future server-rendered React deployment and is not part of the current auth path. Prisma is intentionally not used because it is a Node ORM; the Python service uses strongly typed Pydantic contracts and transactional Supabase/Postgres RPCs.

## Verification

```bash
npm run check
```

The API pages every collection, supports cursor/keyset traversal for deep datasets, keeps lookup searches server-filtered and debounced, and calculates dashboard/inventory/production totals in Postgres instead of loading whole tables into the browser or Python process.

Production containers can be built with `compose.yaml`. Copy `deploy.env.example` to `.env`, set the public values, create `backend/.env`, then run:

```bash
docker compose up --build -d
```

The application will be served on `http://localhost:8080` by default.

## Cutover and security

- [Architecture](docs/ARCHITECTURE.md)
- [Security checklist](docs/SECURITY.md)
- [Legacy data cutover](docs/CUTOVER.md)

Do not migrate from the old published CSV: it does not contain the eight ERP tabs. Use a controlled JSON/workbook export and reconcile every stock and ledger balance before switching off legacy writes.
