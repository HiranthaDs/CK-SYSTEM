# Google Sheet to Supabase cutover

The published legacy CSV is not a database export. It represents only one sheet while the ERP stores data in eight separate tabs. Do not use it for migration.

## Safe cutover sequence

1. Deploy the Supabase migration in a non-production project and run the database tests.
2. Create canonical inventory items and map every historical material, chip, and finished-good spelling to an item UUID.
3. Export all legacy tabs as one controlled JSON bundle: Employees, RM_Purchases, Conversions, Production, Sales, Payroll, Adjustments, and Ledger. Preserve original row number, `id`, `refId`, `workId`, raw JSON, and timestamps.
4. Run preflight checks for malformed JSON, duplicate IDs/references, invalid dates, orphaned employee/work references, negative stock, double-claimed piecework, and unbalanced journals. Quarantine failures; do not coerce them to zero or `{}`.
5. Import into staging, preserving legacy payloads only as trace fields. Reconcile item quantities/values, receivables, payables, piecework, payroll settlements, and debit/credit totals.
6. Obtain written approval for any valuation difference caused by replacing the legacy lifetime-average algorithm with perpetual weighted-average costing.
7. Freeze writes to Apps Script, take a final export, import the delta, rerun reconciliation, and switch users to CK SYS V3.
8. Keep the Google workbook and Apps Script deployment read-only for evidence. Remove the old web-app URL from bookmarks and hosting.

The application contains no silent legacy fallback. A cutover is complete only after the Supabase row counts and reconciliation report have been approved.

