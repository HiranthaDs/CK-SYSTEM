/**
 * AR PLASTIC DATA ERP - Universal Backend
 * Version: ULTIMATE_ENTERPRISE_V9_CK_SYS_V2_SMART_LEDGER
 * Database: one Google Spreadsheet, multiple ERP tabs.
 *
 * Core controls
 *  - Bulk RM cannot be consumed directly by production.
 *  - Bulk RM -> chip conversion -> chip inventory -> production -> finished goods -> sales.
 *  - Piecework conversion wages are accrued once and cleared through payroll once.
 *  - Every finance transaction is validated as balanced before any ledger rows are saved.
 *  - GET supports module-scoped loading to reduce page load time.
 */

const APP_NAME = 'AR_PLASTIC_DATA_ERP';
const APP_VERSION = 'ULTIMATE_ENTERPRISE_V9_CK_SYS_V2_SMART_LEDGER';
const DB_SHEET_ID = '1iP9e07FzO9urxWOMa3vn5B4A9KNJ2VxybzGcHRaDcLI';
const DB_NAME = 'CK SYS V2';
const DB_PUBLIC_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTWK8NhX0h8BG1a1upLPvv0YLIYKAn8FL28hwE6eNQANEpP9vTqIrIugGGZudx5YwPmIY57w_JKkmd1/pub?output=csv';
const BUSINESS_TZ = 'Asia/Colombo';
const CACHE_PREFIX = 'cksys_v2_erp_v9_';
const CACHE_SECONDS = 180;
const DEFAULT_TABS = ['Employees', 'Conversions', 'Production', 'Sales', 'Ledger', 'Payroll', 'Adjustments', 'RM_Purchases'];
const DEFAULT_HEADERS = ['id', 'refId', 'date', 'module', 'type', 'category', 'account', 'name', 'description', 'debit', 'credit', 'amount', 'status', 'jsonData', 'metaJson', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'sourceModule'];
const MODULE_MAP = {
  employees: 'Employees', conversions: 'Conversions', production: 'Production', sales: 'Sales',
  financials: 'Ledger', payroll: 'Payroll', adjustments: 'Adjustments', rmPurchases: 'RM_Purchases'
};

let __ss = null;
let __sheetCache = {};
let __headerCache = {};
let __dataCache = {};

function ok_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
function now_() { return new Date().toISOString(); }
function uuid_() { return Utilities.getUuid(); }
function ref_(prefix) { return prefix + '-' + uuid_().substring(0, 8).toUpperCase(); }
function num_(v) { const n = Number(v); return isFinite(n) ? Math.round(n * 100) / 100 : 0; }
function abs_(v) { return Math.abs(num_(v)); }
function txt_(v) { return (v === null || v === undefined) ? '' : String(v).trim().replace(/[\r\n\t]+/g, ' '); }
function arr_(v) { return Array.isArray(v) ? v : []; }
function json_(v) { try { return JSON.stringify(v || {}); } catch (e) { return '{}'; } }
function parseJson_(v) { try { return v ? JSON.parse(v) : {}; } catch (e) { return {}; } }
function same_(a,b) { return String(a || '') === String(b || ''); }
function today_() { return Utilities.formatDate(new Date(), BUSINESS_TZ, 'yyyy-MM-dd'); }
function isoDate_(v) { const s = txt_(v); return s ? s.substring(0,10) : today_(); }
function monthKey_(v) { return isoDate_(v).substring(0,7); }
function meta_(sourceModule) { return json_({ app: APP_NAME, version: APP_VERSION, updatedAt: now_(), sourceModule: sourceModule || 'system' }); }
function getSS_() { if (!__ss) __ss = SpreadsheetApp.openById(DB_SHEET_ID); return __ss; }

function getSheet(tabName) {
  if (__sheetCache[tabName]) return __sheetCache[tabName];
  const ss = getSS_();
  let sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    sheet.getRange(1, 1, 1, DEFAULT_HEADERS.length).setValues([DEFAULT_HEADERS]);
    sheet.setFrozenRows(1);
    sheet.getRange(1,1,1,DEFAULT_HEADERS.length).setFontWeight('bold').setBackground('#e5e7eb');
  } else if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, DEFAULT_HEADERS.length).setValues([DEFAULT_HEADERS]);
    sheet.setFrozenRows(1);
  }
  ensureHeaders_(sheet);
  __sheetCache[tabName] = sheet;
  return sheet;
}

function ensureHeaders_(sheet) {
  const name = sheet.getName();
  if (__headerCache[name]) return __headerCache[name];
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  let headers = sheet.getRange(1,1,1,lastCol).getValues()[0].map(String).filter(Boolean);
  let changed = false;
  DEFAULT_HEADERS.forEach(h => { if (headers.indexOf(h) === -1) { headers.push(h); changed = true; } });
  if (changed || headers.length !== lastCol) sheet.getRange(1,1,1,headers.length).setValues([headers]);
  __headerCache[name] = headers;
  return headers;
}
function getHeaders_(sheet) { return ensureHeaders_(sheet); }
function ensureTabs_() { DEFAULT_TABS.forEach(getSheet); }

function getSheetData(tabName) {
  if (Object.prototype.hasOwnProperty.call(__dataCache, tabName)) return __dataCache[tabName];
  const sheet = getSheet(tabName);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) { __dataCache[tabName] = []; return __dataCache[tabName]; }
  const headers = getHeaders_(sheet);
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  __dataCache[tabName] = values.map(row => {
    const obj = {};
    headers.forEach((h,j) => obj[h] = row[j]);
    obj.parsedJson = parseJson_(obj.jsonData);
    return obj;
  });
  return __dataCache[tabName];
}

function clearDataCache_(tabName) { if (tabName) delete __dataCache[tabName]; else __dataCache = {}; }

function requestedModules_(e) {
  const raw = e && e.parameter ? txt_(e.parameter.modules) : '';
  if (!raw) return Object.keys(MODULE_MAP);
  const allowed = raw.split(',').map(x=>txt_(x)).filter(x=>MODULE_MAP[x]);
  return allowed.length ? Array.from(new Set(allowed)) : Object.keys(MODULE_MAP);
}
function cacheKey_(mods) { return CACHE_PREFIX + mods.slice().sort().join('_'); }
function safeCacheGet_(key) { try { const v = CacheService.getScriptCache().get(key); return v ? JSON.parse(v) : null; } catch(e) { return null; } }
function safeCachePut_(key, value) { try { const s=JSON.stringify(value); if (s.length < 90000) CacheService.getScriptCache().put(key,s,CACHE_SECONDS); } catch(e) {} }
function invalidate_() {
  try {
    const cache = CacheService.getScriptCache();
    const keys = [];
    const names = Object.keys(MODULE_MAP);
    keys.push(cacheKey_(names));
    Object.keys(MODULE_MAP).forEach(k=>keys.push(cacheKey_([k])));
    // Common page combinations.
    keys.push(cacheKey_(['employees','payroll','conversions']));
    keys.push(cacheKey_(['employees','production','rmPurchases','conversions']));
    keys.push(cacheKey_(['production','sales','adjustments']));
    keys.push(cacheKey_(['production','sales','adjustments','rmPurchases','conversions']));
    cache.removeAll(Array.from(new Set(keys)));
  } catch(e) {}
}

function doGet(e) {
  try {
    const mods = requestedModules_(e);
    const refresh = e && e.parameter && String(e.parameter.refresh) === 'true';
    const key = cacheKey_(mods);
    if (!refresh) {
      const cached = safeCacheGet_(key);
      if (cached) return ok_(cached);
    }
    const data = {};
    mods.forEach(k => data[k] = getSheetData(MODULE_MAP[k]));
    const response = { status:'success', app:APP_NAME, version:APP_VERSION, database:{name:DB_NAME,sheetId:DB_SHEET_ID,publicCsv:DB_PUBLIC_CSV_URL}, accountingBrain:'V9_RULE_ENGINE', serverTime:now_(), modules:mods, data:data };
    safeCachePut_(key,response);
    return ok_(response);
  } catch(err) {
    return ok_({ status:'error', message:String(err && err.message ? err.message : err), serverTime:now_() });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
    const payload = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
    const action = txt_(payload.action);
    const data = payload.data || {};
    let result;

    switch(action) {
      case 'ping': result={status:'success',version:APP_VERSION,database:DB_NAME,serverTime:now_()}; break;
      case 'bootstrap': ensureTabs_(); result={status:'success',version:APP_VERSION,database:DB_NAME,tabs:DEFAULT_TABS.slice(),serverTime:now_()}; break;
      case 'get_piecework': result={status:'success', rows:getAvailablePiecework_(data.employeeId, data.throughDate)}; break;

      case 'add_employee': result=saveModuleRow_('Employees',data,'employees'); break;
      case 'update_employee': result=updateModuleRow_('Employees',data.id,data,'employees'); break;
      case 'delete_employee': result=deleteRowById_('Employees',data.id); break;

      case 'add_rm_purchase': result=handleRMPurchase_(data); break;
      case 'update_rm_purchase': result=replaceWithRollback_('RM_Purchases',data,handleRMPurchase_); break;
      case 'delete_rm_purchase': result=deleteRMPurchaseSafe_(data); break;

      case 'add_conversion': result=handleConversion_(data); break;
      case 'update_conversion': result=replaceWithRollback_('Conversions',data,handleConversion_); break;
      case 'delete_conversion': result=deleteConversionSafe_(data); break;

      case 'add_production': result=handleProduction_(data); break;
      case 'update_production': result=replaceWithRollback_('Production',data,handleProduction_); break;
      case 'delete_production': result=deleteProductionSafe_(data); break;

      case 'add_sale': result=handleSale_(data); break;
      case 'update_sale': result=replaceWithRollback_('Sales',data,handleSale_); break;
      case 'delete_sale': result=deleteModuleAndLedger_('Sales',data.id,data.refId); break;

      case 'add_payroll': result=handlePayroll_(data); break;
      case 'update_payroll': result=replaceWithRollback_('Payroll',data,handlePayroll_); break;
      case 'delete_payroll': result=deleteModuleAndLedger_('Payroll',data.id,data.refId); break;

      case 'add_stock_adjustment': result=handleAdjustment_(data); break;
      case 'update_stock_adjustment': result=replaceWithRollback_('Adjustments',data,handleAdjustment_); break;
      case 'delete_stock_adjustment': result=deleteModuleAndLedger_('Adjustments',data.id,data.refId); break;

      case 'add_single_entry': result=handleSingleEntry_(payload); break;
      case 'update_single_entry': result=handleUpdateSingleEntry_(payload); break;
      case 'add_journal': result=handleJournal_(data); break;
      case 'delete_journal': result=deleteByRefId_('Ledger',data.refId); break;
      default: result={status:'error',message:'Unknown action: '+action};
    }
    invalidate_();
    return ok_(result);
  } catch(err) {
    return ok_({status:'error',message:String(err && err.message ? err.message : err),serverTime:now_()});
  } finally { try { lock.releaseLock(); } catch(e2){} }
}

function rowFromObject_(sheet,obj) { return getHeaders_(sheet).map(h => obj[h] !== undefined && obj[h] !== null ? obj[h] : ''); }
function appendObject_(sheet,obj) {
  const row=rowFromObject_(sheet,obj); const n=sheet.getLastRow()+1;
  sheet.getRange(n,1,1,row.length).setValues([row]);
  clearDataCache_(sheet.getName());
}
function saveModuleRow_(tabName,data,sourceModule) {
  const sheet=getSheet(tabName);
  const p=data.parsedJson || parseJson_(data.jsonData) || {};
  const id=txt_(data.id)||txt_(p.id)||uuid_();
  const refId=txt_(data.refId)||txt_(p.refId)||txt_(p.saleId)||makeModuleRef_(tabName,id);
  p.refId=p.refId||refId;
  const row=Object.assign({},data,{id,refId,date:txt_(data.date||p.date||new Date()),module:sourceModule||tabName.toLowerCase(),status:txt_(data.status||p.status||(p.payment&&p.payment.status)||''),jsonData:json_(p),metaJson:meta_(sourceModule||tabName.toLowerCase()),createdAt:txt_(data.createdAt)||now_(),updatedAt:now_(),sourceModule:sourceModule||tabName.toLowerCase()});
  appendObject_(sheet,row); return {status:'success',id,refId};
}
function makeModuleRef_(tabName,id) {
  const map={Employees:'EMP',Conversions:'CNV',Production:'PROD',Sales:'SALE',Payroll:'PAY',Adjustments:'ADJ',RM_Purchases:'RMP'};
  return (map[tabName]||'REC')+'-'+String(id||uuid_()).substring(0,8).toUpperCase();
}
function updateModuleRow_(tabName,id,data,sourceModule) {
  const sheet=getSheet(tabName), headers=getHeaders_(sheet), last=sheet.getLastRow();
  if(!id) return {status:'error',message:'Missing id'};
  if(last<=1) return {status:'error',message:'ID not found'};
  const values=sheet.getRange(2,1,last-1,headers.length).getValues(), idIndex=headers.indexOf('id');
  for(let i=0;i<values.length;i++) if(same_(values[i][idIndex],id)) {
    const current={}; headers.forEach((h,j)=>current[h]=values[i][j]);
    const p=data.parsedJson||parseJson_(data.jsonData)||parseJson_(current.jsonData);
    const row=Object.assign({},current,data,{id,refId:txt_(data.refId||current.refId||p.refId),jsonData:json_(p),metaJson:current.metaJson||meta_(sourceModule||tabName.toLowerCase()),updatedAt:now_(),sourceModule:sourceModule||current.sourceModule||tabName.toLowerCase()});
    sheet.getRange(i+2,1,1,headers.length).setValues([headers.map(h=>row[h]!==undefined&&row[h]!==null?row[h]:'')]);
    clearDataCache_(tabName);
    return {status:'success',id,refId:row.refId};
  }
  return {status:'error',message:'ID not found'};
}
function deleteRowById_(tabName,id) {
  if(!id) return {status:'error',message:'Missing id'};
  const sheet=getSheet(tabName), headers=getHeaders_(sheet), last=sheet.getLastRow(); if(last<=1) return {status:'success',deleted:false};
  const values=sheet.getRange(2,1,last-1,headers.length).getValues(), idx=headers.indexOf('id');
  for(let i=values.length-1;i>=0;i--) if(same_(values[i][idx],id)){sheet.deleteRow(i+2); clearDataCache_(tabName); return {status:'success',deleted:true};}
  return {status:'success',deleted:false};
}
function deleteByRefId_(tabName,refId) {
  if(!refId) return {status:'error',message:'Missing refId'};
  const sheet=getSheet(tabName), headers=getHeaders_(sheet), last=sheet.getLastRow(); if(last<=1) return {status:'success',deleted:0};
  const values=sheet.getRange(2,1,last-1,headers.length).getValues(), idx=headers.indexOf('refId'); let count=0;
  for(let i=values.length-1;i>=0;i--) if(same_(values[i][idx],refId)){sheet.deleteRow(i+2);count++;}
  if(count) clearDataCache_(tabName);
  return {status:'success',deleted:count};
}
function findRowById_(tabName,id){ return getSheetData(tabName).find(r=>same_(r.id,id))||null; }
function deleteModuleAndLedger_(tabName,id,refId){ let ref=txt_(refId); if(!ref&&id){const r=findRowById_(tabName,id);if(r)ref=txt_(r.refId);} const md=id?deleteRowById_(tabName,id):{deleted:false}; const ld=ref?deleteByRefId_('Ledger',ref):{deleted:0}; return {status:'success',moduleDeleted:!!md.deleted,ledgerDeleted:ld.deleted||0,refId:ref}; }
function appendObjects_(tabName,objects){const rows=arr_(objects);if(!rows.length)return;const sheet=getSheet(tabName),headers=getHeaders_(sheet),matrix=rows.map(o=>headers.map(h=>o[h]!==undefined&&o[h]!==null?o[h]:''));sheet.getRange(sheet.getLastRow()+1,1,matrix.length,headers.length).setValues(matrix);clearDataCache_(tabName);}
function replaceWithRollback_(tabName,data,handler){
  const old=findRowById_(tabName,data.id); if(!old)throw new Error('Record not found for update'); const oldRef=txt_(data.refId||old.refId), oldLedger=getSheetData('Ledger').filter(r=>same_(r.refId,oldRef));
  deleteModuleAndLedger_(tabName,data.id,oldRef);
  try{return handler(data);}catch(err){
    try{deleteRowById_(tabName,data.id);deleteByRefId_('Ledger',txt_(data.refId||oldRef));appendObjects_(tabName,[old]);appendObjects_('Ledger',oldLedger);}catch(restoreErr){}
    throw err;
  }
}

function normalizeEntry_(entry,refId,date,sourceModule,index){
  const debit=abs_(entry.debit), credit=abs_(entry.credit); if(debit>0&&credit>0) throw new Error('Ledger line cannot have both debit and credit: '+txt_(entry.account));
  const amount=debit||credit; if(amount<=0)return null; const type=debit>0?'Debit':'Credit'; const category=normalizeCategory_(entry.category,entry.account,type);
  return {id:uuid_(),refId,date:txt_(entry.date||date||new Date()),module:'finance',type,category,account:txt_(entry.account||'Unspecified Account'),name:txt_(entry.name||''),description:txt_(entry.description||''),debit,credit,amount,status:txt_(entry.status||'Posted'),sourceModule:txt_(sourceModule||entry.sourceModule||'finance'),createdAt:now_(),updatedAt:now_(),createdBy:txt_(entry.createdBy||'system'),updatedBy:txt_(entry.updatedBy||'system'),jsonData:json_(Object.assign({},entry,{debit,credit,amount,type,category,refId,lineNo:index+1})),metaJson:meta_(sourceModule)};
}
function buildBalancedLedgerRows_(entries,refId,date,sourceModule){
  const rows=arr_(entries).map((e,i)=>normalizeEntry_(e,refId,date,sourceModule,i)).filter(Boolean);
  if(rows.length<2)throw new Error('Every transaction must have at least 2 ledger lines. Ref: '+refId);
  const dr=num_(rows.reduce((s,r)=>s+num_(r.debit),0)), cr=num_(rows.reduce((s,r)=>s+num_(r.credit),0));
  if(Math.abs(dr-cr)>0.01)throw new Error('Unbalanced transaction blocked. Ref '+refId+' Dr='+dr+' Cr='+cr);
  return {rows,dr,cr};
}
function writeLedgerRows_(prepared,refId){
  const rows=prepared.rows||[]; if(!rows.length)throw new Error('No ledger rows to post: '+refId);
  const sheet=getSheet('Ledger'), headers=getHeaders_(sheet); const matrix=rows.map(r=>headers.map(h=>r[h]!==undefined&&r[h]!==null?r[h]:''));
  sheet.getRange(sheet.getLastRow()+1,1,matrix.length,headers.length).setValues(matrix); clearDataCache_('Ledger');
  return {status:'success',refId,lines:rows.length,debit:prepared.dr,credit:prepared.cr};
}
function postBalancedLedger_(entries,refId,date,sourceModule){ return writeLedgerRows_(buildBalancedLedgerRows_(entries,refId,date,sourceModule),refId); }
function saveModuleWithLedger_(tabName,data,sourceModule,entries,refId,date){
  const prepared=buildBalancedLedgerRows_(entries,refId,date,sourceModule);
  const saved=saveModuleRow_(tabName,data,sourceModule);
  try { writeLedgerRows_(prepared,refId); return saved; }
  catch(err){ try{ deleteRowById_(tabName,saved.id); deleteByRefId_('Ledger',refId); }catch(rollbackErr){} throw err; }
}
function normalizeCategory_(category,account,type){ const raw=txt_(category).toLowerCase(); if(/asset|inventory|cash|bank|receivable/.test(raw))return'Asset'; if(/liability|payable|loan|creditor/.test(raw))return'Liability'; if(/equity|capital|owner|retained/.test(raw))return'Equity'; if(/revenue|income|sales|gain/.test(raw))return'Revenue'; if(/expense|cost|cogs|loss|salary|wage|tax|overhead/.test(raw))return'Expense'; const a=txt_(account).toLowerCase(); if(/cash|bank|inventory|stock|receivable|debtor|asset|clearing/.test(a))return'Asset'; if(/payable|creditor|loan|liability/.test(a))return'Liability'; if(/capital|equity|retained|drawings/.test(a))return'Equity'; if(/sales|revenue|income|gain/.test(a))return'Revenue'; if(/cost|expense|salary|wage|cogs|loss|overhead|tax/.test(a))return'Expense'; return type==='Debit'?'Expense':'Revenue'; }
function paymentAccount_(method,mode){ const m=txt_(method).toLowerCase(); if(/bank|transfer|online/.test(m))return{category:'Asset',account:'Bank'}; if(/cash/.test(m))return{category:'Asset',account:'Cash'}; if(/cheque|check/.test(m))return{category:'Asset',account:'Cheque / Bank Clearing'}; if(/receivable|credit sale/.test(m))return{category:'Asset',account:'Accounts Receivable'}; if(/payable|credit purchase|supplier credit/.test(m))return{category:'Liability',account:'Accounts Payable'}; if(mode==='payable')return{category:'Liability',account:'Accounts Payable'}; return{category:'Asset',account:txt_(method||'Cash')}; }

// ---------- Smart accounting rule engine ----------
function deductionAccount_(deduction) {
  const text = (txt_(deduction.type) + ' ' + txt_(deduction.description)).toLowerCase();
  if (/advance|salary advance|staff advance|employee advance|loan recovery|loan repayment/.test(text)) return { category:'Asset', account:'Employee Advances & Loans Receivable' };
  if (/epf|pension|provident/.test(text)) return { category:'Liability', account:'EPF / Provident Fund Payable' };
  if (/etf/.test(text)) return { category:'Liability', account:'ETF Payable' };
  if (/paye|income tax|tax/.test(text)) return { category:'Liability', account:'Payroll Tax Payable' };
  if (/absence|no pay|nopay|late|lateness|unpaid leave/.test(text)) return { category:'Expense', account:'Salary & Wages Expense' };
  if (/damage|shortage|penalty|fine/.test(text)) return { category:'Revenue', account:'Employee Recoveries / Other Income' };
  return { category:'Liability', account:'Payroll Deductions Payable' };
}

function inferManualAccount_(direction, description, explicitAccount, explicitCategory) {
  if (txt_(explicitAccount)) return { account:txt_(explicitAccount), category:normalizeCategory_(explicitCategory, explicitAccount, direction === 'OUT' ? 'Debit' : 'Credit'), inferred:false };
  const d = txt_(description).toLowerCase();
  const out = direction === 'OUT';
  if (out) {
    if (/raw material|plastic|resin|material purchase/.test(d)) return {account:'Raw Material Inventory',category:'Asset',inferred:true};
    if (/machine|machinery|equipment|computer|vehicle|asset purchase/.test(d)) return {account:'Plant, Equipment & Other Assets',category:'Asset',inferred:true};
    if (/loan repay|loan payment|settle loan/.test(d)) return {account:'Loans Payable',category:'Liability',inferred:true};
    if (/salary|wage|payroll/.test(d)) return {account:'Salary & Wages Expense',category:'Expense',inferred:true};
    if (/rent/.test(d)) return {account:'Rent Expense',category:'Expense',inferred:true};
    if (/electric|water|utility|utilities|internet|telephone/.test(d)) return {account:'Utilities Expense',category:'Expense',inferred:true};
    if (/fuel|transport|delivery|courier|travel/.test(d)) return {account:'Transport & Fuel Expense',category:'Expense',inferred:true};
    if (/repair|maintenance|service/.test(d)) return {account:'Repairs & Maintenance Expense',category:'Expense',inferred:true};
    if (/tax|levy|license|licence|government/.test(d)) return {account:'Taxes, Licences & Levies',category:'Expense',inferred:true};
    if (/advert|marketing|promotion/.test(d)) return {account:'Advertising & Marketing Expense',category:'Expense',inferred:true};
    return {account:'General Operating Expense',category:'Expense',inferred:true};
  }
  if (/capital|owner investment|owner contribution/.test(d)) return {account:'Owner Capital',category:'Equity',inferred:true};
  if (/loan received|borrow|borrowing/.test(d)) return {account:'Loans Payable',category:'Liability',inferred:true};
  if (/sale|invoice|customer/.test(d)) return {account:'Sales Revenue',category:'Revenue',inferred:true};
  if (/interest/.test(d)) return {account:'Interest Income',category:'Revenue',inferred:true};
  if (/refund|rebate|other income|scrap/.test(d)) return {account:'Other Income',category:'Revenue',inferred:true};
  return {account:'Other Income',category:'Revenue',inferred:true};
}

function validateEmployeeForWork_(employeeId) {
  const row = findRowById_('Employees', employeeId);
  if (!row) throw new Error('Employee not found: ' + txt_(employeeId));
  const p = row.parsedJson || {};
  if (txt_(p.status).toLowerCase() === 'inactive') throw new Error('Inactive employee cannot be allocated: ' + txt_(p.name));
  return row;
}

// ---------- Inventory engines ----------
function bulkInventory_(){
  const out={};
  getSheetData('RM_Purchases').forEach(r=>{const p=r.parsedJson||{};const n=txt_(p.materialName);if(!n)return;if(!out[n])out[n]={name:n,totalIn:0,totalCost:0,totalOut:0,currentStock:0,avgCost:0};out[n].totalIn+=abs_(p.qty);out[n].totalCost+=abs_(p.totalCost);});
  getSheetData('Conversions').forEach(r=>{const p=r.parsedJson||{};const n=txt_(p.sourceMaterial&&p.sourceMaterial.name);if(n&&out[n])out[n].totalOut+=abs_(p.sourceMaterial.kg);});
  // Migration compatibility: V7 production consumed bulk RM directly. Keep those historical issues deducted.
  getSheetData('Production').forEach(r=>{const p=r.parsedJson||{},rm=p.rawMaterial||{};if(txt_(rm.stage).toUpperCase()==='CHIP')return;const n=txt_(rm.name);if(n&&out[n])out[n].totalOut+=abs_(rm.kg);});
  Object.keys(out).forEach(n=>{const x=out[n];x.currentStock=num_(x.totalIn-x.totalOut);x.avgCost=x.totalIn>0?num_(x.totalCost/x.totalIn):0;x.assetValue=num_(Math.max(0,x.currentStock)*x.avgCost);}); return out;
}
function chipInventory_(){
  const out={};
  getSheetData('Conversions').forEach(r=>{const p=r.parsedJson||{}; const c=p.chip||{}; const n=txt_(c.name||c.type); if(!n)return; if(!out[n])out[n]={name:n,type:txt_(c.type),totalIn:0,totalCost:0,totalOut:0,currentStock:0,avgCost:0}; out[n].totalIn+=abs_(c.outputKg); out[n].totalCost+=abs_(p.costing&&p.costing.totalConvertedCost);});
  getSheetData('Production').forEach(r=>{const p=r.parsedJson||{},rm=p.rawMaterial||{};if(txt_(rm.stage).toUpperCase()!=='CHIP')return;const n=txt_(rm.name);if(n&&out[n])out[n].totalOut+=abs_(rm.kg);});
  Object.keys(out).forEach(n=>{const x=out[n];x.currentStock=num_(x.totalIn-x.totalOut);x.avgCost=x.totalIn>0?num_(x.totalCost/x.totalIn):0;x.assetValue=num_(Math.max(0,x.currentStock)*x.avgCost);}); return out;
}

function finishedGoodsInventory_(){
  const out={};
  getSheetData('Production').forEach(r=>{const p=r.parsedJson||{},it=p.item||{},n=txt_(it.name);if(!n)return;if(!out[n])out[n]={name:n,totalIn:0,totalCost:0,totalOut:0,adjusted:0,currentStock:0,avgCost:0,assetValue:0};out[n].totalIn+=abs_(it.qty);out[n].totalCost+=abs_(p.costing&&p.costing.totalCost);});
  getSheetData('Sales').forEach(r=>arr_(r.parsedJson&&r.parsedJson.items).forEach(it=>{const n=txt_(it.itemName);if(n&&out[n])out[n].totalOut+=abs_(it.qty);}));
  getSheetData('Adjustments').forEach(r=>{const p=r.parsedJson||{},n=txt_(p.item);if(!n)return;if(!out[n])out[n]={name:n,totalIn:0,totalCost:0,totalOut:0,adjusted:0,currentStock:0,avgCost:0,assetValue:0};const q=abs_(p.qty);out[n].adjusted+=(txt_(p.type).toLowerCase()==='positive'?q:-q);});
  Object.keys(out).forEach(n=>{const x=out[n];x.currentStock=num_(x.totalIn-x.totalOut+x.adjusted);x.avgCost=x.totalIn>0?num_(x.totalCost/x.totalIn):0;x.assetValue=num_(Math.max(0,x.currentStock)*x.avgCost);});return out;
}
function allClaimedPiecework_(){const set={};getSheetData('Payroll').forEach(r=>arr_(r.parsedJson&&r.parsedJson.pieceworkClaims).forEach(c=>{if(c.workId)set[c.workId]=r.refId||r.id;}));return set;}
function deleteConversionSafe_(data){const row=findRowById_('Conversions',data.id);if(!row)return{status:'success',deleted:false};const p=row.parsedJson||{},claimed=allClaimedPiecework_();arr_(p.workers).forEach(w=>{if(w.workId&&claimed[w.workId])throw new Error('Cannot delete conversion: employee piecework has already been included in payroll ('+claimed[w.workId]+')');});const chips=chipInventory_(),n=txt_(p.chip&&p.chip.name),outKg=abs_(p.chip&&p.chip.outputKg);if(n&&chips[n]&&chips[n].currentStock-outKg<-0.001)throw new Error('Cannot delete conversion: its chip stock has already been consumed by production');return deleteModuleAndLedger_('Conversions',data.id,data.refId||row.refId);}
function deleteRMPurchaseSafe_(data){const row=findRowById_('RM_Purchases',data.id);if(!row)return{status:'success',deleted:false};const p=row.parsedJson||{},bulk=bulkInventory_(),n=txt_(p.materialName),q=abs_(p.qty);if(n&&bulk[n]&&bulk[n].currentStock-q<-0.001)throw new Error('Cannot delete raw-material purchase: part of this material has already been converted to chips');return deleteModuleAndLedger_('RM_Purchases',data.id,data.refId||row.refId);}
function deleteProductionSafe_(data){const row=findRowById_('Production',data.id);if(!row)return{status:'success',deleted:false};const p=row.parsedJson||{},fg=finishedGoodsInventory_(),n=txt_(p.item&&p.item.name),q=abs_(p.item&&p.item.qty);if(n&&fg[n]&&fg[n].currentStock-q<-0.001)throw new Error('Cannot delete production: finished goods from this production are already sold or adjusted out');return deleteModuleAndLedger_('Production',data.id,data.refId||row.refId);}

function handleRMPurchase_(data){
  const p=data.parsedJson||{}, id=txt_(data.id)||uuid_(), refId=txt_(data.refId||p.refId)||ref_('RMP'), date=txt_(data.date||p.date||new Date()); p.refId=refId; p.totalCost=abs_(p.totalCost); p.qty=abs_(p.qty); p.stockStage='BULK';
  if(!p.materialName)throw new Error('RM purchase needs materialName'); if(p.qty<=0)throw new Error('RM purchase quantity must be greater than 0'); if(p.totalCost<=0)throw new Error('RM purchase totalCost must be greater than 0');
  const credit=paymentAccount_(p.paymentMethod,'payable'); const entries=[{debit:p.totalCost,credit:0,category:'Asset',account:'Raw Material Inventory',description:'Bulk RM purchase: '+txt_(p.materialName)+' | Supplier: '+txt_(p.supplierName)},{debit:0,credit:p.totalCost,category:credit.category,account:credit.account,description:'Bulk RM purchase settlement: '+txt_(p.paymentMethod||'Accounts Payable')}]; return saveModuleWithLedger_('RM_Purchases',Object.assign({},data,{id,refId,date,parsedJson:p}),'rm_purchase',entries,refId,date);
}

function handleConversion_(data){
  const p=data.parsedJson||{}, id=txt_(data.id)||uuid_(), refId=txt_(data.refId||p.refId)||ref_('CNV'), date=txt_(data.date||p.date||new Date()); p.refId=refId;
  p.sourceMaterial=p.sourceMaterial||{}; p.chip=p.chip||{}; p.costing=p.costing||{};
  const sourceName=txt_(p.sourceMaterial.name), inputKg=abs_(p.sourceMaterial.kg), outputKg=abs_(p.chip.outputKg), overhead=abs_(p.costing.overheadCost);
  if(!sourceName)throw new Error('Conversion requires a bulk source material'); if(inputKg<=0||outputKg<=0)throw new Error('Conversion input/output kg must be greater than 0'); if(outputKg>inputKg*1.02)throw new Error('Converted chip output cannot exceed bulk input beyond tolerance');
  const bulk=bulkInventory_(), stock=bulk[sourceName]; if(!stock)throw new Error('Bulk material not found: '+sourceName); if(inputKg>stock.currentStock+0.001)throw new Error('Insufficient bulk stock. Available '+stock.currentStock+' Kg');
  const materialCost=num_(inputKg*stock.avgCost);
  const workers=arr_(p.workers).map((w,i)=>{const qty=abs_(w.qty),rate=abs_(w.rate),amount=num_(qty*rate || w.amount); if(!txt_(w.employeeId))throw new Error('Worker '+(i+1)+' is missing employee'); validateEmployeeForWork_(w.employeeId); if(amount<=0)throw new Error('Worker '+(i+1)+' piecework amount must be greater than 0'); return {workId:txt_(w.workId)||refId+'-W'+(i+1),employeeId:txt_(w.employeeId),employeeName:txt_(w.employeeName),task:txt_(w.task||p.chip.type||'Chip conversion'),qty,rate,amount};});
  if(!workers.length)throw new Error('Allocate at least one employee to chip conversion');
  const laborTotal=num_(workers.reduce((s,w)=>s+w.amount,0)), totalConvertedCost=num_(materialCost+laborTotal+overhead);
  p.sourceMaterial.unitCost=stock.avgCost; p.sourceMaterial.cost=materialCost; p.chip.name=txt_(p.chip.name||((p.chip.type||sourceName)+' Chips')); p.chip.outputKg=outputKg; p.chip.wasteKg=num_(Math.max(0,inputKg-outputKg)); p.chip.unitCost=num_(totalConvertedCost/outputKg); p.workers=workers; p.costing={materialCost,laborCost:laborTotal,overheadCost:overhead,totalConvertedCost}; p.stockStage='CHIP_CONVERSION';
  const entries=[{debit:totalConvertedCost,credit:0,category:'Asset',account:'Converted Chip Inventory',description:'Chip conversion complete: '+p.chip.name},{debit:0,credit:materialCost,category:'Asset',account:'Raw Material Inventory',description:'Bulk material issued to chip conversion: '+sourceName}];
  if(laborTotal>0)entries.push({debit:0,credit:laborTotal,category:'Liability',account:'Piecework Wages Payable',description:'Accrued chip conversion wages: '+p.chip.name}); if(overhead>0)entries.push({debit:0,credit:overhead,category:'Liability',account:'Conversion Overhead Payable',description:'Conversion overhead accrued'});
  const saved=saveModuleWithLedger_('Conversions',Object.assign({},data,{id,refId,date,parsedJson:p}),'conversion',entries,refId,date); return Object.assign({},saved,{chipUnitCost:p.chip.unitCost,laborTotal});
}

function handleProduction_(data){
  const p=data.parsedJson||{}, id=txt_(data.id)||uuid_(), refId=txt_(data.refId||p.refId)||ref_('PROD'), date=txt_(data.date||p.date||new Date()); p.refId=refId; p.rawMaterial=p.rawMaterial||{}; p.costing=p.costing||{};
  const chipName=txt_(p.rawMaterial.name), chipKg=abs_(p.rawMaterial.kg), qty=abs_(p.item&&p.item.qty), overhead=abs_(p.costing.overheadCost); if(!chipName)throw new Error('Production must consume converted chip stock'); if(chipKg<=0)throw new Error('Chip quantity must be greater than 0'); if(!p.item||!p.item.name)throw new Error('Production needs finished item name'); if(qty<=0)throw new Error('Production quantity must be greater than 0');
  const chips=chipInventory_(), stock=chips[chipName]; if(!stock)throw new Error('Selected material is not converted chip stock: '+chipName); if(chipKg>stock.currentStock+0.001)throw new Error('Insufficient converted chip stock. Available '+stock.currentStock+' Kg');
  const chipCost=num_(chipKg*stock.avgCost), total=num_(chipCost+overhead); if(total<=0)throw new Error('Production cost must be greater than 0'); p.rawMaterial.stage='CHIP'; p.rawMaterial.unitCost=stock.avgCost; p.rawMaterial.cost=chipCost; p.costing.laborCost=0; p.costing.materialCost=chipCost; p.costing.overheadCost=overhead; p.costing.totalCost=total; p.item.unitCost=num_(total/qty); p.item.finishedGoodsValue=total;
  const entries=[{debit:total,credit:0,category:'Asset',account:'Finished Goods Inventory',description:'Production complete: '+txt_(p.item.name)},{debit:0,credit:chipCost,category:'Asset',account:'Converted Chip Inventory',description:'Converted chip consumed: '+chipName}]; if(overhead>0)entries.push({debit:0,credit:overhead,category:'Liability',account:'Factory Overhead Payable',description:'Factory overhead apportioned'});
  return saveModuleWithLedger_('Production',Object.assign({},data,{id,refId,date,parsedJson:p}),'production',entries,refId,date);
}

function handleSale_(data){
  const p=data.parsedJson||{}, id=txt_(data.id)||uuid_(), refId=txt_(data.refId||p.refId||p.saleId)||ref_('SALE'), date=txt_(data.date||p.date||new Date()); p.refId=refId;p.saleId=p.saleId||refId;
  const items=arr_(p.items);if(!items.length)throw new Error('Sale needs at least one item');
  const fg=finishedGoodsInventory_(), remaining={};Object.keys(fg).forEach(n=>remaining[n]=fg[n].currentStock);
  let revenue=0,cogs=0;
  items.forEach((it,i)=>{const n=txt_(it.itemName),q=abs_(it.qty),line=abs_(it.lineTotal);if(!n||q<=0)throw new Error('Sale line '+(i+1)+' is incomplete');if(!fg[n])throw new Error('Finished good not found in inventory: '+n);if(q>(remaining[n]||0)+0.001)throw new Error('Insufficient finished stock for '+n+'. Available '+num_(remaining[n]||0));remaining[n]=num_((remaining[n]||0)-q);it.unitCost=fg[n].avgCost;it.lineCost=num_(q*fg[n].avgCost);revenue+=line;cogs+=it.lineCost;});
  revenue=num_(revenue);cogs=num_(cogs);if(revenue<=0)throw new Error('Invoice revenue must be greater than 0');
  const paid=Math.min(abs_(p.payment&&p.payment.paid),revenue),due=Math.max(0,num_(revenue-paid));p.payment=p.payment||{};p.payment.paid=paid;p.payment.due=due;p.payment.status=due<=0.01?'Paid':'Due';p.items=items;p.cogs=cogs;
  const entries=[];if(paid>0){const acc=paymentAccount_(p.payment.method,'receivable');entries.push({debit:paid,credit:0,category:acc.category,account:acc.account,description:'Invoice payment received: '+txt_(p.invoiceNo)});}if(due>0)entries.push({debit:due,credit:0,category:'Asset',account:'Accounts Receivable',description:'Invoice balance due: '+txt_(p.invoiceNo)});entries.push({debit:0,credit:revenue,category:'Revenue',account:'Sales Revenue',description:'Sales invoice: '+txt_(p.invoiceNo)});if(cogs>0){entries.push({debit:cogs,credit:0,category:'Expense',account:'Cost of Goods Sold',description:'COGS for invoice: '+txt_(p.invoiceNo)});entries.push({debit:0,credit:cogs,category:'Asset',account:'Finished Goods Inventory',description:'Inventory issued for sale: '+txt_(p.invoiceNo)});}const saved=saveModuleWithLedger_('Sales',Object.assign({},data,{id,refId,date,parsedJson:p}),'sales',entries,refId,date);return Object.assign({},saved,{cogs});
}

// ---------- Piecework + payroll ----------
function claimedWorkIds_(){ const set={}; getSheetData('Payroll').forEach(r=>arr_(r.parsedJson&&r.parsedJson.pieceworkClaims).forEach(c=>{if(c.workId)set[c.workId]=r.refId||r.id;})); return set; }
function getAvailablePiecework_(employeeId,throughDate){
  const emp=txt_(employeeId), end=isoDate_(throughDate||new Date()), claimed=claimedWorkIds_(), rows=[];
  getSheetData('Conversions').forEach(r=>{const p=r.parsedJson||{}; if(isoDate_(r.date)>end)return; arr_(p.workers).forEach(w=>{if(same_(w.employeeId,emp)&&!claimed[w.workId]) rows.push({workId:w.workId,conversionRef:r.refId,date:isoDate_(r.date),employeeId:emp,employeeName:w.employeeName,task:w.task,qty:abs_(w.qty),rate:abs_(w.rate),amount:abs_(w.amount),chipName:p.chip&&p.chip.name});});}); return rows.sort((a,b)=>a.date.localeCompare(b.date));
}
function earningAccount_(type){ const t=txt_(type).toLowerCase(); if(/daily/.test(t))return'Daily Wages Expense'; if(/overtime|ot/.test(t))return'Overtime Wages Expense'; if(/increment/.test(t))return'Salary Increment Expense'; if(/allowance|bonus/.test(t))return'Allowances & Bonus Expense'; return'Salary & Wages Expense'; }
function handlePayroll_(data){
  const p=data.parsedJson||{}, id=txt_(data.id)||uuid_(), refId=txt_(data.refId||p.refId)||ref_('PAY'), date=txt_(data.date||p.date||new Date()); p.refId=refId; if(!p.employeeId)throw new Error('Payroll requires employeeId'); validateEmployeeForWork_(p.employeeId);
  let earnings=arr_(p.earnings).map((x,i)=>({id:txt_(x.id)||'E'+(i+1),type:txt_(x.type||'Earning'),description:txt_(x.description||x.type||'Earning'),qty:abs_(x.qty),rate:abs_(x.rate),amount:abs_(x.amount),account:txt_(x.account||earningAccount_(x.type))})).filter(x=>x.amount>0);
  // Backward compatibility with V7 payroll payloads.
  if(!earnings.length){ if(abs_(p.base)>0)earnings.push({id:'BASE',type:'Monthly Salary',description:'Monthly/Base Salary',qty:1,rate:abs_(p.base),amount:abs_(p.base),account:'Salary & Wages Expense'}); if(abs_(p.otAmount)>0)earnings.push({id:'OT',type:'Overtime',description:'Overtime',qty:abs_(p.otHrs),rate:abs_(p.otRate),amount:abs_(p.otAmount),account:'Overtime Wages Expense'}); if(abs_(p.allowance)>0)earnings.push({id:'ALLW',type:'Allowance',description:'Allowances / Bonuses',qty:1,rate:abs_(p.allowance),amount:abs_(p.allowance),account:'Allowances & Bonus Expense'}); }
  let deductions=arr_(p.deductions).map((x,i)=>{const ai=txt_(x.account)?{account:txt_(x.account),category:normalizeCategory_(x.category,x.account,'Credit')}:deductionAccount_(x);return{id:txt_(x.id)||'D'+(i+1),type:txt_(x.type||'Deduction'),description:txt_(x.description||x.type||'Deduction'),amount:abs_(x.amount),account:ai.account,category:ai.category};}).filter(x=>x.amount>0); if(!deductions.length&&abs_(p.deduct)>0)deductions=[{id:'DED',type:'Deduction',description:'Payroll deductions',amount:abs_(p.deduct),account:'Payroll Deductions Payable',category:'Liability'}];
  const available=getAvailablePiecework_(p.employeeId,date), availMap={}; available.forEach(x=>availMap[x.workId]=x); let claims=arr_(p.pieceworkClaims); if(p.includeAllPiecework===true&&!claims.length)claims=available; claims=claims.map(c=>{const valid=availMap[c.workId]; if(!valid)throw new Error('Piecework claim is unavailable or already paid: '+txt_(c.workId)); return valid;});
  const regularGross=num_(earnings.reduce((s,x)=>s+x.amount,0)), pieceworkTotal=num_(claims.reduce((s,x)=>s+x.amount,0)), gross=num_(regularGross+pieceworkTotal), deduct=num_(deductions.reduce((s,x)=>s+x.amount,0)), net=num_(gross-deduct); if(gross<=0)throw new Error('Payroll gross amount must be greater than 0'); if(net<0)throw new Error('Payroll deductions cannot exceed gross earnings');
  p.earnings=earnings;p.deductions=deductions;p.pieceworkClaims=claims;p.regularGross=regularGross;p.pieceworkTotal=pieceworkTotal;p.grossPay=gross;p.deduct=deduct;p.netPay=net;p.salaryMonth=txt_(p.salaryMonth||monthKey_(date));
  const entries=[]; earnings.forEach(x=>entries.push({debit:x.amount,credit:0,category:'Expense',account:x.account,description:x.description+' - '+txt_(p.employeeName)})); if(pieceworkTotal>0)entries.push({debit:pieceworkTotal,credit:0,category:'Liability',account:'Piecework Wages Payable',description:'Clear accrued chip conversion wages - '+txt_(p.employeeName)}); deductions.forEach(x=>entries.push({debit:0,credit:x.amount,category:x.category||'Liability',account:x.account,description:x.description+' - '+txt_(p.employeeName)}));
  if(txt_(p.status).toLowerCase()==='payable')entries.push({debit:0,credit:net,category:'Liability',account:'Salary Payable',description:'Payroll payable: '+txt_(p.employeeName)}); else {const acc=paymentAccount_(p.paymentMethod,'cash');entries.push({debit:0,credit:net,category:acc.category,account:acc.account,description:'Payroll paid: '+txt_(p.employeeName)});}
  const saved=saveModuleWithLedger_('Payroll',Object.assign({},data,{id,refId,date,parsedJson:p}),'payroll',entries,refId,date);return Object.assign({},saved,{grossPay:gross,netPay:net,pieceworkTotal});
}

function handleAdjustment_(data){const p=data.parsedJson||{},id=txt_(data.id)||uuid_(),refId=txt_(data.refId||p.refId)||ref_('ADJ'),date=txt_(data.date||p.date||new Date());p.refId=refId;const val=abs_(p.value),qty=abs_(p.qty);if(!p.item)throw new Error('Adjustment needs item');if(val<=0||qty<=0)throw new Error('Adjustment quantity and value must be greater than 0');const positive=txt_(p.type).toLowerCase()==='positive';if(!positive){const fg=finishedGoodsInventory_(),stock=fg[txt_(p.item)];if(!stock||qty>stock.currentStock+0.001)throw new Error('Stock loss blocked: only '+num_(stock?stock.currentStock:0)+' units are available for '+txt_(p.item));}const entries=positive?[{debit:val,credit:0,category:'Asset',account:'Finished Goods Inventory',description:'Stock adjustment gain: '+txt_(p.item)},{debit:0,credit:val,category:'Revenue',account:'Inventory Adjustment Gain',description:txt_(p.notes||'Manual adjustment')}]:[{debit:val,credit:0,category:'Expense',account:'Inventory Adjustment Loss',description:txt_(p.notes||'Manual adjustment')},{debit:0,credit:val,category:'Asset',account:'Finished Goods Inventory',description:'Stock adjustment loss: '+txt_(p.item)}];return saveModuleWithLedger_('Adjustments',Object.assign({},data,{id,refId,date,parsedJson:p}),'inventory',entries,refId,date);}
function handleSingleEntry_(payload){
  const data=payload.data||{},p=data.parsedJson||{},refId=txt_(data.refId||p.refId)||ref_('ENT'),date=txt_(p.date||data.date||today_());
  p.refId=refId;p.doubleEntry=true;
  let entries=arr_(p.entries);
  if(!entries.length){
    const amount=abs_(p.amount||p.totalAmount),direction=txt_(payload.direction).toUpperCase();
    if(amount<=0) throw new Error('Amount must be greater than 0');
    if(direction!=='OUT'&&direction!=='IN') throw new Error('Manual entry direction must be IN or OUT');
    const target=inferManualAccount_(direction,p.description,p.account,p.category);
    const offset=paymentAccount_(p.method,direction==='OUT'?'payable':'receivable');
    p.account=target.account;p.category=target.category;p.accountingInference={engine:'V9_RULE_ENGINE',inferred:target.inferred,targetAccount:target.account,targetCategory:target.category,offsetAccount:offset.account};
    if(direction==='OUT') entries=[{debit:amount,credit:0,category:target.category,account:target.account,description:p.description},{debit:0,credit:amount,category:offset.category,account:offset.account,description:'Offset: '+txt_(p.method||offset.account)}];
    else entries=[{debit:amount,credit:0,category:offset.category,account:offset.account,description:'Offset: '+txt_(p.method||offset.account)},{debit:0,credit:amount,category:target.category,account:target.account,description:p.description}];
  }
  const normalized=entries.map(e=>({debit:abs_(e.debit),credit:abs_(e.credit),category:e.category,account:e.account,description:e.description||p.description,date:e.date||date}));
  p.entries=normalized;postBalancedLedger_(normalized,refId,date,'manual_entry');return{status:'success',refId,accountingInference:p.accountingInference||null};
}
function handleUpdateSingleEntry_(payload){const refId=payload&&payload.data?txt_(payload.data.refId||(payload.data.parsedJson&&payload.data.parsedJson.refId)):'';if(refId)deleteByRefId_('Ledger',refId);return handleSingleEntry_(payload);}
function handleJournal_(data){const p=data.parsedJson||{},refId=txt_(data.refId||p.refId)||ref_('JRN'),date=txt_(p.date||data.date||new Date()),memo=txt_(p.memo||data.description||'Journal Entry'),entries=arr_(p.entries).map(e=>({debit:abs_(e.debit),credit:abs_(e.credit),category:e.category,account:e.account,description:memo,date}));postBalancedLedger_(entries,refId,date,'journal');return{status:'success',refId};}
