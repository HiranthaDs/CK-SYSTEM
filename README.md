# CK SYS V3

CK SYS V3 is the Supabase-backed replacement for the legacy AR Plastic Google Sheets ERP. It is a React application with a Python FastAPI backend and transactional Postgres accounting/inventory logic.

## What is included

- Supabase Auth with verified ES256 access tokens
- CK/AR company memberships with database-enforced capability roles
- Super-admin account creation with Accounting/PDF Studio, Production, Staff & Payroll, Admin, or read-only access packages
- Super-admin Active/Inactive controls and PIN-confirmed access removal with historical audit identities preserved
- Company-scoped CK/AR danger-zone purge that never deletes login accounts or the other company's records
- Email OTP PIN password recovery and verified password changes
- Raw-material purchasing, bulk-to-chip conversion, piecework, production, and finished stock
- Invoices, partial receipts, customer balances, and server-calculated COGS
- Employees, daily work, monthly payroll, deductions, employer contributions, and settlements
- Double-entry journals, ledger, financial dashboard, and reports
- Row locks, idempotency keys, optimistic protection, append-only reversals, and durable audits
- Responsive React UI; no Tailwind CDN, inline event handlers, Google Apps Script, or runtime CSV/localStorage database fallback

The previous seven source files are retained only as a read-only reference in `legacy-html/`. They are not served or imported by the new application.

## Important before deployment

Rotate any `sb_secret_...` key shared during development. It is privileged and must be treated as compromised. Ordinary requests use the publishable key plus each signed-in user's JWT. The optional in-app **Create account** action requires a rotated `sb_secret_...` key in the backend environment only; it is never sent to React.

The database API key is not the Postgres password. The linked Supabase project was migrated through `20260929190820_enable_lifecycle_rpc_guard.sql` on 2026-09-29. For another environment, apply every checked-in migration through the Supabase SQL Editor or a linked Supabase CLI project before starting the app.

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
5. `supabase/migrations/20260920054049_add_employee_pay_profiles.sql`
6. `supabase/migrations/20260920054055_add_admin_business_data_purge.sql`
7. `supabase/migrations/20260920165126_harden_payroll_and_journals.sql`
8. `supabase/migrations/20260921170045_add_conversion_types_and_rate_links.sql`
9. `supabase/migrations/20260922130000_add_overtime_workflow.sql`
10. `supabase/migrations/20260927170717_add_multi_company_accounting.sql`
11. `supabase/migrations/20260927171851_harden_company_inventory_costing.sql`
12. `supabase/migrations/20260928024913_fix_profiles_rls_recursion.sql`
13. `supabase/migrations/20260928025106_include_inventory_transfers_in_purge.sql`
14. `supabase/migrations/20260928030844_add_company_inventory_read_models.sql`
15. `supabase/migrations/20260928032107_expose_missing_company_memberships.sql`
16. `supabase/migrations/20260929110429_allow_all_authenticated_users_login.sql`
17. `supabase/migrations/20260929111312_activate_existing_auth_users_for_all_companies.sql`
18. `supabase/migrations/20260929112743_make_all_auth_users_full_admin.sql`
19. `supabase/migrations/20260929113355_remove_obsolete_access_provisioning.sql`
20. `supabase/migrations/20260929180741_restore_secure_rbac_and_super_admins.sql`
21. `supabase/migrations/20260929185454_add_account_lifecycle_and_company_purge.sql`
22. `supabase/migrations/20260929190634_fix_account_lifecycle_audit_context.sql`
23. `supabase/migrations/20260929190820_enable_lifecycle_rpc_guard.sql`

Then run every script in `supabase/tests/` in numeric order against a non-production project. The final migration intentionally reverses the temporary universal-Admin state: ordinary Auth identities become pending until a super administrator assigns company and capability access.

Before applying the database, disable public signup in hosted Supabase Auth and review existing users. When their Auth identities exist, `hiranthadiass4@gmail.com` and `asela78@gmail.com` become group super administrators with Admin access to both CK and AR. Passwords are never stored or changed by SQL; keep them in Supabase Auth.

The linked project now has public signup disabled, six-digit email OTPs, a ten-character minimum password, and **Secure password change** enabled. True PIN delivery also requires the local `supabase/templates/recovery.html` content in the hosted **Reset password** template. Supabase blocks custom templates on free-tier projects that still use its default mail provider, so configure custom production SMTP (or upgrade the project), then push/copy that template. Until then, the standard recovery-link flow remains available. Local development captures PIN emails in Mailpit; run `npx supabase status` to find its URL.

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
SUPABASE_SECRET_KEY=sb_secret_replace_me
SUPABASE_JWKS_URL=https://wnutabervhntqceselwf.supabase.co/auth/v1/.well-known/jwks.json
CORS_ORIGINS=["http://localhost:5173"]
```

`SUPABASE_SECRET_KEY` is needed only for super-admin account creation. Keep `backend/.env` out of source control and use a production secret manager. Never use this key in any `VITE_*` variable.

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

Production uses one origin for the React application and Python API. This is
important: direct links such as `/ck/login`, `/ar/dashboard`, and password-reset
links are served by the SPA fallback instead of returning a hosting-provider 404.

### Render (recommended)

Deploy the repository as the Docker web service defined by `render.yaml` (Render
Dashboard → **New** → **Blueprint**). Supply these prompted values:

- `VITE_SUPABASE_URL` and `SUPABASE_URL`: the same Supabase project URL
- `VITE_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_PUBLISHABLE_KEY`: the same
  `sb_publishable_...` key

Add `SUPABASE_SECRET_KEY` separately in Render only if in-app account creation is
required. Never put that secret in a `VITE_*` variable. If you attach a custom
domain, append its hostname (without `https://`) to `TRUSTED_HOSTS`.

Render cannot convert an existing **Static Site** into a Docker **Web Service**.
Create the new `ck-sys-v3-app` Blueprint service, verify it, then move bookmarks
and any custom domain to it. Keep the old service until that verification passes.
Afterward, the old two-service/static-site deployment should not remain public.
The Docker service now serves both the frontend and `/api/v1` on Render's `PORT`,
so there is no cross-origin or internal-hostname dependency. After deployment,
verify all of these URLs directly in a private browser window:

```text
https://YOUR-SERVICE.onrender.com/login
https://YOUR-SERVICE.onrender.com/ck/login
https://YOUR-SERVICE.onrender.com/ar/login
https://YOUR-SERVICE.onrender.com/api/v1/health/live
```

In **Supabase Dashboard → Authentication → Sessions**, keep **Single session per
user** disabled when the same staff account must work on several devices. The app
persists a separate browser session per device, and its normal Sign out action now
ends only the current device's session.

### Docker Compose

Copy `deploy.env.example` to `.env`, set the public values, create
`backend/.env`, then run:

```bash
docker compose up --build -d
```

The application will be served on `http://localhost:8080` by default.

## Cutover and security

- [Architecture](docs/ARCHITECTURE.md)
- [Security checklist](docs/SECURITY.md)
- [System workflow and accounting guide](docs/SYSTEM_WORKFLOW.md)
- [Legacy data cutover](docs/CUTOVER.md)

Do not migrate from the old published CSV: it does not contain the eight ERP tabs. Use a controlled JSON/workbook export and reconcile every stock and ledger balance before switching off legacy writes.
