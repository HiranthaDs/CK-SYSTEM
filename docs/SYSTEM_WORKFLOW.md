# CK SYS workflow and first-use guide

## 1. Super-administrator setup

1. Sign in through [CK Settings](/ck/settings) or [AR Settings](/ar/settings).
2. Open **Login accounts & access → Create account**.
3. Enter the employee's individual email and a temporary strong password.
4. Choose **CK**, **AR**, or **Both**.
5. Select only the capability packages required:
   - **Accounting & PDF Studio** — ledgers, reports, PDF Studio, settlements, and finance posting.
   - **Production & operations** — purchasing, conversion, production, inventory, and sales operations.
   - **Staff & payroll** — employee data, work, overtime, payroll, and payroll reporting.
   - **Company administrator** — all company capabilities and access/configuration management.
   - **Read only** — view access without posting.
6. Select **Group super administrator** only for an owner who must administer both systems and create other super administrators.

The menu hides unassigned workspaces, but security does not depend on the menu: FastAPI permissions and Postgres RLS enforce the same access.

### Account status and removal

- A group super administrator can change an account between **Active** and **Inactive** in **Login accounts & access**. Inactive accounts are rejected by the API even if an old browser session still exists.
- **Remove** requires the private confirmation PIN. The PIN is an extra destructive-action confirmation, not a replacement for the super administrator's email/password sign-in.
- The currently signed-in account cannot deactivate or remove itself. The last active group super administrator cannot be deactivated or removed.
- Removal immediately revokes CK/AR memberships and roles and hides the account from the access list. The underlying Auth identity and historical `created_by`/audit references are retained so accounting history remains attributable and valid.
- To restore a removed person later, create/provision a new controlled account rather than changing historical audit rows.

### Company danger-zone reset

The **Delete all data** action applies only to the company portal currently selected. From CK it removes CK business transactions; from AR it removes AR business transactions. It never deletes Authentication accounts, profiles, memberships, roles, the other company's records, the chart of accounts, or shared item/setup masters. Always confirm the company badge, export required reports, and verify a recoverable database backup before using it.

## 2. Daily operating flow

Use the linked pages in this order:

1. [Dashboard](/ck/dashboard) — confirm legal company and fiscal year.
2. [Settings](/ck/settings) — maintain conversion types and piecework rates.
3. [Production](/ck/production) — post raw-material purchases, conversions, workers, and production runs.
4. [Inventory](/ck/inventory) — verify Bulk, Chip, and Finished quantities/value after every posting.
5. [Sales](/ck/sales) — create invoices from available finished stock and record receipts only when received.
6. [Staff & payroll](/ck/employees) — maintain employees/work/overtime, review open earnings, create payroll, then record actual payments.
7. [Accounting](/ck/accounting) — reconcile automatic journals, ledger, reports, and PDF Studio.

Replace `/ck/` with `/ar/` for AR Plastics. CK and AR accounting/workforce records are isolated even though permitted inventory availability may be shared.

## 3. Manual quick accounting

Use Quick double-entry only for a real cash/bank movement that does not belong to Sales, Purchasing, Inventory, Payroll, Tax, or Intercompany workflows.

- **Direction — Money in:** debit the Offset cash/bank asset; credit the Primary revenue, liability, equity, or transfer account.
- **Direction — Money out:** debit the Primary expense/asset/liability account; credit the Offset cash/bank asset.
- **Method:** manually describe the real rail/reference, such as `Bank transfer - BOC`, `Cash`, or `Cheque 001245`. It never selects an account silently.
- **Primary account:** manually enter the exact chart code for the business reason.
- **Offset account:** manually enter the exact asset code where money moved, normally `CASH` or `BANK`.
- **Description:** include counterparty, reason, and external reference.

The system rejects missing/unknown accounts, identical Primary/Offset accounts, non-asset money offsets, protected control accounts, non-positive amounts, closed-period dates, and unbalanced journals. Posted journals are corrected by reversal, not silent editing. Use the **Info** control beside every Quick-entry field for in-app guidance.

## 4. Password recovery and changes

- From a company login, choose **Forgot your password?**, enter the email, then **Send OTP PIN**.
- Enter the six-digit PIN from the recovery email, choose a strong new password, and submit.
- For a signed-in change, use [Account & security](/ck/account).
- After success, the local session ends. Sign in again with the new password so there is no stale-session ambiguity.

CK SYS never stores a password or PIN. Supabase Auth hashes passwords and validates recovery/reauthentication codes.

Hosted PIN emails require custom SMTP and the checked-in `supabase/templates/recovery.html` template. Supabase's free default email provider blocks custom-template changes; while that restriction applies, use the recovery link in the default email. Both paths finish on the same secure new-password screen.
