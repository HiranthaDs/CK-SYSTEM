# Security and secret handling

## Immediate action required

The Supabase `sb_secret_...` value supplied during development must be rotated in **Supabase Dashboard → Project Settings → API Keys** before deployment. Treat it as compromised. CK SYS V3 does not store or require that value for ordinary user-scoped operations.

## Key placement

- `VITE_SUPABASE_PUBLISHABLE_KEY` is intentionally public and may be compiled into the React bundle.
- A user access token is short-lived and is sent as `Authorization: Bearer ...` to FastAPI.
- `SUPABASE_SECRET_KEY` is used only by the FastAPI account-creation endpoint. It belongs in a server secret manager. Never put it in a `VITE_*`/`NEXT_PUBLIC_*` variable, source file, browser storage, screenshot, or log.
- Supabase API keys are not Postgres passwords. Never place an API key into `DATABASE_URL`.

## Production checklist

1. Rotate the disclosed secret key.
2. Disable public signup before applying the database; use controlled invitations or administrator-created identities.
3. Review every existing Auth identity. Verify that `hiranthadiass4@gmail.com` and `asela78@gmail.com` are the intended group super-admins; all other users require an explicit company/capability assignment.
4. Set exact frontend origins in `CORS_ORIGINS` and exact public hostnames in `TRUSTED_HOSTS`; do not use `*` with credentials.
5. Serve React and FastAPI only through HTTPS.
6. Keep JWKS verification pinned to ES256, the exact issuer, and audience `authenticated`.
7. Test RLS with authenticated and anonymous sessions and verify CK/AR company isolation before importing production data.
8. Enable Supabase backups and point-in-time recovery appropriate to the business recovery target.
9. Retain audit events and application logs without recording JWTs, passwords, bank details, or request bodies containing payroll PII.
10. Review Authentication users, `profiles`, company memberships, and roles regularly. Disabling ERP access does not by itself delete the Auth identity.
11. Configure custom production SMTP, then set the hosted Reset password template to `{{ .Token }}` so recovery PINs arrive reliably. Supabase blocks custom email-template updates on free-tier projects that use its default mail provider. Secure password change and six-digit OTPs are already enabled on the linked project; the standard recovery link remains the fallback until SMTP is configured.
12. Test each access package in both portals. Frontend visibility, FastAPI permission checks, Postgres RLS, and RPC authorization must agree.
13. Rotate the backend secret key on staff/security changes and never log account-creation request bodies because they contain temporary passwords.
14. Enable leaked-password protection in Supabase Auth when the project plan supports it; the database advisor currently reports that hosted setting as disabled.
15. Treat the account-removal PIN only as a second destructive-action confirmation. Account removal is still authorized by the signed-in group-super-admin JWT and enforced again in Postgres. Change the PIN through a reviewed migration if it becomes known outside authorized administrators.

## Account lifecycle and data deletion

- **Inactive** blocks ERP authorization without changing the Supabase Auth password or deleting historical ownership references.
- **Remove** requires the private confirmation PIN, revokes every CK/AR membership and assigned role, and retains the inactive Auth/profile identity for audit and foreign-key integrity.
- Self-deactivation, self-removal, and removal/deactivation of the last active group super administrator are rejected in the database.
- The company danger-zone purge is scoped to the verified active company. It preserves all Auth users, profiles, memberships, role assignments, shared setup, and every row belonging only to the other company.
- Run a backup/restore drill before production use. Application confirmation controls reduce mistakes but are not a substitute for recoverable backups.

## Reporting and personal data

Employee, payroll, NIC, bank, phone, EPF, and ETF data are private. Export and WhatsApp actions require an authenticated user and create audit events. Printed or downloaded reports leave the application's controls and must be handled according to the organization's retention policy.
