# Security and secret handling

## Immediate action required

The Supabase `sb_secret_...` value supplied during development must be rotated in **Supabase Dashboard → Project Settings → API Keys** before deployment. Treat it as compromised. CK SYS V3 does not store or require that value for ordinary user-scoped operations.

## Key placement

- `VITE_SUPABASE_PUBLISHABLE_KEY` is intentionally public and may be compiled into the React bundle.
- A user access token is short-lived and is sent as `Authorization: Bearer ...` to FastAPI.
- `SUPABASE_SECRET_KEY`, if an exceptional administration script ever needs one, belongs only in a server secret manager. Never put it in a `VITE_*`/`NEXT_PUBLIC_*` variable, source file, container image, browser storage, screenshot, or log.
- Supabase API keys are not Postgres passwords. Never place an API key into `DATABASE_URL`.

## Production checklist

1. Rotate the disclosed secret key.
2. Disable public signup before applying the database; use controlled invitations or administrator-created identities.
3. Review existing Auth identities before migration because the earliest existing identity is bootstrapped as administrator. Verify its profile and roles immediately afterward.
4. Set exact frontend origins in `CORS_ORIGINS` and exact public hostnames in `TRUSTED_HOSTS`; do not use `*` with credentials.
5. Serve React and FastAPI only through HTTPS.
6. Keep JWKS verification pinned to ES256, the exact issuer, and audience `authenticated`.
7. Test every RLS policy with allowed and denied roles before importing production data.
8. Enable Supabase backups and point-in-time recovery appropriate to the business recovery target.
9. Retain audit events and application logs without recording JWTs, passwords, bank details, or request bodies containing payroll PII.
10. Review inactive users and privileged roles regularly.

## Reporting and personal data

Employee, payroll, NIC, bank, phone, EPF, and ETF data are private. Export and WhatsApp actions require an authenticated role and create audit events. Printed or downloaded reports leave the application's controls and must be handled according to the organization's retention policy.
