CK SYS V2 – AR PLASTIC ERP V9
================================

DATABASE
--------
Google Sheet ID:
1iP9e07FzO9urxWOMa3vn5B4A9KNJ2VxybzGcHRaDcLI

Published CSV (read-only reference / diagnostics only):
https://docs.google.com/spreadsheets/d/e/2PACX-1vTWK8NhX0h8BG1a1upLPvv0YLIYKAn8FL28hwE6eNQANEpP9vTqIrIugGGZudx5YwPmIY57w_JKkmd1/pub?output=csv

IMPORTANT:
The CSV URL is NOT used for writes. The ERP writes through the Apps Script Web App to the Google Sheet ID above.

AUTO-CREATED ERP TABS
---------------------
Employees
RM_Purchases
Conversions
Production
Sales
Payroll
Adjustments
Ledger

The existing Sheet1 can remain. It is not used by the ERP engine.

FILES TO DEPLOY TOGETHER
------------------------
index.html
inventory.html
production.html
sales.html
employees.html
erp.min.css

GOOGLE APPS SCRIPT
------------------
Replace the existing Apps Script Code.gs with the supplied Code.gs.
Then update/redeploy the Web App deployment.

If you update the existing deployment, the current default Web App URL in the HTML files can remain.
If Google gives you a new Web App URL, open ERP Settings (gear icon) and paste the new /exec URL once. The system stores it in localStorage for the site origin.

FIRST START
-----------
You can simply open any ERP page after the Apps Script deployment is live. Required tabs are created automatically as they are used.
The backend also includes a POST action named bootstrap if you want to explicitly initialize all tabs.

V9 DATA FLOW
------------
1. Receive bulk plastic into RM_Purchases.
2. Convert bulk plastic to chip stock in Conversions.
3. Allocate one or more employees to the conversion job.
4. Each employee can have an independent Kg quantity and rate.
5. PP, HI, Sorting/Breaking and Other default rates can be stored in the employee profile.
6. Conversion labor is accrued to Piecework Wages Payable and included in chip inventory cost.
7. Production can consume ONLY converted chip inventory for new production records.
8. Finished goods are produced and valued.
9. Sales reduce finished-goods stock and post COGS using the backend-calculated average cost.
10. Payroll can clear unpaid conversion piecework and combine it with monthly salary, daily wages, OT, increments and deductions.

PAYROLL
-------
Supported earning components include:
- Monthly salary
- Daily salary (days x rate)
- Overtime (hours x rate)
- Multiple increments
- Multiple allowances
- Multiple bonuses
- Other earning rows
- Unpaid chip conversion piecework

Supported deductions are unlimited separate rows. The V9 accounting rule engine automatically maps common deductions:
- Salary/staff advance recovery -> Employee Advances & Loans Receivable (asset reduction)
- EPF/provident deductions -> EPF / Provident Fund Payable
- ETF -> ETF Payable
- PAYE/tax -> Payroll Tax Payable
- No-pay/absence/late deduction -> Salary & Wages Expense reduction
- Damage/shortage/penalty -> Employee Recoveries / Other Income
- Other deductions -> Payroll Deductions Payable

SMART DOUBLE-ENTRY ENGINE
-------------------------
- Every journal must have at least two non-zero lines.
- A line cannot contain both debit and credit.
- Total debit must equal total credit within 0.01.
- Module + ledger posting uses validation-before-save and module rollback if ledger writing fails.
- Manual IN/OUT transactions can infer a sensible account from the description when the account is left blank.
- Sales COGS is recalculated server-side.
- Negative bulk, chip and finished-goods movements are blocked.
- Conversion deletion is blocked when its piecework was already claimed in payroll or its chip stock was already consumed.
- RM purchase deletion is blocked when the material is already converted.
- Production deletion is blocked when the resulting finished goods are already sold/adjusted out.

PERFORMANCE V9
--------------
- Tailwind browser compiler removed.
- Static shared erp.min.css is used and cached across all pages.
- Heavy PDF, Chart and Excel libraries are lazy-loaded where possible.
- Each operational page requests only the modules it needs.
- Apps Script uses module-scoped server cache plus per-request sheet-data cache.
- Browser cache keys are versioned for CK SYS V2 so old database cache cannot leak into the new system.

VISUAL ERASE BUTTON
-------------------
The Eliminate All Data button is VISUAL ONLY.
It asks for ERASE ALL, shows the warning, counts 6 to 0, and displays All data are removed.
It does NOT send a database delete action.

DEPLOYMENT CHECKLIST
--------------------
1. Paste/replace Code.gs.
2. Save Apps Script.
3. Deploy > Manage deployments > Edit > New version > Deploy.
4. Keep Execute as: Me.
5. Set access according to your intended use.
6. Upload all five HTML files and erp.min.css together.
7. Open index.html.
8. If required, set the current Apps Script /exec URL in Settings.
9. Add one employee, one RM purchase and one conversion as a controlled test.
10. Confirm the Ledger tab has balanced entries before entering real data.

Version: ULTIMATE_ENTERPRISE_V9_CK_SYS_V2_SMART_LEDGER
