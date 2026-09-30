import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Controller, useFieldArray, useForm, type Resolver, type UseFieldArrayReturn, type UseFormReturn } from 'react-hook-form'
import { useEffect, useState } from 'react'
import { Banknote, BriefcaseBusiness, CalendarCheck, Clock3, Download, FileBarChart, MessageCircle, Pencil, Plus, Printer, ReceiptText, RotateCcw, Trash2, UserRound, Users } from 'lucide-react'
import { z } from 'zod'
import { api } from '../lib/api'
import { localIsoDate, localIsoMonth, money, monthLabel, numberValue, quantity, shortDate, titleCase } from '../lib/format'
import { downloadPayrollExcel } from '../lib/payrollReportExport'
import { payrollWhatsAppMessage } from '../lib/payrollMessage'
import { normalizeWhatsAppPhone } from '../lib/salesInvoice'
import type { DailyWork, Employee, MutationReceipt, OpenEarning, OvertimeRecord, Page, Payment, Payroll, PayrollLine } from '../types/api'
import { useAppContext } from '../layout/AppShell'
import { useToast } from '../components/Toast'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { RemoteSelect } from '../components/RemoteSelect'
import { ManualSelect } from '../components/ManualSelect'
import { payrollEmployeeDisplay } from './employeesPayroll'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Pagination,
  SearchBox,
  SectionTitle,
  Select,
  TableWrap,
  Tabs,
  Textarea,
} from '../components/UI'

type StaffTab = 'employees' | 'daily-work' | 'overtime' | 'earnings' | 'payroll' | 'report'
const pageSize = 30
const paymentMethods = ['cash', 'bank_transfer', 'cheque', 'salary_payable', 'other'] as const
const payrollSettlementMethods = ['cash', 'bank_transfer', 'cheque', 'other'] as const

const staffOptions = {
  job_role: ['Manager', 'Supervisor', 'Office assistant', 'Accountant', 'Machine operator', 'Production worker', 'Driver', 'Storekeeper'],
  employment_type: ['Permanent', 'Contract', 'Temporary', 'Casual', 'Part time'],
  shift: ['Day', 'Night', 'Rotating', 'Flexible'],
  bank_name: ['Bank of Ceylon', 'Peoples Bank', 'Commercial Bank', 'Hatton National Bank', 'Sampath Bank', 'Seylan Bank', 'National Savings Bank'],
}
const lineTypes = {
  earning: ['monthly_salary', 'attendance_allowance', 'transport_allowance', 'meal_allowance', 'bonus', 'commission'],
  deduction: ['employee_epf', 'salary_advance', 'loan_repayment', 'no_pay', 'tax', 'other_deduction'],
  contribution: ['employer_epf', 'employer_etf', 'insurance', 'other_contribution'],
}
const payrollAccounts = {
  earning: ['WAGES_EXPENSE'] as const,
  deduction: ['PAYROLL_DEDUCTIONS_PAYABLE'] as const,
  contribution: ['EMPLOYER_CONTRIBUTION_PAYABLE'] as const,
}

const employeeSchema = z.object({
  employee_no: z.string().max(40),
  name: z.string().min(1, 'Name is required.').max(160),
  nic: z.string().max(40),
  phone: z.string().max(40),
  address: z.string().max(500),
  epf_no: z.string().max(60),
  etf_ref: z.string().max(60),
  joined_date: z.string().min(1, 'Joined date is required.'),
  left_date: z.string(),
  job_role: z.string().max(100),
  employment_type: z.string().max(60),
  shift: z.string().max(60),
  pay_model: z.enum(['monthly', 'daily', 'hybrid', 'piecework']),
  monthly_rate: z.coerce.number().min(0),
  daily_rate: z.coerce.number().min(0),
  ot_rate: z.coerce.number().min(0),
  daily_on_conversion: z.boolean(),
  bank_name: z.string().max(100),
  bank_branch: z.string().max(100),
  bank_account_name: z.string().max(160),
  bank_account_number: z.string().max(80),
  status: z.enum(['active', 'inactive']),
}).superRefine((value, context) => {
  if (value.left_date && value.left_date < value.joined_date) context.addIssue({ code: 'custom', path: ['left_date'], message: 'Left date cannot be before joined date.' })
  if ((value.pay_model === 'monthly' || value.pay_model === 'hybrid') && value.monthly_rate <= 0) context.addIssue({ code: 'custom', path: ['monthly_rate'], message: 'A monthly rate is required for this pay model.' })
  if ((value.pay_model === 'daily' || value.pay_model === 'hybrid') && value.daily_rate <= 0) context.addIssue({ code: 'custom', path: ['daily_rate'], message: 'A daily rate is required for this pay model.' })
})

const pieceworkSchema = z.object({
  task: z.string().min(1, 'Task is required.').max(160),
  quantity_kg: z.coerce.number().positive('Quantity must be positive.'),
  rate_per_kg: z.coerce.number().positive('Rate must be positive.'),
})

const dailyWorkSchema = z.object({
  employee_id: z.string().uuid('Select an employee.'),
  work_date: z.string().min(1, 'Select a work date.'),
  work_units: z.coerce.number().positive('Work units must be positive.'),
  daily_rate: z.coerce.number().positive('Daily rate must be positive.'),
  notes: z.string().max(2000),
  manual_piecework: z.array(pieceworkSchema).max(100),
})

const overtimeSchema = z.object({
  employee_id: z.string().uuid('Select an employee.'),
  work_date: z.string().min(1, 'Select an OT date.'),
  hours: z.coerce.number().positive('OT hours must be greater than 0.').max(24, 'OT hours cannot exceed 24 for one record.'),
  rate: z.coerce.number().positive('OT rate must be greater than 0.'),
  notes: z.string().max(1000),
  update_employee_rate: z.boolean(),
})


const payrollLineSchema = z.object({
  type: z.string().min(1, 'Type is required.').max(160),
  description: z.string().max(300),
  quantity: z.coerce.number().min(0),
  rate: z.coerce.number().min(0),
  amount: z.coerce.number().positive('Amount must be positive.'),
  account_code: z.string().max(40),
})

const payrollSchema = z.object({
  payroll_date: z.string().min(1),
  salary_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Select a salary month.'),
  employee_id: z.string().uuid('Select an employee.'),
  status: z.enum(['payable', 'paid']),
  payment_method: z.enum(paymentMethods),
  earnings: z.array(payrollLineSchema).max(200),
  deductions: z.array(payrollLineSchema.pick({ type: true, description: true, amount: true, account_code: true })).max(200),
  employer_contributions: z.array(payrollLineSchema.pick({ type: true, description: true, amount: true, account_code: true })).max(100),
  claim_ids: z.array(z.string()),
  overtime_ids: z.array(z.string()),
}).superRefine((value, context) => {
  if (!value.earnings.length && !value.claim_ids.length && !value.overtime_ids.length) context.addIssue({ code: 'custom', path: ['earnings'], message: 'Add an earning, select recorded work, or select overtime.' })
})

const paymentSchema = z.object({
  payment_date: z.string().min(1),
  amount: z.coerce.number().positive('Amount must be positive.'),
  method: z.enum(payrollSettlementMethods),
  notes: z.string().max(1000),
})

type EmployeeValues = z.infer<typeof employeeSchema>
type DailyWorkValues = z.infer<typeof dailyWorkSchema>
type OvertimeValues = z.infer<typeof overtimeSchema>
type PayrollValues = z.infer<typeof payrollSchema>
type PayrollPaymentValues = z.infer<typeof paymentSchema>

function employeePayload(values: EmployeeValues) {
  const bankDetails = {
    bank_name: values.bank_name.trim(),
    branch: values.bank_branch.trim(),
    account_name: values.bank_account_name.trim(),
    account_number: values.bank_account_number.trim(),
  }
  const hasBank = Object.values(bankDetails).some(Boolean)
  return {
    employee_no: values.employee_no || undefined,
    name: values.name,
    nic: values.nic || undefined,
    phone: values.phone || undefined,
    address: values.address || undefined,
    epf_no: values.epf_no || undefined,
    etf_ref: values.etf_ref || undefined,
    joined_date: values.joined_date,
    left_date: values.left_date || undefined,
    job_role: values.job_role || undefined,
    employment_type: values.employment_type || undefined,
    shift: values.shift || undefined,
    pay_model: values.pay_model,
    monthly_rate: values.monthly_rate || undefined,
    daily_rate: values.daily_rate || undefined,
    ot_rate: values.ot_rate || undefined,
    daily_on_conversion: values.daily_on_conversion,
    bank_details: hasBank ? bankDetails : undefined,
    status: values.status,
  }
}

function statusTone(status: string | null | undefined) {
  if (status === 'active' || status === 'posted' || status === 'paid') return 'success' as const
  if (status === 'partial' || status === 'payable') return 'warning' as const
  if (status === 'reversed' || status === 'inactive') return 'danger' as const
  return 'neutral' as const
}

function monthForYear(year: number, current = localIsoMonth()) {
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(current) ? current.slice(5) : '01'
  return `${year}-${month}`
}

export function EmployeesPage() {
  const { year, me } = useAppContext()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<StaffTab>('employees')
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [employeeOpen, setEmployeeOpen] = useState(false)
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null)
  const [deleteEmployee, setDeleteEmployee] = useState<Employee | null>(null)
  const [workOpen, setWorkOpen] = useState(false)
  const [editingWork, setEditingWork] = useState<DailyWork | null>(null)
  const [reverseWork, setReverseWork] = useState<DailyWork | null>(null)
  const [overtimeOpen, setOvertimeOpen] = useState(false)
  const [overtimeEmployee, setOvertimeEmployee] = useState<Employee | null>(null)
  const [overtimePrefillEmployee, setOvertimePrefillEmployee] = useState<Employee | null>(null)
  const [editingOvertime, setEditingOvertime] = useState<OvertimeRecord | null>(null)
  const [reverseOvertime, setReverseOvertime] = useState<OvertimeRecord | null>(null)
  const [payrollOpen, setPayrollOpen] = useState(false)
  const [editingPayroll, setEditingPayroll] = useState<Payroll | null>(null)
  const [paymentPayroll, setPaymentPayroll] = useState<Payroll | null>(null)
  const [reversePayroll, setReversePayroll] = useState<Payroll | null>(null)
  const [reversePayment, setReversePayment] = useState<{ payroll: Payroll; payment: Payment } | null>(null)
  const [profilePayroll, setProfilePayroll] = useState<Payroll | null>(null)
  const [postPayroll, setPostPayroll] = useState<Payroll | null>(null)
  const [postPayrollStep, setPostPayrollStep] = useState<'payment' | 'delivery'>('payment')
  const [reportMonthSelection, setReportMonthSelection] = useState(() => localIsoMonth())
  const reportMonth = monthForYear(year, reportMonthSelection)
  const [exportingPayroll, setExportingPayroll] = useState(false)

  const period = { from_date: `${year}-01-01`, to_date: `${year}-12-31` }
  const employeesQuery = useQuery({
    queryKey: ['employees', page, search],
    queryFn: ({ signal }) => api.list<Employee>('/employees', { page, page_size: pageSize, q: search, descending: false }, signal),
    enabled: tab === 'employees',
  })
  const dailyWorkQuery = useQuery({
    queryKey: ['daily-work', year, page],
    queryFn: ({ signal }) => api.list<DailyWork>('/daily-work', { ...period, page, page_size: pageSize }, signal),
    enabled: tab === 'daily-work',
  })
  const overtimeQuery = useQuery({
    queryKey: ['overtime', year, page],
    queryFn: ({ signal }) => api.list<OvertimeRecord>('/overtime', { ...period, page, page_size: pageSize, descending: true }, signal),
    enabled: tab === 'overtime',
  })
  const earningsQuery = useQuery({
    queryKey: ['open-earnings', year, page, search],
    queryFn: ({ signal }) => api.list<OpenEarning>('/open-earnings', { ...period, page, page_size: pageSize, q: search }, signal),
    enabled: tab === 'earnings',
  })
  const payrollQuery = useQuery({
    queryKey: ['payroll', year, page, search],
    queryFn: ({ signal }) => api.list<Payroll>('/payroll', { ...period, page, page_size: pageSize, q: search }, signal),
    enabled: tab === 'payroll',
  })
  const reportQuery = useQuery({
    queryKey: ['report', 'payroll', reportMonth, page, search],
    queryFn: async ({ signal }) => {
      // Keep the on-screen report aligned with the exported report: only current, posted
      // payroll for the exact selected salary month is allowed into this view.
      const allRows: Payroll[] = []
      for (let apiPage = 1; ; apiPage += 1) {
        const result = await api.list<Payroll>('/reports/payroll', {
          salary_month: reportMonth,
          status: 'posted',
          q: search,
          page: apiPage,
          page_size: 100,
          descending: false,
        }, signal)

        allRows.push(...result.items)
        if (apiPage >= Math.max(1, result.pages || 1)) break
      }

      const exactRows = allRows.filter((row) =>
        row.salary_month === reportMonth && row.status !== 'reversed'
      )

      const total = exactRows.length
      const pages = total ? Math.ceil(total / pageSize) : 0
      const safePage = pages ? Math.min(page, pages) : 1
      const start = (safePage - 1) * pageSize

      return {
        items: exactRows.slice(start, start + pageSize),
        page: safePage,
        page_size: pageSize,
        pages,
        total,
      } satisfies Page<Payroll>
    },
    enabled: tab === 'report' && Boolean(reportMonth),
  })

  const exportMonthlyPayroll = async () => {
    setExportingPayroll(true)
    try {
      const payrolls: Payroll[] = []
      let exportPage = 1
      let pages = 1
      do {
        const result = await api.list<Payroll>('/reports/payroll', {
          salary_month: reportMonth,
          status: 'posted',
          page: exportPage,
          page_size: 100,
          descending: false,
        })
        payrolls.push(...result.items.filter((row) =>
          row.salary_month === reportMonth && row.status !== 'reversed'
        ))
        pages = result.pages
        exportPage += 1
      } while (exportPage <= pages)
      if (!payrolls.length) {
        toast.error('Nothing to export', `No posted payroll exists for ${monthLabel(reportMonth)}.`)
        return
      }
      await downloadPayrollExcel(payrolls, reportMonth)
      toast.success('Monthly payroll downloaded', `${payrolls.length} posted employee payroll record${payrolls.length === 1 ? '' : 's'} included.`)
    } catch (error) {
      toast.error('Payroll export failed', error instanceof Error ? error.message : 'Try again.')
    } finally {
      setExportingPayroll(false)
    }
  }

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['employees'] }),
      queryClient.invalidateQueries({ queryKey: ['daily-work'] }),
      queryClient.invalidateQueries({ queryKey: ['overtime'] }),
      queryClient.invalidateQueries({ queryKey: ['open-earnings'] }),
      queryClient.invalidateQueries({ queryKey: ['payroll'] }),
      queryClient.invalidateQueries({ queryKey: ['payroll-outstanding'] }),
      queryClient.invalidateQueries({ queryKey: ['report', 'payroll'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    ])
  }

  const employeeMutation = useMutation({
    mutationFn: ({ id, values }: { id?: string | undefined; values: EmployeeValues }) => {
      const body = employeePayload(values)
      return id ? api.patch<MutationReceipt, typeof body>(`/employees/${id}`, body) : api.post<MutationReceipt, typeof body>('/employees', body)
    },
    onSuccess: async () => { setEmployeeOpen(false); setEditingEmployee(null); await invalidate(); toast.success('Employee saved', 'The staff master is current.') },
    onError: (error) => toast.error('Employee was not saved', error instanceof Error ? error.message : 'Try again.'),
  })
  const employeeDeleteMutation = useMutation({
    mutationFn: (employee: Employee) => api.delete<MutationReceipt>(`/employees/${employee.id}`),
    onSuccess: async () => { setDeleteEmployee(null); await invalidate(); toast.success('Employee deactivated') },
    onError: (error) => toast.error('Employee could not be deactivated', error instanceof Error ? error.message : 'Try again.'),
  })
  const workMutation = useMutation({
    mutationFn: ({ id, body }: { id?: string | undefined; body: DailyWorkValues }) => id ? api.patch<MutationReceipt, DailyWorkValues>(`/daily-work/${id}`, body) : api.post<MutationReceipt, DailyWorkValues>('/daily-work', body),
    onSuccess: async () => { setWorkOpen(false); setEditingWork(null); await invalidate(); toast.success('Daily work saved', 'Open payroll earnings were recalculated.') },
    onError: (error) => toast.error('Daily work was not saved', error instanceof Error ? error.message : 'Try again.'),
  })
  const reverseWorkMutation = useMutation({
    mutationFn: (work: DailyWork) => api.delete<MutationReceipt, { reason: string }>(`/daily-work/${work.id}`, { reason: 'Reversed from staff workspace' }),
    onSuccess: async () => { setReverseWork(null); await invalidate(); toast.success('Daily work reversed') },
    onError: (error) => toast.error('Daily work could not be reversed', error instanceof Error ? error.message : 'Try again.'),
  })
  const overtimeMutation = useMutation({
    mutationFn: async ({ id, values, employee }: { id?: string | undefined; values: OvertimeValues; employee: Employee | null }) => {
      const { update_employee_rate, ...body } = values
      const saved = id
        ? await api.patch<MutationReceipt, typeof body>(`/overtime/${id}`, body)
        : await api.post<MutationReceipt, typeof body>('/overtime', body)

      if (update_employee_rate && employee && numberValue(employee.ot_rate) !== numberValue(values.rate)) {
        const terms = employeePayTerms(employee)
        terms.ot_rate = numberValue(values.rate)
        const employeeBody = employeePayload(employeeValuesWithPayTerms(employee, terms))
        await api.patch<MutationReceipt, typeof employeeBody>(`/employees/${employee.id}`, employeeBody)
      }
      return saved
    },
    onSuccess: async () => { setOvertimeOpen(false); setEditingOvertime(null); await invalidate(); toast.success('Overtime saved', 'The OT entry is ready for the employee payroll month.') },
    onError: (error) => toast.error('Overtime was not saved', error instanceof Error ? error.message : 'Try again.'),
  })
  const reverseOvertimeMutation = useMutation({
    mutationFn: (record: OvertimeRecord) => api.delete<MutationReceipt, { reason: string }>(`/overtime/${record.id}`, { reason: 'Reversed from overtime workspace' }),
    onSuccess: async () => { setReverseOvertime(null); await invalidate(); toast.success('Overtime reversed') },
    onError: (error) => toast.error('Overtime could not be reversed', error instanceof Error ? error.message : 'Try again.'),
  })
  const payrollMutation = useMutation({
    mutationFn: ({ id, body }: { id?: string | undefined; body: Omit<PayrollValues, 'claim_ids' | 'overtime_ids'> & { overtime_ids: string[]; daily_work_ids: string[]; conversion_worker_ids: string[]; manual_piecework_ids: string[] } }) => id ? api.patch<MutationReceipt, typeof body>(`/payroll/${id}`, body) : api.post<MutationReceipt, typeof body>('/payroll', body),
    onSuccess: async (receipt) => {
      setPayrollOpen(false)
      setEditingPayroll(null)
      await invalidate()
      toast.success('Payroll posted', 'Earnings, deductions, contributions, and claims were posted atomically.')
      if (!receipt.id) return
      try {
        const saved = await api.get<Payroll>(`/payroll/${receipt.id}`)
        setPostPayroll(saved)
        setPostPayrollStep(numberValue(saved.balance_due) > 0 ? 'payment' : 'delivery')
      } catch (error) {
        toast.error('Payroll saved, but the next-step prompt could not load', error instanceof Error ? error.message : 'Open the posted payroll to continue.')
      }
    },
    onError: (error) => toast.error('Payroll was not posted', error instanceof Error ? error.message : 'Try again.'),
  })
  const payrollPaymentMutation = useMutation({
    mutationFn: ({ payrollId, body }: { payrollId: string; body: PayrollPaymentValues }) => api.post<MutationReceipt, PayrollPaymentValues>(`/payroll/${payrollId}/payments`, body),
    onSuccess: async (_receipt, variables) => {
      setPaymentPayroll(null)
      await invalidate()
      toast.success('Payroll payment posted')
      if (!postPayroll || postPayroll.id !== variables.payrollId) return
      try {
        const saved = await api.get<Payroll>(`/payroll/${variables.payrollId}`)
        setPostPayroll(saved)
        setPostPayrollStep('delivery')
      } catch {
        setPostPayrollStep('delivery')
      }
    },
    onError: (error) => toast.error('Payment was not posted', error instanceof Error ? error.message : 'Try again.'),
  })
  const reversePayrollMutation = useMutation({
    mutationFn: (payroll: Payroll) => api.delete<MutationReceipt, { reason: string }>(`/payroll/${payroll.id}`, { reason: 'Reversed from payroll workspace' }),
    onSuccess: async () => { setReversePayroll(null); await invalidate(); toast.success('Payroll reversed') },
    onError: (error) => toast.error('Payroll could not be reversed', error instanceof Error ? error.message : 'Try again.'),
  })
  const reversePaymentMutation = useMutation({
    mutationFn: ({ payroll, payment }: { payroll: Payroll; payment: Payment }) => api.delete<MutationReceipt, { reason: string }>(`/payroll/${payroll.id}/payments/${payment.id}`, { reason: 'Payroll payment reversed from staff workspace' }),
    onSuccess: async () => { setReversePayment(null); setPaymentPayroll(null); await invalidate(); toast.success('Payroll payment reversed') },
    onError: (error) => toast.error('Payment could not be reversed', error instanceof Error ? error.message : 'Try again.'),
  })

  const changeTab = (value: StaffTab) => { setTab(value); setPage(1); setSearch('') }
  const tabItems = [
    { value: 'employees' as const, label: 'Employees', icon: Users },
    { value: 'daily-work' as const, label: 'Daily work', icon: CalendarCheck },
    { value: 'overtime' as const, label: 'OT hours', icon: Clock3 },
    { value: 'earnings' as const, label: 'Open earnings', icon: BriefcaseBusiness },
    { value: 'payroll' as const, label: 'Payroll', icon: ReceiptText },
    { value: 'report' as const, label: 'Payroll report', icon: FileBarChart },
  ]

  return (
    <div className="page-stack">
      <PageHeader eyebrow="People operations" title="Staff & payroll" description="Maintain employee terms, record daily work and OT hours, claim earnings once, and settle payroll." actions={<Button icon={Plus} onClick={() => { setEditingEmployee(null); setEmployeeOpen(true) }}>New employee</Button>} />
      <Tabs value={tab} onChange={changeTab} ariaLabel="Staff and payroll sections" items={tabItems} />

      {tab === 'employees' ? <EmployeeList query={employeesQuery} page={page} setPage={setPage} search={search} setSearch={(value) => { setSearch(value); setPage(1) }} onAdd={() => { setEditingEmployee(null); setEmployeeOpen(true) }} onOvertime={setOvertimeEmployee} onEdit={(row) => { setEditingEmployee(row); setEmployeeOpen(true) }} onDelete={setDeleteEmployee} /> : null}
      {tab === 'daily-work' ? <DailyWorkList query={dailyWorkQuery} page={page} setPage={setPage} onAdd={() => { setEditingWork(null); setWorkOpen(true) }} onEdit={(row) => { setEditingWork(row); setWorkOpen(true) }} onReverse={setReverseWork} /> : null}
      {tab === 'overtime' ? <OvertimeList query={overtimeQuery} page={page} setPage={setPage} onAdd={() => { setEditingOvertime(null); setOvertimePrefillEmployee(null); setOvertimeOpen(true) }} onEdit={(row) => { setEditingOvertime(row); setOvertimePrefillEmployee(null); setOvertimeOpen(true) }} onReverse={setReverseOvertime} /> : null}
      {tab === 'earnings' ? <EarningsList query={earningsQuery} page={page} setPage={setPage} search={search} setSearch={(value) => { setSearch(value); setPage(1) }} /> : null}
      {tab === 'payroll' || tab === 'report' ? (
        <PayrollList
          query={tab === 'report' ? reportQuery : payrollQuery}
          page={page}
          setPage={setPage}
          search={search}
          setSearch={(value) => { setSearch(value); setPage(1) }}
          report={tab === 'report'}
          reportMonth={reportMonth}
          onReportMonthChange={(value) => { setReportMonthSelection(value); setPage(1) }}
          exporting={exportingPayroll}
          onExport={() => void exportMonthlyPayroll()}
          onProfile={setProfilePayroll}
          onAdd={() => { setEditingPayroll(null); setPayrollOpen(true) }}
          onEdit={(row) => { setEditingPayroll(row); setPayrollOpen(true) }}
          onPayment={setPaymentPayroll}
          onReverse={setReversePayroll}
        />
      ) : null}

      <EmployeeDialog open={employeeOpen} record={editingEmployee} mutation={employeeMutation} onClose={() => { setEmployeeOpen(false); setEditingEmployee(null) }} />
      <DailyWorkDialog open={workOpen} record={editingWork} mutation={workMutation} onClose={() => { setWorkOpen(false); setEditingWork(null) }} />
      <EmployeeOvertimeDialog employee={overtimeEmployee} year={year} onAdd={() => { const employee = overtimeEmployee; setOvertimeEmployee(null); setEditingOvertime(null); setOvertimePrefillEmployee(employee); setOvertimeOpen(true) }} onEdit={(record) => { setOvertimeEmployee(null); setEditingOvertime(record); setOvertimePrefillEmployee(null); setOvertimeOpen(true) }} onReverse={(record) => { setOvertimeEmployee(null); setReverseOvertime(record) }} onClose={() => setOvertimeEmployee(null)} />
      <OvertimeDialog open={overtimeOpen} record={editingOvertime} initialEmployee={overtimePrefillEmployee} mutation={overtimeMutation} onClose={() => { setOvertimeOpen(false); setEditingOvertime(null); setOvertimePrefillEmployee(null) }} />
      <PayrollDialog open={payrollOpen} record={editingPayroll} mutation={payrollMutation} onClose={() => { setPayrollOpen(false); setEditingPayroll(null) }} />
      <PayrollPaymentDialog payroll={paymentPayroll} mutation={payrollPaymentMutation} onReverse={(payment) => { if (paymentPayroll) setReversePayment({ payroll: paymentPayroll, payment }) }} onClose={() => setPaymentPayroll(null)} />
      <PayrollPostFollowupDialog payroll={postPayroll} step={postPayrollStep} companyName={me.active_company_name} hidden={Boolean(paymentPayroll)} onPayLater={() => setPostPayrollStep('delivery')} onPayment={() => { if (postPayroll) setPaymentPayroll(postPayroll) }} onPrint={() => { if (postPayroll) setProfilePayroll(postPayroll); setPostPayroll(null) }} onDone={() => setPostPayroll(null)} />
      <EmployeePayrollProfileDialog key={profilePayroll?.id ?? 'no-paysheet'} payroll={profilePayroll} companyName={me.active_company_name} onClose={() => setProfilePayroll(null)} />
      <ConfirmDialog open={Boolean(deleteEmployee)} title="Deactivate this employee?" message={`${deleteEmployee?.name ?? 'This employee'} will no longer appear in active staff selections. Historical records remain intact.`} destructive confirmLabel="Deactivate" busy={employeeDeleteMutation.isPending} onCancel={() => setDeleteEmployee(null)} onConfirm={() => { if (deleteEmployee) employeeDeleteMutation.mutate(deleteEmployee) }} />
      <ConfirmDialog open={Boolean(reverseWork)} title="Reverse this daily-work record?" message="The record remains in the audit trail and any unclaimed earnings are removed." destructive confirmLabel="Post reversal" busy={reverseWorkMutation.isPending} onCancel={() => setReverseWork(null)} onConfirm={() => { if (reverseWork) reverseWorkMutation.mutate(reverseWork) }} />
      <ConfirmDialog open={Boolean(reverseOvertime)} title="Reverse this OT record?" message="The OT entry remains in the audit trail and can no longer be claimed by payroll." destructive confirmLabel="Reverse OT" busy={reverseOvertimeMutation.isPending} onCancel={() => setReverseOvertime(null)} onConfirm={() => { if (reverseOvertime) reverseOvertimeMutation.mutate(reverseOvertime) }} />
      <ConfirmDialog open={Boolean(reversePayroll)} title="Reverse this payroll?" message={`${reversePayroll?.reference_no ?? 'This payroll'} and its accounting effects will be offset; claimed work becomes available according to server rules.`} destructive confirmLabel="Post reversal" busy={reversePayrollMutation.isPending} onCancel={() => setReversePayroll(null)} onConfirm={() => { if (reversePayroll) reversePayrollMutation.mutate(reversePayroll) }} />
      <ConfirmDialog open={Boolean(reversePayment)} title="Reverse this payroll payment?" message={`${reversePayment?.payment.reference_no ?? 'This payment'} will remain visible and receive offsetting accounting entries.`} destructive confirmLabel="Reverse payment" busy={reversePaymentMutation.isPending} onCancel={() => setReversePayment(null)} onConfirm={() => { if (reversePayment) reversePaymentMutation.mutate(reversePayment) }} />
    </div>
  )
}

function EmployeeList({ query, page, setPage, search, setSearch, onAdd, onOvertime, onEdit, onDelete }: { query: ReturnType<typeof useQuery<Page<Employee>>>; page: number; setPage: (page: number) => void; search: string; setSearch: (value: string) => void; onAdd: () => void; onOvertime: (employee: Employee) => void; onEdit: (employee: Employee) => void; onDelete: (employee: Employee) => void }) {
  const rows = query.data?.items ?? []
  return <Card><SectionTitle title="Employee master" description="Pay terms and statutory references are read from Supabase at posting time." actions={<Button icon={Plus} onClick={onAdd}>New employee</Button>} /><div className="toolbar"><SearchBox value={search} onChange={setSearch} placeholder="Search employee name" /></div>{query.isLoading ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : rows.length ? <><TableWrap><table><thead><tr><th>Employee</th><th>Role / shift</th><th>Pay model</th><th className="numeric">Monthly</th><th className="numeric">Daily</th><th>Joined</th><th>Status</th><th /></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><strong>{row.name}</strong><span className="table-subtext mono">{row.employee_no || 'Not assigned'} · {row.nic || 'No NIC'}</span></td><td>{row.job_role || '—'}<span className="table-subtext">{row.shift || 'No shift'}</span></td><td>{titleCase(row.pay_model)}</td><td className="numeric">{money(row.monthly_rate)}</td><td className="numeric">{money(row.daily_rate)}</td><td>{shortDate(row.joined_date)}</td><td><Badge tone={statusTone(row.status)}>{titleCase(row.status)}</Badge></td><td><div className="row-actions"><Button size="small" variant="ghost" icon={Clock3} onClick={() => onOvertime(row)}>OT details</Button><Button size="small" variant="ghost" icon={Pencil} onClick={() => onEdit(row)}>Edit</Button><Button size="small" variant="ghost" icon={Trash2} disabled={row.status === 'inactive'} onClick={() => onDelete(row)}>Deactivate</Button></div></td></tr>)}</tbody></table></TableWrap><Pagination page={query.data?.page ?? page} pages={query.data?.pages ?? 0} total={query.data?.total ?? 0} onChange={setPage} /></> : <EmptyState message="No employees match the search." action={<Button icon={Plus} onClick={onAdd}>Add first employee</Button>} />}</Card>
}

function EmployeeOvertimeDialog({ employee, year, onAdd, onEdit, onReverse, onClose }: {
  employee: Employee | null
  year: number
  onAdd: () => void
  onEdit: (record: OvertimeRecord) => void
  onReverse: (record: OvertimeRecord) => void
  onClose: () => void
}) {
  const query = useQuery({
    queryKey: ['overtime', 'employee-profile', employee?.id, year],
    queryFn: async ({ signal }) => {
      const rows: OvertimeRecord[] = []
      for (let apiPage = 1; ; apiPage += 1) {
        const result = await api.list<OvertimeRecord>('/overtime', {
          employee_id: employee!.id,
          from_date: `${year}-01-01`,
          to_date: `${year}-12-31`,
          page: apiPage,
          page_size: 100,
          descending: true,
        }, signal)
        rows.push(...result.items)
        if (apiPage >= Math.max(1, result.pages || 1)) break
      }
      return rows
    },
    enabled: Boolean(employee),
  })
  const rows = query.data ?? []
  const activeRows = rows.filter((row) => row.status !== 'reversed')
  const totalHours = activeRows.reduce((sum, row) => sum + numberValue(row.hours), 0)
  const totalAmount = activeRows.reduce((sum, row) => sum + (numberValue(row.amount) || numberValue(row.hours) * numberValue(row.rate)), 0)

  return (
    <Dialog open={Boolean(employee)} title={`OT details · ${employee?.name ?? ''}`} description={`${year} overtime history for this employee only.`} size="workspace" onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button icon={Plus} onClick={onAdd}>Add OT hours</Button></>}>
      <div className="stats-grid stats-grid--four">
        <Card><span className="table-subtext">Employee</span><strong>{employee?.employee_no || 'No employee number'}</strong></Card>
        <Card><span className="table-subtext">Active OT entries</span><strong>{activeRows.length}</strong></Card>
        <Card><span className="table-subtext">Total OT hours</span><strong>{quantity(totalHours, 2)}</strong></Card>
        <Card><span className="table-subtext">Total OT amount</span><strong>{money(totalAmount)}</strong></Card>
      </div>
      {query.isLoading ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : rows.length ? (
        <TableWrap><table><thead><tr><th>Date / reference</th><th className="numeric">Hours</th><th className="numeric">Rate</th><th className="numeric">Amount</th><th>Notes</th><th>Payroll / status</th><th /></tr></thead><tbody>{rows.map((row) => {
          const claimed = Boolean(row.claimed_payroll_id || row.claimed_payroll_reference || row.status === 'claimed' || row.status === 'paid')
          return <tr key={row.id}><td><strong className="mono">{row.reference_no}</strong><span className="table-subtext">{shortDate(row.work_date)}</span></td><td className="numeric">{quantity(row.hours, 2)}</td><td className="numeric">{money(row.rate)}</td><td className="numeric"><strong>{money(numberValue(row.amount) || numberValue(row.hours) * numberValue(row.rate))}</strong></td><td>{row.notes || '—'}</td><td>{row.claimed_payroll_reference || (claimed ? 'Claimed' : 'Not claimed')}<span className="table-subtext"><Badge tone={statusTone(claimed ? 'partial' : row.status)}>{titleCase(claimed ? 'claimed' : row.status)}</Badge></span></td><td><div className="row-actions"><Button size="small" variant="ghost" icon={Pencil} disabled={claimed || row.status === 'reversed'} onClick={() => onEdit(row)}>Edit</Button><Button size="small" variant="ghost" icon={RotateCcw} disabled={row.status === 'reversed'} onClick={() => onReverse(row)}>Reverse</Button></div></td></tr>
        })}</tbody></table></TableWrap>
      ) : <EmptyState message={`No OT hours have been recorded for ${employee?.name ?? 'this employee'} in ${year}.`} action={<Button icon={Plus} onClick={onAdd}>Add first OT entry</Button>} />}
    </Dialog>
  )
}

function DailyWorkList({ query, page, setPage, onAdd, onEdit, onReverse }: { query: ReturnType<typeof useQuery<Page<DailyWork>>>; page: number; setPage: (page: number) => void; onAdd: () => void; onEdit: (work: DailyWork) => void; onReverse: (work: DailyWork) => void }) {
  const rows = query.data?.items ?? []
  return <Card><SectionTitle title="Daily work" description="Daily wage and manual piecework are available to payroll exactly once." actions={<Button icon={Plus} onClick={onAdd}>Record work</Button>} />{query.isLoading ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : rows.length ? <><TableWrap><table><thead><tr><th>Date / reference</th><th>Employee</th><th className="numeric">Units</th><th className="numeric">Daily rate</th><th className="numeric">Base amount</th><th className="numeric">Piecework</th><th>Status</th><th /></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><strong className="mono">{row.reference_no || row.id.slice(0, 8)}</strong><span className="table-subtext">{shortDate(row.work_date)}</span></td><td className="mono">{row.employee_id.slice(0, 8)}…</td><td className="numeric">{quantity(row.work_units)}</td><td className="numeric">{money(row.daily_rate)}</td><td className="numeric">{money(row.base_amount ?? numberValue(row.work_units) * numberValue(row.daily_rate))}</td><td className="numeric">{money(row.daily_work_piecework.reduce((sum, item) => sum + numberValue(item.amount), 0))}</td><td><Badge tone={statusTone(row.status)}>{titleCase(row.status ?? 'posted')}</Badge></td><td><div className="row-actions"><Button size="small" variant="ghost" icon={Pencil} disabled={row.status === 'reversed'} onClick={() => onEdit(row)}>Correct</Button><Button size="small" variant="ghost" icon={RotateCcw} disabled={row.status === 'reversed'} onClick={() => onReverse(row)}>Reverse</Button></div></td></tr>)}</tbody></table></TableWrap><Pagination page={query.data?.page ?? page} pages={query.data?.pages ?? 0} total={query.data?.total ?? 0} onChange={setPage} /></> : <EmptyState message="No daily-work records exist for this year." />}</Card>
}


function OvertimeList({ query, page, setPage, onAdd, onEdit, onReverse }: {
  query: ReturnType<typeof useQuery<Page<OvertimeRecord>>>
  page: number
  setPage: (page: number) => void
  onAdd: () => void
  onEdit: (record: OvertimeRecord) => void
  onReverse: (record: OvertimeRecord) => void
}) {
  const rows = query.data?.items ?? []
  return (
    <Card>
      <SectionTitle
        title="OT hours"
        description="Record overtime by employee and date. Each entry keeps the OT rate used on that day and can be claimed once in payroll."
        actions={<Button icon={Plus} onClick={onAdd}>Add OT hours</Button>}
      />
      {query.isLoading ? <LoadingState /> : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : rows.length ? (
        <>
          <TableWrap>
            <table>
              <thead><tr><th>Date / reference</th><th>Employee</th><th className="numeric">Hours</th><th className="numeric">OT rate</th><th className="numeric">Amount</th><th>Payroll</th><th>Status</th><th /></tr></thead>
              <tbody>
                {rows.map((row) => {
                  const amount = numberValue(row.amount) || numberValue(row.hours) * numberValue(row.rate)
                  const claimed = Boolean(row.claimed_payroll_id || row.claimed_payroll_reference || row.status === 'claimed' || row.status === 'paid')
                  return (
                    <tr key={row.id}>
                      <td><strong className="mono">{row.reference_no || row.id.slice(0, 8)}</strong><span className="table-subtext">{shortDate(row.work_date)}</span></td>
                      <td><strong>{row.employee_name || row.employee?.name || row.employee_id.slice(0, 8)}</strong><span className="table-subtext">{row.employee_no || row.employee?.employee_no || 'Employee'}</span></td>
                      <td className="numeric">{quantity(row.hours, 2)}</td>
                      <td className="numeric">{money(row.rate)}</td>
                      <td className="numeric"><strong>{money(amount)}</strong></td>
                      <td>{row.claimed_payroll_reference || (claimed ? 'Claimed' : 'Not claimed')}</td>
                      <td><Badge tone={statusTone(claimed ? 'partial' : (row.status || 'active'))}>{titleCase(claimed ? 'claimed' : (row.status || 'open'))}</Badge></td>
                      <td><div className="row-actions"><Button size="small" variant="ghost" icon={Pencil} disabled={claimed || row.status === 'reversed'} onClick={() => onEdit(row)}>Edit</Button><Button size="small" variant="ghost" icon={RotateCcw} disabled={row.status === 'reversed'} onClick={() => onReverse(row)}>Reverse</Button></div></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
          <Pagination page={query.data?.page ?? page} pages={query.data?.pages ?? 0} total={query.data?.total ?? 0} onChange={setPage} />
        </>
      ) : <EmptyState message="No overtime has been recorded for this year." action={<Button icon={Plus} onClick={onAdd}>Add first OT entry</Button>} />}
    </Card>
  )
}

function EarningsList({ query, page, setPage, search, setSearch }: { query: ReturnType<typeof useQuery<Page<OpenEarning>>>; page: number; setPage: (page: number) => void; search: string; setSearch: (value: string) => void }) {
  const rows = query.data?.items ?? []
  return <Card><SectionTitle title="Open earnings" description="Unclaimed daily wages and piecework, ready for payroll." /><div className="toolbar"><SearchBox value={search} onChange={setSearch} placeholder="Search employee name" /></div>{query.isLoading ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : rows.length ? <><TableWrap><table><thead><tr><th>Employee</th><th>Date</th><th>Source</th><th>Description</th><th className="numeric">Quantity</th><th className="numeric">Rate</th><th className="numeric">Amount</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.source_type}-${row.source_id}`}><td><strong>{row.employee_name}</strong><span className="table-subtext">{row.employee_no || row.employee_id.slice(0, 8)}</span></td><td>{shortDate(row.work_date)}</td><td><Badge>{titleCase(row.source_type)}</Badge></td><td>{row.description}</td><td className="numeric">{quantity(row.quantity, 3)}</td><td className="numeric">{money(row.rate)}</td><td className="numeric"><strong>{money(row.amount)}</strong></td></tr>)}</tbody></table></TableWrap><Pagination page={query.data?.page ?? page} pages={query.data?.pages ?? 0} total={query.data?.total ?? 0} onChange={setPage} /></> : <EmptyState message="No unclaimed earnings match this view." />}</Card>
}

function payrollLineAmount(payroll: Payroll, types: string[]) {
  const normalize = (value: string | null | undefined) => (value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  const accepted = new Set(types.map(normalize))

  return (payroll.payroll_details ?? []).reduce((sum, line) => {
    // Some API versions expose the payroll line type through earning_type, some through
    // type, while older rows may only have a useful description. Check all three instead
    // of trusting only the first non-null field.
    const candidates = [line.earning_type, line.type, line.description].map(normalize)
    return candidates.some((candidate) => accepted.has(candidate))
      ? sum + numberValue(line.amount)
      : sum
  }, 0)
}

interface PayrollListProps {
  query: ReturnType<typeof useQuery<Page<Payroll>>>
  page: number
  setPage: (page: number) => void
  search: string
  setSearch: (value: string) => void
  report: boolean
  reportMonth: string
  onReportMonthChange: (value: string) => void
  exporting: boolean
  onExport: () => void
  onProfile: (row: Payroll) => void
  onAdd: () => void
  onEdit: (row: Payroll) => void
  onPayment: (row: Payroll) => void
  onReverse: (row: Payroll) => void
}

function PayrollList({
  query,
  page,
  setPage,
  search,
  setSearch,
  report,
  reportMonth,
  onReportMonthChange,
  exporting,
  onExport,
  onProfile,
  onAdd,
  onEdit,
  onPayment,
  onReverse,
}: PayrollListProps) {
  const rows = query.data?.items ?? []
  return (
    <Card className={report ? 'print-area' : undefined}>
      <SectionTitle
        title={report ? 'Monthly payroll report' : 'Posted payroll'}
        description={report
          ? 'Open an employee profile from the name, or export the complete selected month for EPF / ETF preparation.'
          : 'Server-calculated gross, deductions, contributions, net pay, and settlement status.'}
        actions={report ? (
          <div className="row-actions no-print">
            <Button variant="secondary" icon={Download} loading={exporting} onClick={onExport}>Download EPF / ETF Excel</Button>
            <Button variant="secondary" onClick={() => window.print()}>Print / save PDF</Button>
          </div>
        ) : <Button icon={Plus} onClick={onAdd}>New payroll</Button>}
      />
      <div className="toolbar no-print">
        <SearchBox value={search} onChange={setSearch} placeholder="Search payroll reference" />
        {report ? (
          <label className="payroll-month-filter">
            <span>Salary month</span>
            <Input type="month" value={reportMonth} onChange={(event) => onReportMonthChange(event.target.value)} />
          </label>
        ) : null}
      </div>
      {query.isLoading ? <LoadingState /> : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : rows.length ? (
        <>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Date / reference</th>
                  <th>Employee</th>
                  <th>Salary month</th>
                  <th className="numeric">Gross</th>
                  {report ? <th className="numeric">Employee EPF</th> : <th className="numeric">Deductions</th>}
                  {report ? <th className="numeric">Employer EPF / ETF</th> : null}
                  <th className="numeric">Net</th>
                  <th className="numeric">Paid / due</th>
                  <th>Status</th>
                  {!report ? <th className="no-print"><span className="sr-only">Actions</span></th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const employeeEpf = payrollLineAmount(row, ['employee_epf', 'epf_employee'])
                  const employerEpf = payrollLineAmount(row, ['employer_epf', 'epf_employer'])
                  const employerEtf = payrollLineAmount(row, ['employer_etf', 'etf_employer'])
                  return (
                    <tr key={row.id}>
                      <td><strong className="mono">{row.reference_no}</strong><span className="table-subtext">{shortDate(row.payroll_date)}</span></td>
                      <td>
                        {report ? (
                          <button type="button" className="table-profile-link" onClick={() => onProfile(row)}>
                            <UserRound size={15} aria-hidden="true" />
                            <span><strong>{payrollEmployeeDisplay(row)}</strong><small>{row.employee?.employee_no || row.employee_no || 'View employee profile'}</small></span>
                          </button>
                        ) : <span className="mono">{payrollEmployeeDisplay(row)}</span>}
                      </td>
                      <td>{monthLabel(row.salary_month)}</td>
                      <td className="numeric">{money(row.gross_pay)}</td>
                      {report ? <td className="numeric">{money(employeeEpf)}</td> : <td className="numeric">{money(row.deductions_total)}</td>}
                      {report ? <td className="numeric"><strong>{money(employerEpf)}</strong><span className="table-subtext">ETF {money(employerEtf)}</span></td> : null}
                      <td className="numeric"><strong>{money(row.net_pay)}</strong></td>
                      <td className="numeric">{money(row.paid_amount)}<span className="table-subtext">Due {money(row.balance_due)}</span></td>
                      <td><Badge tone={statusTone(row.status === 'reversed' ? row.status : row.payment_status)}>{titleCase(row.status === 'reversed' ? row.status : row.payment_status ?? 'payable')}</Badge></td>
                      {!report ? (
                        <td className="no-print"><div className="row-actions"><Button size="small" variant="ghost" icon={ReceiptText} onClick={() => onProfile(row)}>Paysheet</Button><Button size="small" variant="ghost" icon={Banknote} disabled={row.status === 'reversed'} onClick={() => onPayment(row)}>Payments</Button><Button size="small" variant="ghost" icon={Pencil} disabled={row.status === 'reversed'} onClick={() => onEdit(row)}>Correct</Button><Button size="small" variant="ghost" icon={RotateCcw} disabled={row.status === 'reversed'} onClick={() => onReverse(row)}>Reverse</Button></div></td>
                      ) : null}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
          <Pagination page={query.data?.page ?? page} pages={query.data?.pages ?? 0} total={query.data?.total ?? 0} onChange={setPage} />
        </>
      ) : <EmptyState message={report ? `No posted payroll exists for ${monthLabel(reportMonth)}.` : 'No payroll records match this view.'} action={!report ? <Button icon={Plus} onClick={onAdd}>Post first payroll</Button> : undefined} />}
    </Card>
  )
}

type EmployeePayTerms = {
  pay_model: 'monthly' | 'daily' | 'hybrid' | 'piecework'
  monthly_rate: number
  daily_rate: number
  ot_rate: number
  daily_on_conversion: boolean
}

function normalizePayModel(value: unknown): EmployeePayTerms['pay_model'] {
  return value === 'daily' || value === 'hybrid' || value === 'piecework' ? value : 'monthly'
}

function employeePayTerms(employee: Employee | null | undefined): EmployeePayTerms {
  return {
    pay_model: normalizePayModel(employee?.pay_model),
    monthly_rate: numberValue(employee?.monthly_rate),
    daily_rate: numberValue(employee?.daily_rate),
    ot_rate: numberValue(employee?.ot_rate),
    daily_on_conversion: employee?.daily_on_conversion ?? false,
  }
}

function employeeValuesWithPayTerms(employee: Employee, terms: EmployeePayTerms): EmployeeValues {
  const bank = employee.bank_details || {}
  return {
    employee_no: employee.employee_no ?? '',
    name: employee.name ?? '',
    nic: employee.nic ?? '',
    phone: employee.phone ?? '',
    address: employee.address ?? '',
    epf_no: employee.epf_no ?? '',
    etf_ref: employee.etf_ref ?? '',
    joined_date: employee.joined_date ?? localIsoDate(),
    left_date: employee.left_date ?? '',
    job_role: employee.job_role ?? '',
    employment_type: employee.employment_type ?? '',
    shift: employee.shift ?? '',
    pay_model: terms.pay_model,
    monthly_rate: terms.monthly_rate,
    daily_rate: terms.daily_rate,
    ot_rate: terms.ot_rate,
    daily_on_conversion: terms.daily_on_conversion,
    bank_name: bank.bank_name ?? '',
    bank_branch: bank.branch ?? '',
    bank_account_name: bank.account_name ?? '',
    bank_account_number: bank.account_number ?? '',
    status: employee.status === 'inactive' ? 'inactive' : 'active',
  }
}

function salaryMonthRange(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { from_date: undefined, to_date: undefined }
  const year = Number(month.slice(0, 4))
  const monthNumber = Number(month.slice(5, 7))
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  return { from_date: `${month}-01`, to_date: `${month}-${String(lastDay).padStart(2, '0')}` }
}

function PresetOrCustomSelect({
  label,
  value,
  onChange,
  options,
  placeholder = 'Select an option',
  manualPlaceholder = 'Type manually',
  disabled = false,
  maxLength = 160,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: readonly string[]
  placeholder?: string
  manualPlaceholder?: string
  disabled?: boolean
  maxLength?: number
}) {
  const customValue = Boolean(value) && !options.includes(value)
  const [manualOpen, setManualOpen] = useState(customValue)
  const isManual = manualOpen || customValue

  return (
    <div className="preset-custom-select">
      <Select
        aria-label={label}
        value={isManual ? '__custom__' : value}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value
          if (next === '__custom__') {
            setManualOpen(true)
            if (options.includes(value)) onChange('')
            return
          }
          setManualOpen(false)
          onChange(next)
        }}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}
        <option value="__custom__">Type manually…</option>
      </Select>
      {manualOpen ? (
        <Input
          value={options.includes(value) ? '' : value}
          onChange={(event) => onChange(event.target.value.slice(0, maxLength))}
          placeholder={manualPlaceholder}
          disabled={disabled}
          autoFocus
        />
      ) : null}
    </div>
  )
}

function EmployeeDialog({ open, record, mutation, onClose }: { open: boolean; record: Employee | null; mutation: ReturnType<typeof useMutation<MutationReceipt, Error, { id?: string | undefined; values: EmployeeValues }>>; onClose: () => void }) {
  const bank = record?.bank_details
  const form = useForm<EmployeeValues>({
    resolver: zodResolver(employeeSchema),
    values: {
      employee_no: record?.employee_no ?? '',
      name: record?.name ?? '',
      nic: record?.nic ?? '',
      phone: record?.phone ?? '',
      address: record?.address ?? '',
      epf_no: record?.epf_no ?? '',
      etf_ref: record?.etf_ref ?? '',
      joined_date: record?.joined_date ?? localIsoDate(),
      left_date: record?.left_date ?? '',
      job_role: record?.job_role ?? '',
      employment_type: record?.employment_type ?? '',
      shift: record?.shift ?? '',
      pay_model: record?.pay_model ?? 'monthly',
      monthly_rate: numberValue(record?.monthly_rate),
      daily_rate: numberValue(record?.daily_rate),
      ot_rate: numberValue(record?.ot_rate),
      daily_on_conversion: record?.daily_on_conversion ?? false,
      bank_name: bank?.bank_name ?? '',
      bank_branch: bank?.branch ?? '',
      bank_account_name: bank?.account_name ?? '',
      bank_account_number: bank?.account_number ?? '',
      status: record?.status === 'inactive' ? 'inactive' : 'active',
    },
  })
  const submit = form.handleSubmit((values) => mutation.mutate({ id: record?.id, values }))
  const payModel = form.watch('pay_model')

  return (
    <Dialog
      open={open}
      title={record ? 'Edit employee' : 'Add employee'}
      description="Employee terms are saved once and reused automatically by daily work and payroll."
      size="workspace"
      onClose={onClose}
      closeDisabled={mutation.isPending}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={mutation.isPending} onClick={() => void submit()}>Save employee</Button></>}
    >
      <style>{`
        .employee-editor-form{gap:13px}.employee-editor-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px 12px}.employee-editor-pay{border:1px solid rgba(99,102,241,.18);background:linear-gradient(180deg,rgba(248,250,255,.98),rgba(255,255,255,.98));border-radius:13px;padding:12px 13px}.preset-custom-select{display:grid;gap:8px}.employee-pay-note{font-size:12px;line-height:1.5;color:var(--text-muted,#64748b);margin-top:8px}@container (max-width:760px){.employee-editor-grid{grid-template-columns:1fr 1fr}}@container (max-width:520px){.employee-editor-grid{grid-template-columns:1fr}}
      `}</style>
      <form className="form-stack employee-editor-form" onSubmit={(event) => void submit(event)}>
        <div className="employee-editor-grid">
          <Field label="Employee number" error={form.formState.errors.employee_no?.message}><Input {...form.register('employee_no')} /></Field>
          <Field label="Full name" required error={form.formState.errors.name?.message}><Input {...form.register('name')} /></Field>
          <Field label="NIC"><Input {...form.register('nic')} /></Field>
          <Field label="Phone"><Input type="tel" {...form.register('phone')} /></Field>
          <Field label="Joined date" required><Input type="date" {...form.register('joined_date')} /></Field>
          <Field label="Left date" error={form.formState.errors.left_date?.message}><Input type="date" {...form.register('left_date')} /></Field>
          <Field label="Job role"><Controller control={form.control} name="job_role" render={({ field }) => <PresetOrCustomSelect label="Job role" value={field.value} onChange={field.onChange} options={staffOptions.job_role} manualPlaceholder="Type job role" maxLength={100} />} /></Field>
          <Field label="Employment type"><Controller control={form.control} name="employment_type" render={({ field }) => <PresetOrCustomSelect label="Employment type" value={field.value} onChange={field.onChange} options={staffOptions.employment_type} manualPlaceholder="Type employment type" maxLength={60} />} /></Field>
          <Field label="Shift"><Controller control={form.control} name="shift" render={({ field }) => <PresetOrCustomSelect label="Shift" value={field.value} onChange={field.onChange} options={staffOptions.shift} manualPlaceholder="Type shift" maxLength={60} />} /></Field>
          <Field label="EPF number"><Input {...form.register('epf_no')} /></Field>
          <Field label="ETF reference"><Input {...form.register('etf_ref')} /></Field>
          <Field label="Status"><Select {...form.register('status')}><option value="active">Active</option><option value="inactive">Inactive</option></Select></Field>
        </div>
        <Field label="Address"><Textarea rows={2} {...form.register('address')} /></Field>

        <section className="employee-editor-pay">
          <SectionTitle title="Pay terms" description="These saved rates are loaded automatically when this employee is selected for work or payroll." />
          <div className="employee-editor-grid">
            <Field label="Pay model" required><Select {...form.register('pay_model')}><option value="monthly">Monthly salary</option><option value="daily">Daily wage</option><option value="hybrid">Hybrid · monthly + work claims</option><option value="piecework">Piecework</option></Select></Field>
            <Field label="Monthly rate" error={form.formState.errors.monthly_rate?.message}><Input type="number" min="0" step="0.01" disabled={payModel === 'daily' || payModel === 'piecework'} {...form.register('monthly_rate')} /></Field>
            <Field label="Daily rate" error={form.formState.errors.daily_rate?.message}><Input type="number" min="0" step="0.01" disabled={payModel === 'monthly' || payModel === 'piecework'} {...form.register('daily_rate')} /></Field>
            <Field label="OT rate"><Input type="number" min="0" step="0.01" {...form.register('ot_rate')} /></Field>
          </div>
          <label className="check-field"><input type="checkbox" {...form.register('daily_on_conversion')} /><span>Count conversion days toward daily work</span></label>
          <p className="employee-pay-note">Monthly and Hybrid employees require a monthly rate. Daily and Hybrid employees require a daily rate. Piecework is paid from recorded piecework claims. OT remains optional and is available when posting payroll.</p>
        </section>

        <SectionTitle title="Bank details" />
        <div className="employee-editor-grid">
          <Field label="Bank"><Controller control={form.control} name="bank_name" render={({ field }) => <PresetOrCustomSelect label="Bank" value={field.value} onChange={field.onChange} options={staffOptions.bank_name} manualPlaceholder="Type bank name" maxLength={100} />} /></Field>
          <Field label="Branch"><Input {...form.register('bank_branch')} /></Field>
          <Field label="Account name"><Input {...form.register('bank_account_name')} /></Field>
          <Field label="Account number"><Input {...form.register('bank_account_number')} /></Field>
        </div>
      </form>
    </Dialog>
  )
}

function DailyWorkDialog({ open, record, mutation, onClose }: { open: boolean; record: DailyWork | null; mutation: ReturnType<typeof useMutation<MutationReceipt, Error, { id?: string | undefined; body: DailyWorkValues }>>; onClose: () => void }) {
  const form = useForm<DailyWorkValues>({
    resolver: zodResolver(dailyWorkSchema),
    values: {
      employee_id: record?.employee_id ?? '',
      work_date: record?.work_date ?? localIsoDate(),
      work_units: numberValue(record?.work_units) || 1,
      daily_rate: numberValue(record?.daily_rate),
      notes: record?.notes ?? '',
      manual_piecework: (record?.daily_work_piecework ?? []).map((item) => ({ task: item.task, quantity_kg: numberValue(item.quantity_kg), rate_per_kg: numberValue(item.rate_per_kg) })),
    },
  })
  const fields = useFieldArray({ control: form.control, name: 'manual_piecework' })
  const submit = form.handleSubmit((body) => mutation.mutate({ id: record?.id, body }))

  return (
    <Dialog
      open={open}
      title={record ? 'Correct daily work' : 'Record daily work'}
      description="Record the day once. The saved daily rate and piecework remain attached to this work record when payroll is posted."
      size="workspace"
      onClose={onClose}
      closeDisabled={mutation.isPending}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={mutation.isPending} onClick={() => void submit()}>Save daily work</Button></>}
    >
      <style>{`
        .daily-work-form{gap:11px}.daily-work-main{display:grid;grid-template-columns:minmax(340px,1.8fr) repeat(3,minmax(150px,.72fr));gap:10px 12px;align-items:end}.daily-work-notes{grid-column:1/-1}.daily-piecework-list{display:grid;gap:7px}.daily-piecework-row{position:relative;display:grid;grid-template-columns:minmax(240px,1.6fr) minmax(150px,.7fr) minmax(150px,.7fr) 36px;gap:8px 10px;align-items:end;padding:8px 9px;border:1px solid var(--border,#e5e7eb);border-radius:10px;background:#fff}.daily-piecework-row>.icon-button{align-self:end}@container (max-width:900px){.daily-work-main{grid-template-columns:1.5fr 1fr}.daily-piecework-row{grid-template-columns:1fr 1fr}}@container (max-width:560px){.daily-work-main,.daily-piecework-row{grid-template-columns:1fr}.daily-work-notes{grid-column:auto}.daily-piecework-row>.icon-button{position:absolute;top:7px;right:7px}}
      `}</style>
      <form className="form-stack daily-work-form" onSubmit={(event) => void submit(event)}>
        <div className="daily-work-main">
          <RemoteSelect<Employee>
            label="Employee"
            endpoint="/employees"
            queryKey="daily-work-employee"
            query={{ status: 'active' }}
            value={form.watch('employee_id')}
            onChange={(value) => form.setValue('employee_id', value, { shouldValidate: true })}
            onSelectItem={(employee) => { if (employee) form.setValue('daily_rate', numberValue(employee.daily_rate), { shouldDirty: true, shouldValidate: true }) }}
            optionValue={(employee) => employee.id}
            optionLabel={(employee) => `${employee.name} · ${employee.employee_no || 'No number'}`}
            required
            error={form.formState.errors.employee_id?.message}
            selectedLabel={record ? `Current employee · ${record.employee_id.slice(0, 8)}…` : undefined}
          />
          <Field label="Work date" required><Input type="date" {...form.register('work_date')} /></Field>
          <Field label="Work units" required error={form.formState.errors.work_units?.message}><Input type="number" min="0.000001" step="0.25" {...form.register('work_units')} /></Field>
          <Field label="Daily rate" required hint="Loaded from employee; this work record keeps its own saved rate." error={form.formState.errors.daily_rate?.message}><Input type="number" min="0.01" step="0.01" {...form.register('daily_rate')} /></Field>
          <Field label="Notes" className="daily-work-notes"><Textarea rows={2} {...form.register('notes')} /></Field>
        </div>

        <SectionTitle title="Manual piecework" description="Add only piecework completed on this same work day." actions={<Button type="button" size="small" variant="secondary" icon={Plus} onClick={() => fields.append({ task: '', quantity_kg: 0, rate_per_kg: 0 })}>Add piecework</Button>} />
        {fields.fields.length ? (
          <div className="daily-piecework-list">
            {fields.fields.map((fieldItem, index) => (
              <div className="daily-piecework-row" key={fieldItem.id}>
                <Field label="Task" required error={form.formState.errors.manual_piecework?.[index]?.task?.message}><Controller control={form.control} name={`manual_piecework.${index}.task`} render={({ field }) => <ManualSelect label={`Task ${index + 1}`} value={field.value} onChange={field.onChange} options={['Sorting', 'Cleaning', 'Cutting', 'Packing', 'Loading']} />} /></Field>
                <Field label="Quantity kg" required><Input type="number" min="0.000001" step="0.001" {...form.register(`manual_piecework.${index}.quantity_kg`)} /></Field>
                <Field label="Rate per kg" required><Input type="number" min="0.01" step="0.01" {...form.register(`manual_piecework.${index}.rate_per_kg`)} /></Field>
                <button type="button" className="icon-button icon-button--danger" onClick={() => fields.remove(index)} aria-label={`Remove piecework line ${index + 1}`}><Trash2 size={17} /></button>
              </div>
            ))}
          </div>
        ) : <EmptyState message="No manual piecework on this work day." />}
      </form>
    </Dialog>
  )
}

function OvertimeDialog({ open, record, initialEmployee, mutation, onClose }: {
  open: boolean
  record: OvertimeRecord | null
  initialEmployee: Employee | null
  mutation: ReturnType<typeof useMutation<MutationReceipt, Error, { id?: string | undefined; values: OvertimeValues; employee: Employee | null }>>
  onClose: () => void
}) {
  const [employee, setEmployee] = useState<Employee | null>(initialEmployee)
  const form = useForm<OvertimeValues>({
    resolver: zodResolver(overtimeSchema),
    defaultValues: {
      employee_id: record?.employee_id ?? initialEmployee?.id ?? '',
      work_date: record?.work_date ?? localIsoDate(),
      hours: numberValue(record?.hours),
      rate: numberValue(record?.rate),
      notes: record?.notes ?? '',
      update_employee_rate: false,
    },
  })

  const recordEmployeeQuery = useQuery({
    queryKey: ['employee', 'overtime-dialog', record?.employee_id],
    queryFn: ({ signal }) => api.get<Employee>(`/employees/${record!.employee_id}`, undefined, signal),
    enabled: open && Boolean(record?.employee_id),
  })
  const activeEmployee = employee ?? recordEmployeeQuery.data ?? null

  useEffect(() => {
    setEmployee(initialEmployee)
    form.reset({
      employee_id: record?.employee_id ?? initialEmployee?.id ?? '',
      work_date: record?.work_date ?? localIsoDate(),
      hours: numberValue(record?.hours),
      rate: numberValue(record?.rate),
      notes: record?.notes ?? '',
      update_employee_rate: false,
    })
  }, [record?.id, initialEmployee?.id, open])

  const hours = numberValue(form.watch('hours'))
  const rate = numberValue(form.watch('rate'))
  const amount = hours * rate
  const submit = form.handleSubmit((values) => mutation.mutate({ id: record?.id, values, employee: activeEmployee }))

  return (
    <Dialog
      open={open}
      title={record ? 'Edit OT hours' : 'Add OT hours'}
      description="Save overtime on the date it was worked. Payroll later uses the saved hours and saved rate for the selected salary month."
      size="workspace"
      onClose={onClose}
      closeDisabled={mutation.isPending}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={mutation.isPending} onClick={() => void submit()}>Save OT</Button></>}
    >
      <style>{`
        .ot-entry-form{gap:11px}.ot-entry-grid{display:grid;grid-template-columns:minmax(340px,1.8fr) repeat(3,minmax(150px,.72fr));gap:10px 12px;align-items:end}.ot-entry-summary{margin-top:2px;padding:10px 12px;border:1px solid var(--border,#e5e7eb);border-radius:11px;background:var(--surface-soft,#f8fafc);display:flex;align-items:center;justify-content:space-between;gap:14px}.ot-entry-summary span{font-size:12px;color:var(--text-muted,#64748b)}.ot-entry-summary strong{font-size:18px}.ot-entry-note{margin-top:0}@container (max-width:900px){.ot-entry-grid{grid-template-columns:1.6fr 1fr}.ot-entry-summary{align-items:flex-start;flex-wrap:wrap}}@container (max-width:560px){.ot-entry-grid{grid-template-columns:1fr}.ot-entry-summary{align-items:flex-start;flex-direction:column}}
      `}</style>
      <form className="form-stack ot-entry-form" onSubmit={(event) => void submit(event)}>
        <div className="ot-entry-grid">
          <RemoteSelect<Employee>
            label="Employee"
            endpoint="/employees"
            queryKey="overtime-employee"
            query={{ status: 'active' }}
            value={form.watch('employee_id')}
            onChange={(value) => form.setValue('employee_id', value, { shouldValidate: true })}
            onSelectItem={(selected) => {
              setEmployee(selected ?? null)
              if (selected) form.setValue('rate', numberValue(selected.ot_rate), { shouldDirty: true, shouldValidate: true })
            }}
            optionValue={(item) => item.id}
            optionLabel={(item) => `${item.name} · ${item.employee_no || 'No number'}`}
            required
            disabled={Boolean(record)}
            error={form.formState.errors.employee_id?.message}
            selectedLabel={record ? `${record.employee_name || 'Current employee'} · ${record.employee_no || record.employee_id.slice(0, 8)}` : initialEmployee ? `${initialEmployee.name} · ${initialEmployee.employee_no || 'No number'}` : undefined}
          />
          <Field label="OT date" required><Input type="date" {...form.register('work_date')} /></Field>
          <Field label="OT hours" required error={form.formState.errors.hours?.message}><Input type="number" min="0.01" max="24" step="0.25" {...form.register('hours')} /></Field>
          <Field label="OT rate" required error={form.formState.errors.rate?.message}><Input type="number" min="0.01" step="0.01" {...form.register('rate')} /></Field>
        </div>
        <div className="ot-entry-summary"><div><span>Calculated OT amount</span><strong>{money(amount)}</strong>{activeEmployee ? <small className="table-subtext">Current saved OT rate: {money(activeEmployee.ot_rate)}</small> : recordEmployeeQuery.isFetching ? <small className="table-subtext">Loading employee pay terms…</small> : null}</div><label className="check-field"><input type="checkbox" {...form.register('update_employee_rate')} /><span>Save this OT rate as the employee's default OT rate for future entries</span></label></div>
        <Field label="Notes" className="ot-entry-note"><Textarea rows={2} placeholder="Optional note about the overtime work" {...form.register('notes')} /></Field>
      </form>
    </Dialog>
  )
}

function payrollDetails(record: Payroll | null, kinds: string[]) {
  return (record?.payroll_details ?? []).filter((line) => kinds.includes(line.line_kind ?? '') || kinds.includes(line.type ?? ''))
}

type PayrollEditorSection = 'work' | 'additions' | 'deductions' | 'contributions'

function PayrollDialog({ open, record, mutation, onClose }: { open: boolean; record: Payroll | null; mutation: ReturnType<typeof useMutation<MutationReceipt, Error, { id?: string | undefined; body: Omit<PayrollValues, 'claim_ids' | 'overtime_ids'> & { overtime_ids: string[]; daily_work_ids: string[]; conversion_worker_ids: string[]; manual_piecework_ids: string[] } }>>; onClose: () => void }) {
  const toast = useToast()
  const queryClient = useQueryClient()
  const recordEarningLines = payrollDetails(record, ['earning'])
  const retainedClaimLines = recordEarningLines.filter((line) => Boolean(line.source_daily_work_id || line.source_conversion_worker_id || line.source_manual_piecework_id))
  const earningLines = recordEarningLines.filter((line) => !line.source_daily_work_id && !line.source_conversion_worker_id && !line.source_manual_piecework_id)
  const retainedDailyWorkIds = retainedClaimLines.flatMap((line) => line.source_daily_work_id ? [line.source_daily_work_id] : [])
  const retainedConversionWorkerIds = retainedClaimLines.flatMap((line) => line.source_conversion_worker_id ? [line.source_conversion_worker_id] : [])
  const retainedManualPieceworkIds = retainedClaimLines.flatMap((line) => line.source_manual_piecework_id ? [line.source_manual_piecework_id] : [])
  const deductionLines = payrollDetails(record, ['deduction'])
  const contributionLines = payrollDetails(record, ['employer_contribution'])
  const recordEmployee = (record?.employee ?? null) as Employee | null
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(recordEmployee)
  const [payTerms, setPayTerms] = useState<EmployeePayTerms>(() => employeePayTerms(recordEmployee))
  const [editPayTerms, setEditPayTerms] = useState(false)
  const [editorSection, setEditorSection] = useState<PayrollEditorSection>('work')

  const form = useForm<PayrollValues>({
    resolver: zodResolver(payrollSchema) as Resolver<PayrollValues>,
    defaultValues: {
      payroll_date: record?.payroll_date ?? localIsoDate(),
      salary_month: record?.salary_month ?? localIsoMonth(),
      employee_id: record?.employee_id ?? '',
      status: 'payable',
      payment_method: 'salary_payable',
      earnings: earningLines.map(toEditableLine),
      deductions: deductionLines.map(toEditableDeduction),
      employer_contributions: contributionLines.map(toEditableDeduction),
      claim_ids: [],
      overtime_ids: [],
    },
  })

  const earnings = useFieldArray({ control: form.control, name: 'earnings' })
  const deductions = useFieldArray({ control: form.control, name: 'deductions' })
  const contributions = useFieldArray({ control: form.control, name: 'employer_contributions' })

  useEffect(() => {
    if (!open) return
    const employee = (record?.employee ?? null) as Employee | null
    setSelectedEmployee(employee)
    setPayTerms(employeePayTerms(employee))
    setEditPayTerms(false)
    setEditorSection('work')
    form.reset({
      payroll_date: record?.payroll_date ?? localIsoDate(),
      salary_month: record?.salary_month ?? localIsoMonth(),
      employee_id: record?.employee_id ?? '',
      status: 'payable',
      payment_method: 'salary_payable',
      earnings: payrollDetails(record, ['earning']).filter((line) => !line.source_daily_work_id && !line.source_conversion_worker_id && !line.source_manual_piecework_id).map(toEditableLine),
      deductions: payrollDetails(record, ['deduction']).map(toEditableDeduction),
      employer_contributions: payrollDetails(record, ['employer_contribution']).map(toEditableDeduction),
      claim_ids: [],
      overtime_ids: [],
    })
  }, [open, record?.id])

  const employeeId = form.watch('employee_id')
  const salaryMonth = form.watch('salary_month')
  const settlementStatus = form.watch('status')
  const monthRange = salaryMonthRange(salaryMonth)

  useEffect(() => {
    if (!record) {
      form.setValue('claim_ids', [], { shouldDirty: false })
      form.setValue('overtime_ids', [], { shouldDirty: false })
    }
  }, [employeeId, salaryMonth, record?.id])

  const openQuery = useQuery({
    queryKey: ['open-earnings', 'payroll-dialog', employeeId, salaryMonth],
    queryFn: ({ signal }) => api.list<OpenEarning>('/open-earnings', {
      employee_id: employeeId,
      ...monthRange,
      page: 1,
      page_size: 100,
      descending: false,
    }, signal),
    enabled: open && Boolean(employeeId) && Boolean(monthRange.from_date) && !record,
  })

  const overtimeQuery = useQuery({
    queryKey: ['overtime', 'payroll-dialog', employeeId, salaryMonth],
    queryFn: ({ signal }) => api.list<OvertimeRecord>('/overtime', {
      employee_id: employeeId,
      ...monthRange,
      page: 1,
      page_size: 100,
      descending: false,
    }, signal),
    enabled: open && Boolean(employeeId) && Boolean(monthRange.from_date),
  })

  const openClaims = (openQuery.data?.items ?? []).filter((item) => {
    const source = String(item.source_type ?? '').toLowerCase()
    const isOvertime = source === 'overtime' || source === 'ot' || source.includes('overtime')
    return !isOvertime && (!item.work_date || item.work_date.startsWith(salaryMonth))
  })

  const overtimeRows = (overtimeQuery.data?.items ?? []).filter((item) => {
    const claimedByThisPayroll = Boolean(record && item.claimed_payroll_id === record.id)
    const claimedElsewhere = Boolean(item.claimed_payroll_id && !claimedByThisPayroll)
    return !claimedElsewhere && item.status !== 'reversed' && (!item.work_date || item.work_date.startsWith(salaryMonth))
  })

  useEffect(() => {
    if (!overtimeRows.length) {
      if (!record) form.setValue('overtime_ids', [], { shouldDirty: false })
      return
    }
    if (record) {
      const claimedIds = overtimeRows.filter((item) => item.claimed_payroll_id === record.id).map((item) => item.id)
      form.setValue('overtime_ids', claimedIds, { shouldDirty: false, shouldValidate: true })
      if (claimedIds.length) {
        const withoutClaimedOt = form.getValues('earnings').filter((line) => String(line.type).toLowerCase() !== 'overtime')
        earnings.replace(withoutClaimedOt)
      }
    } else {
      form.setValue('overtime_ids', overtimeRows.map((item) => item.id), { shouldDirty: false, shouldValidate: true })
    }
  }, [overtimeQuery.dataUpdatedAt, employeeId, salaryMonth, record?.id])

  const selectedClaims = form.watch('claim_ids') ?? []
  const selectedOvertimeIds = form.watch('overtime_ids') ?? []
  const watchedEarnings = form.watch('earnings') ?? []
  const watchedDeductions = form.watch('deductions') ?? []
  const watchedContributions = form.watch('employer_contributions') ?? []
  const selectedOpenRows = openClaims.filter((item) => selectedClaims.includes(item.source_id))
  const selectedOvertimeRows = overtimeRows.filter((item) => selectedOvertimeIds.includes(item.id))
  const selectedOpenTotal = record ? retainedClaimLines.reduce((sum, line) => sum + numberValue(line.amount), 0) : selectedOpenRows.reduce((sum, item) => sum + numberValue(item.amount), 0)
  const selectedOvertimeTotal = selectedOvertimeRows.reduce((sum, item) => sum + (numberValue(item.amount) || numberValue(item.hours) * numberValue(item.rate)), 0)
  const manualEarningsTotal = watchedEarnings.reduce((sum, item) => sum + numberValue(item.amount), 0)
  const deductionsTotal = watchedDeductions.reduce((sum, item) => sum + numberValue(item.amount), 0)
  const contributionsTotal = watchedContributions.reduce((sum, item) => sum + numberValue(item.amount), 0)
  const grossPreview = manualEarningsTotal + selectedOpenTotal + selectedOvertimeTotal
  const netPreview = Math.max(0, grossPreview - deductionsTotal)
  const employerCostPreview = grossPreview + contributionsTotal

  const savePayTermsMutation = useMutation({
    mutationFn: ({ employee, terms }: { employee: Employee; terms: EmployeePayTerms }) => {
      const body = employeePayload(employeeValuesWithPayTerms(employee, terms))
      return api.patch<MutationReceipt, typeof body>(`/employees/${employee.id}`, body)
    },
    onSuccess: async (_, variables) => {
      setSelectedEmployee({ ...variables.employee, ...variables.terms })
      setEditPayTerms(false)
      await queryClient.invalidateQueries({ queryKey: ['employees'] })
      toast.success('Pay terms saved', 'The saved rates will be reused for future payroll and OT entries.')
    },
    onError: (error) => toast.error('Pay terms were not saved', error instanceof Error ? error.message : 'Try again.'),
  })

  const payTermsValid = (() => {
    if (!selectedEmployee) return false
    if ((payTerms.pay_model === 'monthly' || payTerms.pay_model === 'hybrid') && payTerms.monthly_rate <= 0) return false
    if ((payTerms.pay_model === 'daily' || payTerms.pay_model === 'hybrid') && payTerms.daily_rate <= 0) return false
    return true
  })()

  const syncPayTermsIntoPayroll = (terms = payTerms) => {
    const existing = form.getValues('earnings').filter((line) => line.type !== 'monthly_salary')
    if ((terms.pay_model === 'monthly' || terms.pay_model === 'hybrid') && terms.monthly_rate > 0) {
      earnings.replace([
        {
          type: 'monthly_salary',
          description: 'Monthly salary',
          quantity: 1,
          rate: terms.monthly_rate,
          amount: terms.monthly_rate,
          account_code: payrollAccounts.earning[0],
        },
        ...existing,
      ])
    } else {
      earnings.replace(existing)
    }
  }

  const loadEmployee = (employee: Employee | null) => {
    setSelectedEmployee(employee)
    const terms = employeePayTerms(employee)
    setPayTerms(terms)
    setEditPayTerms(false)
    setEditorSection('work')
    form.setValue('claim_ids', [], { shouldDirty: false })
    form.setValue('overtime_ids', [], { shouldDirty: false })
    if (!record) {
      deductions.replace([])
      contributions.replace([])
      if (employee && (terms.pay_model === 'monthly' || terms.pay_model === 'hybrid') && terms.monthly_rate > 0) {
        earnings.replace([{
          type: 'monthly_salary',
          description: 'Monthly salary',
          quantity: 1,
          rate: terms.monthly_rate,
          amount: terms.monthly_rate,
          account_code: payrollAccounts.earning[0],
        }])
      } else {
        earnings.replace([])
      }
    }
  }

  const savePayTerms = () => {
    if (!selectedEmployee) return
    if (!payTermsValid) {
      toast.error('Complete pay terms', 'Enter the required monthly and/or daily rate for the selected pay model.')
      return
    }
    savePayTermsMutation.mutate({ employee: selectedEmployee, terms: payTerms })
    syncPayTermsIntoPayroll(payTerms)
  }

  const selectAllOpenWork = () => form.setValue('claim_ids', openClaims.map((item) => item.source_id), { shouldDirty: true, shouldValidate: true })
  const selectAllOvertime = () => form.setValue('overtime_ids', overtimeRows.map((item) => item.id), { shouldDirty: true, shouldValidate: true })

  const submit = form.handleSubmit((values) => {
    const claims = openClaims.filter((item) => values.claim_ids.includes(item.source_id))
    const ids = (types: string[]) => claims.filter((item) => types.includes(item.source_type)).map((item) => item.source_id)
    const { claim_ids: _claimIds, overtime_ids: _overtimeIds, ...base } = values
    void _claimIds
    void _overtimeIds

    // Overtime is appended and claimed atomically by the payroll backend from overtime_ids.
    // Do not duplicate OT as a manual earning here.
    const earningsWithAccounts = base.earnings.map((line) => ({ ...line, account_code: line.account_code || payrollAccounts.earning[0] }))
    const deductionsWithAccounts = base.deductions.map((line) => ({ ...line, account_code: line.account_code || payrollAccounts.deduction[0] }))
    const contributionsWithAccounts = base.employer_contributions.map((line) => ({ ...line, account_code: line.account_code || payrollAccounts.contribution[0] }))

    mutation.mutate({
      id: record?.id,
      body: {
        ...base,
        overtime_ids: values.overtime_ids,
        earnings: earningsWithAccounts,
        deductions: deductionsWithAccounts,
        employer_contributions: contributionsWithAccounts,
        payment_method: base.status === 'paid' ? base.payment_method : undefined as never,
        daily_work_ids: record ? retainedDailyWorkIds : ids(['daily_work', 'daily_wage']),
        conversion_worker_ids: record ? retainedConversionWorkerIds : ids(['conversion_worker', 'conversion_piecework']),
        manual_piecework_ids: record ? retainedManualPieceworkIds : ids(['manual_piecework', 'daily_work_piecework']),
      },
    })
  })

  const sectionItems: Array<{ value: PayrollEditorSection; label: string; count?: number }> = [
    { value: 'work', label: 'Work & OT', count: (record ? retainedClaimLines.length : selectedClaims.length) + selectedOvertimeIds.length },
    { value: 'additions', label: 'Additions', count: earnings.fields.length },
    { value: 'deductions', label: 'Deductions', count: deductions.fields.length },
    { value: 'contributions', label: 'Employer contributions', count: contributions.fields.length },
  ]

  return (
    <Dialog
      open={open}
      title={record ? 'Correct payroll' : 'Post payroll'}
      description="Select the employee and month, review recorded work and OT, then add only the adjustments that apply."
      size="workspace"
      onClose={onClose}
      closeDisabled={mutation.isPending || savePayTermsMutation.isPending}
    >
      <style>{`
        .payroll-editor{display:grid;gap:10px;min-width:0;padding-bottom:2px}.payroll-editor__top{display:grid;grid-template-columns:minmax(330px,1.8fr) repeat(4,minmax(145px,.72fr));gap:9px 11px;align-items:end}.payroll-editor__terms{border:1px solid var(--border,#e5e7eb);border-radius:12px;background:#fff;padding:10px 12px}.payroll-editor__terms-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.payroll-editor__terms-values{display:flex;gap:10px 18px;flex-wrap:wrap;margin-top:6px}.payroll-editor__terms-values span{font-size:11.5px;color:var(--text-muted,#64748b)}.payroll-editor__terms-values b{color:var(--text,#111827);margin-left:4px}.payroll-editor__terms-form{display:grid;grid-template-columns:1.1fr repeat(3,minmax(130px,.75fr)) auto;gap:8px 10px;align-items:end;margin-top:9px}.payroll-editor__summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}.payroll-editor__metric{padding:8px 10px;border:1px solid var(--border,#e5e7eb);border-radius:10px;background:#fff}.payroll-editor__metric span{display:block;font-size:10px;color:var(--text-muted,#64748b);margin-bottom:3px}.payroll-editor__metric strong{font-size:14px}.payroll-editor__nav{display:flex;gap:5px;overflow-x:auto;border-bottom:1px solid var(--border,#e5e7eb);padding-bottom:7px}.payroll-editor__nav button{border:0;background:transparent;color:var(--text-muted,#64748b);font:inherit;font-size:12.5px;font-weight:700;padding:7px 9px;border-radius:8px;cursor:pointer;white-space:nowrap}.payroll-editor__nav button:hover{background:var(--surface-soft,#f8fafc);color:var(--text,#111827)}.payroll-editor__nav button.active{background:var(--surface-soft,#f1f5f9);color:var(--text,#111827)}.payroll-editor__nav small{margin-left:5px;font-size:9.5px}.payroll-editor__panel{border:1px solid var(--border,#e5e7eb);border-radius:12px;background:#fff;padding:11px 12px;min-width:0}.payroll-work-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}.payroll-claim-list{display:grid;gap:6px;max-height:285px;overflow:auto;padding-right:2px}.payroll-claim{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:center;border:1px solid var(--border,#e5e7eb);border-radius:9px;padding:7px 9px;background:#fff}.payroll-claim span{min-width:0}.payroll-claim strong,.payroll-claim small{display:block}.payroll-claim small{margin-top:1px;color:var(--text-muted,#64748b);font-size:10.5px}.payroll-editor__footer{position:sticky;bottom:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid var(--border,#e5e7eb);border-radius:11px;background:rgba(255,255,255,.97);backdrop-filter:blur(10px)}.payroll-editor__footer small{display:block;margin-top:1px;color:var(--text-muted,#64748b)}.payroll-editor__actions{display:flex;gap:7px;flex-wrap:wrap}.payroll-line-list{display:grid;gap:7px}.payroll-line-row{display:grid;grid-template-columns:minmax(190px,1.15fr) minmax(220px,1.45fr) minmax(90px,.45fr) minmax(110px,.55fr) minmax(130px,.65fr) 36px;gap:7px 9px;align-items:end;border:1px solid var(--border,#e5e7eb);border-radius:10px;padding:8px 9px}.payroll-line-row--deduction,.payroll-line-row--contribution{grid-template-columns:minmax(200px,1fr) minmax(250px,1.5fr) minmax(140px,.6fr) 36px}.payroll-line-empty{padding:14px;border:1px dashed var(--border,#d1d5db);border-radius:10px;color:var(--text-muted,#64748b);text-align:center}.payroll-panel-actions{display:flex;gap:6px;flex-wrap:wrap}.payroll-subsection-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px}.payroll-subsection-title h4{margin:0;font-size:13.5px}.payroll-subsection-title span{font-size:10.5px;color:var(--text-muted,#64748b)}@container (max-width:1180px){.payroll-editor__top{grid-template-columns:minmax(260px,1.5fr) repeat(2,minmax(150px,1fr))}.payroll-editor__terms-form{grid-template-columns:repeat(3,minmax(150px,1fr))}.payroll-editor__summary{grid-template-columns:repeat(4,1fr)}.payroll-line-row{grid-template-columns:repeat(3,minmax(160px,1fr))}.payroll-line-row--deduction,.payroll-line-row--contribution{grid-template-columns:repeat(3,minmax(160px,1fr))}.payroll-line-row>.icon-button{align-self:end}}@container (max-width:850px){.payroll-editor__top{grid-template-columns:1fr 1fr}.payroll-editor__terms-form{grid-template-columns:1fr 1fr}.payroll-editor__summary{grid-template-columns:1fr 1fr}.payroll-work-grid{grid-template-columns:1fr}.payroll-line-row,.payroll-line-row--deduction,.payroll-line-row--contribution{grid-template-columns:1fr 1fr}.payroll-editor__footer{position:static}}@container (max-width:560px){.payroll-editor__top,.payroll-editor__terms-form,.payroll-editor__summary,.payroll-line-row,.payroll-line-row--deduction,.payroll-line-row--contribution{grid-template-columns:1fr}.payroll-editor__footer{align-items:flex-start;flex-direction:column}.payroll-editor__actions{width:100%}.payroll-editor__actions .button{flex:1}}
      `}</style>
      <form className="payroll-editor" onSubmit={(event) => void submit(event)}>
        <div className="payroll-editor__top">
          <RemoteSelect<Employee>
            label="Employee"
            endpoint="/employees"
            queryKey="payroll-employee"
            query={{ status: 'active' }}
            value={employeeId}
            onChange={(value) => form.setValue('employee_id', value, { shouldValidate: true })}
            onSelectItem={(employee) => loadEmployee(employee ?? null)}
            optionValue={(employee) => employee.id}
            optionLabel={(employee) => `${employee.name} · ${employee.employee_no || 'No number'}`}
            required
            disabled={Boolean(record)}
            error={form.formState.errors.employee_id?.message}
            selectedLabel={record ? `${payrollEmployeeDisplay(record)} · ${record.employee_no || record.employee_id.slice(0, 8)}` : undefined}
          />
          <Field label="Salary month" required><Input type="month" {...form.register('salary_month')} /></Field>
          <Field label="Payroll date" required><Input type="date" {...form.register('payroll_date')} /></Field>
          <Field label="Settlement"><Select {...form.register('status')}><option value="payable">Pay later</option><option value="paid">Pay in full now</option></Select></Field>
          {settlementStatus === 'paid' ? <Field label="Payment method" required><Select {...form.register('payment_method')}>{payrollSettlementMethods.map((method) => <option key={method} value={method}>{titleCase(method)}</option>)}</Select></Field> : null}
        </div>

        <section className="payroll-editor__terms">
          <div className="payroll-editor__terms-head">
            <div><strong>{selectedEmployee ? `${selectedEmployee.name} · saved pay terms` : 'Saved pay terms'}</strong><div className="table-subtext">{selectedEmployee ? [selectedEmployee.employee_no, selectedEmployee.job_role, selectedEmployee.employment_type].filter(Boolean).join(' · ') || 'Employee defaults' : 'Select an employee to load their saved payroll defaults.'} · Recorded work and OT keep their historical rates.</div></div>
            <Button type="button" size="small" variant="secondary" disabled={!selectedEmployee || Boolean(record)} onClick={() => setEditPayTerms((value) => !value)}>{editPayTerms ? 'Done' : 'Edit rates'}</Button>
          </div>
          <div className="payroll-editor__terms-values">
            <span>Pay model <b>{titleCase(payTerms.pay_model)}</b></span><span>Monthly <b>{money(payTerms.monthly_rate)}</b></span><span>Daily <b>{money(payTerms.daily_rate)}</b></span><span>OT <b>{money(payTerms.ot_rate)}</b></span>
          </div>
          {editPayTerms ? (
            <div className="payroll-editor__terms-form">
              <Field label="Pay model"><Select value={payTerms.pay_model} onChange={(event) => setPayTerms((current) => ({ ...current, pay_model: normalizePayModel(event.target.value) }))}><option value="monthly">Monthly</option><option value="daily">Daily</option><option value="hybrid">Hybrid</option><option value="piecework">Piecework</option></Select></Field>
              <Field label="Monthly rate"><Input type="number" min="0" step="0.01" value={payTerms.monthly_rate} onChange={(event) => setPayTerms((current) => ({ ...current, monthly_rate: numberValue(event.target.value) }))} /></Field>
              <Field label="Daily rate"><Input type="number" min="0" step="0.01" value={payTerms.daily_rate} onChange={(event) => setPayTerms((current) => ({ ...current, daily_rate: numberValue(event.target.value) }))} /></Field>
              <Field label="OT rate"><Input type="number" min="0" step="0.01" value={payTerms.ot_rate} onChange={(event) => setPayTerms((current) => ({ ...current, ot_rate: numberValue(event.target.value) }))} /></Field>
              <Button type="button" size="small" disabled={!payTermsValid} loading={savePayTermsMutation.isPending} onClick={savePayTerms}>Save rates</Button>
            </div>
          ) : null}
        </section>

        <div className="payroll-editor__summary">
          <div className="payroll-editor__metric"><span>Gross earnings</span><strong>{money(grossPreview)}</strong></div>
          <div className="payroll-editor__metric"><span>Employee deductions</span><strong>{money(deductionsTotal)}</strong></div>
          <div className="payroll-editor__metric"><span>Net pay</span><strong>{money(netPreview)}</strong></div>
          <div className="payroll-editor__metric"><span>Employer cost</span><strong>{money(employerCostPreview)}</strong></div>
        </div>

        <nav className="payroll-editor__nav" aria-label="Payroll editor sections">
          {sectionItems.map((item) => <button type="button" key={item.value} className={editorSection === item.value ? 'active' : ''} onClick={() => setEditorSection(item.value)}>{item.label}{item.count ? <small>{item.count}</small> : null}</button>)}
        </nav>

        {editorSection === 'work' ? (
          <section className="payroll-editor__panel">
            <div className="payroll-work-grid">
              <div>
                <div className="payroll-subsection-title"><div><h4>Recorded daily / piecework</h4><span>{monthLabel(salaryMonth)} · {money(selectedOpenTotal)}</span></div>{!record && openClaims.length ? <div className="payroll-panel-actions"><Button type="button" size="small" variant="secondary" onClick={selectAllOpenWork}>Select all</Button><Button type="button" size="small" variant="ghost" onClick={() => form.setValue('claim_ids', [], { shouldDirty: true })}>Clear</Button></div> : null}</div>
                {record ? (retainedClaimLines.length ? <div className="payroll-claim-list">{retainedClaimLines.map((line, index) => <div className="payroll-claim" key={`retained-work-${line.id || index}`}><span aria-hidden="true">✓</span><span><strong>{payrollDetailLabel(line)}</strong><small>{payrollDetailBasis(line)} · retained from {record.reference_no}</small></span><b>{money(line.amount)}</b></div>)}</div> : <EmptyState message="This payroll has no recorded daily or piecework claims." />) : openQuery.isLoading ? <LoadingState /> : openQuery.isError ? <ErrorState error={openQuery.error} onRetry={() => void openQuery.refetch()} /> : openClaims.length ? <div className="payroll-claim-list">{openClaims.map((item) => <label className="payroll-claim" key={`${item.source_type}-${item.source_id}`}><input type="checkbox" value={item.source_id} {...form.register('claim_ids')} /><span><strong>{item.description}</strong><small>{shortDate(item.work_date)} · {titleCase(item.source_type)} · {quantity(item.quantity, 3)} × {money(item.rate)}</small></span><b>{money(item.amount)}</b></label>)}</div> : <EmptyState message={employeeId ? `No unclaimed work exists for ${monthLabel(salaryMonth)}.` : 'Select an employee first.'} />}
              </div>
              <div>
                <div className="payroll-subsection-title"><div><h4>Recorded overtime</h4><span>{monthLabel(salaryMonth)} · {money(selectedOvertimeTotal)}</span></div>{overtimeRows.length ? <div className="payroll-panel-actions"><Button type="button" size="small" variant="secondary" onClick={selectAllOvertime}>Select all</Button><Button type="button" size="small" variant="ghost" onClick={() => form.setValue('overtime_ids', [], { shouldDirty: true })}>Clear</Button></div> : null}</div>
                {overtimeQuery.isLoading ? <LoadingState /> : overtimeQuery.isError ? <ErrorState error={overtimeQuery.error} onRetry={() => void overtimeQuery.refetch()} /> : overtimeRows.length ? <div className="payroll-claim-list">{overtimeRows.map((item) => <label className="payroll-claim" key={item.id}><input type="checkbox" value={item.id} {...form.register('overtime_ids')} /><span><strong>{shortDate(item.work_date)} · Overtime</strong><small>{quantity(item.hours, 2)} hours × {money(item.rate)}</small></span><b>{money(numberValue(item.amount) || numberValue(item.hours) * numberValue(item.rate))}</b></label>)}</div> : <EmptyState message={employeeId ? `No unclaimed overtime exists for ${monthLabel(salaryMonth)}.` : 'Select an employee first.'} />}
              </div>
            </div>
          </section>
        ) : null}

        {editorSection === 'additions' ? <section className="payroll-editor__panel"><SectionTitle title="Additions & earnings" description="Monthly salary is loaded automatically for Monthly/Hybrid employees. Add only other allowances, bonuses or adjustments." actions={<Button type="button" size="small" variant="secondary" icon={Plus} onClick={() => earnings.append({ type: '', description: '', quantity: 1, rate: 0, amount: 0, account_code: payrollAccounts.earning[0] })}>Add earning</Button>} /><PayrollLines kind="earning" fields={earnings} form={form} />{form.formState.errors.earnings?.root?.message ? <span className="field__error">{form.formState.errors.earnings.root.message}</span> : null}</section> : null}
        {editorSection === 'deductions' ? <section className="payroll-editor__panel"><SectionTitle title="Employee deductions" description="Add each EPF, advance, loan, no-pay, tax or other deduction separately." actions={<Button type="button" size="small" variant="secondary" icon={Plus} onClick={() => deductions.append({ type: '', description: '', amount: 0, account_code: payrollAccounts.deduction[0] })}>Add deduction</Button>} /><PayrollLines kind="deduction" fields={deductions} form={form} /></section> : null}
        {editorSection === 'contributions' ? <section className="payroll-editor__panel"><SectionTitle title="Employer contributions" description="Employer EPF, ETF and other employer-side payroll costs." actions={<Button type="button" size="small" variant="secondary" icon={Plus} onClick={() => contributions.append({ type: '', description: '', amount: 0, account_code: payrollAccounts.contribution[0] })}>Add contribution</Button>} /><PayrollLines kind="contribution" fields={contributions} form={form} /><div className="form-total" style={{ marginTop: 10 }}><span>Total employer payroll cost</span><strong>{money(employerCostPreview)}</strong></div></section> : null}

        <div className="payroll-editor__footer">
          <div><strong>Estimated net pay · {money(netPreview)}</strong><small>{selectedEmployee ? `${selectedEmployee.name} · ${monthLabel(salaryMonth)}` : 'Select an employee before posting'}</small></div>
          <div className="payroll-editor__actions"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="button" loading={mutation.isPending} disabled={!employeeId} onClick={() => void submit()}>{record ? 'Save correction' : 'Post payroll'}</Button></div>
        </div>
      </form>
    </Dialog>
  )
}
function toEditableLine(line: PayrollLine) {
  return {
    type: line.earning_type ?? line.type ?? 'earning',
    description: line.description ?? '',
    quantity: numberValue(line.quantity),
    rate: numberValue(line.rate),
    amount: numberValue(line.amount),
    account_code: line.account_code ?? payrollAccounts.earning[0],
  }
}

function toEditableDeduction(line: PayrollLine) {
  return {
    type: line.earning_type ?? line.type ?? 'deduction',
    description: line.description ?? '',
    amount: numberValue(line.amount),
    account_code: line.account_code ?? '',
  }
}

function PayrollLines({ kind, fields, form }: {
  kind: 'earning' | 'deduction' | 'contribution'
  fields: UseFieldArrayReturn<PayrollValues, 'earnings' | 'deductions' | 'employer_contributions'>
  form: UseFormReturn<PayrollValues>
}) {
  const name = kind === 'earning' ? 'earnings' : kind === 'deduction' ? 'deductions' : 'employer_contributions'
  const options = lineTypes[kind]

  if (!fields.fields.length) return <div className="payroll-line-empty">No {kind === 'earning' ? 'manual additions' : kind === 'deduction' ? 'deductions' : 'employer contributions'} added.</div>

  const recalcEarning = (index: number, quantityValue?: unknown, rateValue?: unknown) => {
    if (kind !== 'earning') return
    const qty = numberValue(quantityValue ?? form.getValues(`earnings.${index}.quantity`))
    const rate = numberValue(rateValue ?? form.getValues(`earnings.${index}.rate`))
    if (qty > 0 && rate > 0) form.setValue(`earnings.${index}.amount`, Number((qty * rate).toFixed(2)), { shouldDirty: true, shouldValidate: true })
  }

  return (
    <div className="payroll-line-list">
      {fields.fields.map((fieldItem, index) => {
        const typePath = `${name}.${index}.type` as const
        const descriptionPath = `${name}.${index}.description` as const
        const amountPath = `${name}.${index}.amount` as const
        const amountError = form.formState.errors[name]?.[index]?.amount?.message
        const typeError = form.formState.errors[name]?.[index]?.type?.message

        return (
          <div className={`payroll-line-row payroll-line-row--${kind}`} key={fieldItem.id}>
            <Field label="Type" required error={typeError}>
              <Controller control={form.control} name={typePath} render={({ field }) => <PresetOrCustomSelect label={`${kind} type ${index + 1}`} value={field.value} onChange={field.onChange} options={options} placeholder="Select type" manualPlaceholder="Type custom payroll item" />} />
            </Field>
            <Field label="Description"><Input placeholder="Optional description" {...form.register(descriptionPath)} /></Field>
            {kind === 'earning' ? (() => {
              const quantityRegister = form.register(`earnings.${index}.quantity`)
              const rateRegister = form.register(`earnings.${index}.rate`)
              return <>
                <Field label="Qty / hours"><Input type="number" min="0" step="0.001" {...quantityRegister} onChange={(event) => { void quantityRegister.onChange(event); recalcEarning(index, event.target.value, undefined) }} /></Field>
                <Field label="Rate"><Input type="number" min="0" step="0.01" {...rateRegister} onChange={(event) => { void rateRegister.onChange(event); recalcEarning(index, undefined, event.target.value) }} /></Field>
              </>
            })() : null}
            <Field label="Amount" required error={amountError}><Input type="number" min="0.01" step="0.01" {...form.register(amountPath)} /></Field>
            <button type="button" className="icon-button icon-button--danger" onClick={() => fields.remove(index)} aria-label={`Remove ${kind} line ${index + 1}`}><Trash2 size={17} /></button>
          </div>
        )
      })}
    </div>
  )
}
function PayrollPaymentDialog({ payroll, mutation, onReverse, onClose }: { payroll: Payroll | null; mutation: ReturnType<typeof useMutation<MutationReceipt, Error, { payrollId: string; body: PayrollPaymentValues }>>; onReverse: (payment: Payment) => void; onClose: () => void }) {
  const form = useForm<PayrollPaymentValues>({ resolver: zodResolver(paymentSchema), values: { payment_date: localIsoDate(), amount: numberValue(payroll?.balance_due), method: 'cash', notes: '' } })
  const submit = form.handleSubmit((body) => { if (payroll) mutation.mutate({ payrollId: payroll.id, body }) })

  return (
    <Dialog
      open={Boolean(payroll)}
      title={`Payroll payments · ${payroll?.reference_no ?? ''}`}
      description={`Current balance: ${money(payroll?.balance_due)}`}
      size="workspace"
      onClose={onClose}
      closeDisabled={mutation.isPending}
      footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button icon={Banknote} loading={mutation.isPending} disabled={!payroll || numberValue(payroll.balance_due) <= 0} onClick={() => void submit()}>Post payment</Button></>}
    >
      <style>{`
        .payroll-payment-form{display:grid;grid-template-columns:minmax(150px,.8fr) minmax(170px,.8fr) minmax(180px,1fr) minmax(320px,1.7fr);gap:10px 12px;align-items:end;margin-bottom:12px}.payroll-payment-form .textarea{min-height:41px;height:41px;resize:vertical}@container (max-width:900px){.payroll-payment-form{grid-template-columns:1fr 1fr}}@container (max-width:520px){.payroll-payment-form{grid-template-columns:1fr}.payroll-payment-form .textarea{height:auto;min-height:72px}}
      `}</style>
      <form className="payroll-payment-form" onSubmit={(event) => void submit(event)}>
        <Field label="Payment date" required><Input type="date" {...form.register('payment_date')} /></Field>
        <Field label="Amount" required error={form.formState.errors.amount?.message}><Input type="number" min="0.01" max={numberValue(payroll?.balance_due) || undefined} step="0.01" {...form.register('amount')} /></Field>
        <Field label="Method" required><Select {...form.register('method')}>{payrollSettlementMethods.map((method) => <option value={method} key={method}>{titleCase(method)}</option>)}</Select></Field>
        <Field label="Notes"><Textarea rows={1} placeholder="Optional payment note" {...form.register('notes')} /></Field>
      </form>
      <SectionTitle title="Payment history" description="Every payment remains visible for audit, including reversed entries." />
      {payroll?.payroll_payments.length ? (
        <TableWrap><table><thead><tr><th>Date / reference</th><th>Method</th><th className="numeric">Amount</th><th>Status</th><th /></tr></thead><tbody>{payroll.payroll_payments.map((payment) => <tr key={payment.id}><td><strong className="mono">{payment.reference_no}</strong><span className="table-subtext">{shortDate(payment.payment_date)}</span></td><td>{titleCase(payment.method)}</td><td className="numeric">{money(payment.amount)}</td><td><Badge tone={statusTone(payment.status)}>{titleCase(payment.status ?? 'posted')}</Badge></td><td><Button size="small" variant="ghost" icon={RotateCcw} disabled={payment.status === 'reversed'} onClick={() => onReverse(payment)}>Reverse</Button></td></tr>)}</tbody></table></TableWrap>
      ) : <EmptyState message="No payments have been posted for this payroll." />}
    </Dialog>
  )
}

function PayrollPostFollowupDialog({ payroll, step, companyName, hidden, onPayLater, onPayment, onPrint, onDone }: {
  payroll: Payroll | null
  step: 'payment' | 'delivery'
  companyName: string
  hidden: boolean
  onPayLater: () => void
  onPayment: () => void
  onPrint: () => void
  onDone: () => void
}) {
  const toast = useToast()
  const sendWhatsApp = () => {
    if (!payroll) return
    const phone = normalizeWhatsAppPhone(payroll.employee?.phone)
    if (!phone) {
      toast.error('WhatsApp message not opened', 'Add a valid phone number to the employee profile first.')
      return
    }
    const message = payrollWhatsAppMessage({
      employeeName: payrollEmployeeDisplay(payroll),
      companyName,
      salaryMonth: payroll.salary_month,
      reference: payroll.reference_no,
      gross: numberValue(payroll.gross_pay),
      deductions: numberValue(payroll.deductions_total),
      net: numberValue(payroll.net_pay),
      paid: numberValue(payroll.paid_amount),
      due: numberValue(payroll.balance_due),
    })
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer')
  }

  return (
    <Dialog
      open={Boolean(payroll) && !hidden}
      title={step === 'payment' ? 'Payroll posted · record payment?' : 'Payroll saved · deliver paysheet'}
      description={step === 'payment' ? 'Choose whether to settle this payroll now or leave it payable.' : 'Print the employee paysheet or send a clear salary summary by WhatsApp.'}
      size="small"
      onClose={onDone}
      footer={step === 'payment' ? <><Button variant="secondary" onClick={onPayLater}>Pay later</Button><Button icon={Banknote} onClick={onPayment}>Record payment</Button></> : <Button variant="secondary" onClick={onDone}>Done</Button>}
    >
      <div className="form-stack">
        <Card><strong>{payroll ? payrollEmployeeDisplay(payroll) : ''}</strong><span className="table-subtext">{payroll ? `${monthLabel(payroll.salary_month)} · ${payroll.reference_no}` : ''}</span></Card>
        <div className="stats-grid">
          <Card><span className="table-subtext">Net salary</span><strong>{money(payroll?.net_pay)}</strong></Card>
          <Card><span className="table-subtext">Paid</span><strong>{money(payroll?.paid_amount)}</strong></Card>
          <Card><span className="table-subtext">Balance due</span><strong>{money(payroll?.balance_due)}</strong></Card>
        </div>
        {step === 'delivery' ? <div className="row-actions"><Button icon={Printer} onClick={onPrint}>Open / print paysheet</Button><Button variant="secondary" icon={MessageCircle} onClick={sendWhatsApp}>Send WhatsApp message</Button></div> : null}
      </div>
    </Dialog>
  )
}

type DetailedPayrollLine = PayrollLine & {
  line_kind?: string | null
  source_type?: string | null
  source_id?: string | null
  source_reference?: string | null
  reference_no?: string | null
  work_date?: string | null
  date?: string | null
}

function normalizePayrollType(line: PayrollLine) {
  return String(line.earning_type ?? line.type ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

function payrollDetailKind(line: PayrollLine): 'earning' | 'deduction' | 'contribution' {
  const detail = line as DetailedPayrollLine
  const explicit = String(detail.line_kind ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (explicit === 'deduction') return 'deduction'
  if (explicit === 'employer_contribution' || explicit === 'contribution') return 'contribution'
  if (explicit === 'earning') return 'earning'

  const type = normalizePayrollType(line)
  if (lineTypes.deduction.some((item) => item === type)) return 'deduction'
  if (lineTypes.contribution.some((item) => item === type)) return 'contribution'
  return 'earning'
}

function payrollDetailBasis(line: PayrollLine) {
  const type = normalizePayrollType(line)
  const detail = line as DetailedPayrollLine
  const source = String(detail.source_type ?? '').toLowerCase()
  if (type.includes('monthly') || source.includes('monthly')) return 'Monthly'
  if (type.includes('overtime') || type === 'ot') return 'Overtime'
  if (type.includes('piecework') || source.includes('piecework') || source.includes('conversion')) return 'Piecework'
  if (type.includes('daily') || source.includes('daily')) return 'Daily'
  if (type.includes('allowance')) return 'Allowance'
  if (type.includes('bonus')) return 'Bonus'
  if (type.includes('commission')) return 'Commission'
  if (payrollDetailKind(line) === 'deduction') return 'Deduction'
  if (payrollDetailKind(line) === 'contribution') return 'Employer contribution'
  return titleCase(type || 'Earning')
}

function payrollDetailLabel(line: PayrollLine) {
  const type = normalizePayrollType(line)
  return line.description?.trim() || titleCase(type || payrollDetailKind(line))
}

function payrollDetailSource(line: PayrollLine) {
  const detail = line as DetailedPayrollLine
  const date = detail.work_date || detail.date
  const source = detail.source_type ? titleCase(detail.source_type) : ''
  const reference = detail.source_reference || detail.reference_no || ''
  return [date ? shortDate(date) : '', source, reference].filter(Boolean).join(' · ')
}

function payrollDetailAccount(line: PayrollLine) {
  const kind = payrollDetailKind(line)
  return line.account_code || payrollAccounts[kind][0]
}

function sumPayrollLines(lines: PayrollLine[]) {
  return lines.reduce((sum, line) => sum + numberValue(line.amount), 0)
}

function PaysheetLines({ title, lines }: { title: string; lines: PayrollLine[] }) {
  if (!lines.length) return <EmptyState message={`No ${title.toLowerCase()} recorded for this payroll.`} />
  return (
    <TableWrap>
      <table className="paysheet-data-table">
        <thead>
          <tr>
            <th>Basis / type</th>
            <th>Description / source</th>
            <th className="numeric">Qty</th>
            <th className="numeric">Rate</th>
            <th>Accounting account</th>
            <th className="numeric">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => {
            const source = payrollDetailSource(line)
            return (
              <tr className="paysheet-data-row" key={`${normalizePayrollType(line)}-${index}`}>
                <td><strong>{payrollDetailBasis(line)}</strong><span className="table-subtext">{titleCase(normalizePayrollType(line) || payrollDetailKind(line))}</span></td>
                <td><strong>{payrollDetailLabel(line)}</strong>{source ? <span className="table-subtext">{source}</span> : null}</td>
                <td className="numeric">{numberValue(line.quantity) ? quantity(line.quantity, 3) : '—'}</td>
                <td className="numeric">{numberValue(line.rate) ? money(line.rate) : '—'}</td>
                <td><span className="mono">{payrollDetailAccount(line)}</span></td>
                <td className="numeric"><strong>{money(line.amount)}</strong></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </TableWrap>
  )
}

function isAllowanceOrAdditionalEarning(line: PayrollLine) {
  const type = normalizePayrollType(line)
  return type.includes('allowance') || type.includes('bonus') || type.includes('commission')
}

type MonthlyPaysheetDetail = DetailedPayrollLine & {
  payroll_reference?: string | null
  payroll_date?: string | null
}

type MonthlyPaysheetPayment = Payment & {
  payroll_reference?: string | null
}

type PaysheetSection = 'overview' | 'earnings' | 'allowances' | 'deductions' | 'contributions' | 'payments' | 'accounting'

const paysheetSections: Array<{ value: PaysheetSection; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'earnings', label: 'Salary & work' },
  { value: 'allowances', label: 'Allowances' },
  { value: 'deductions', label: 'Deductions' },
  { value: 'contributions', label: 'Employer contributions' },
  { value: 'payments', label: 'Payments' },
  { value: 'accounting', label: 'Accounting' },
]

function firstPayrollRate(lines: PayrollLine[], test: (type: string) => boolean) {
  const line = lines.find((item) => test(normalizePayrollType(item)) && numberValue(item.rate) > 0)
  return numberValue(line?.rate)
}

function inferredPayModel(lines: PayrollLine[]) {
  const types = lines.map(normalizePayrollType)
  const hasMonthly = types.some((type) => type.includes('monthly'))
  const hasDaily = types.some((type) => type.includes('daily'))
  const hasPiecework = types.some((type) => type.includes('piecework') || type.includes('conversion'))
  if (hasMonthly && (hasDaily || hasPiecework)) return 'hybrid'
  if (hasMonthly) return 'monthly'
  if (hasDaily) return 'daily'
  if (hasPiecework) return 'piecework'
  return ''
}

function printLineType(line: PayrollLine) {
  return payrollDetailBasis(line)
}

export function EmployeePayrollProfileDialog({ payroll, companyName, onClose }: { payroll: Payroll | null; companyName: string; onClose: () => void }) {
  const toast = useToast()
  const [selectedMonth, setSelectedMonth] = useState(() => payroll?.salary_month ?? localIsoMonth())
  const [section, setSection] = useState<PaysheetSection>('overview')

  const employeeId = payroll?.employee_id ?? ''

  const employeeMasterQuery = useQuery({
    queryKey: ['employee-master-paysheet', employeeId],
    queryFn: ({ signal }) => api.get<Employee>(`/employees/${employeeId}`, undefined, signal),
    enabled: Boolean(payroll && employeeId),
    staleTime: 60_000,
  })

  const monthlyPayrollQuery = useQuery({
    queryKey: ['employee-paysheet', employeeId, selectedMonth],
    queryFn: async ({ signal }) => {
      const rows: Payroll[] = []
      for (let apiPage = 1; ; apiPage += 1) {
        const result = await api.list<Payroll>('/reports/payroll', {
          salary_month: selectedMonth,
          status: 'posted',
          page: apiPage,
          page_size: 100,
          descending: false,
        }, signal)

        rows.push(...result.items)
        if (apiPage >= Math.max(1, result.pages || 1)) break
      }

      return rows
        .filter((row) => row.employee_id === employeeId && row.salary_month === selectedMonth && row.status !== 'reversed')
        .sort((a, b) => String(a.payroll_date).localeCompare(String(b.payroll_date)))
    },
    enabled: Boolean(payroll && employeeId && selectedMonth),
  })

  if (!payroll) return null

  const monthlyPayrolls = monthlyPayrollQuery.data ?? []
  const payrollEmployeeSnapshot: Partial<Employee> = monthlyPayrolls[0]?.employee ?? payroll.employee ?? {}
  const employee: Partial<Employee> = employeeMasterQuery.data
    ? {
        ...payrollEmployeeSnapshot,
        ...employeeMasterQuery.data,
        bank_details: employeeMasterQuery.data.bank_details ?? payrollEmployeeSnapshot.bank_details ?? null,
      }
    : payrollEmployeeSnapshot
  const bank = employee.bank_details || {}

  const details: PayrollLine[] = monthlyPayrolls.flatMap((row) =>
    (row.payroll_details ?? []).map((line): MonthlyPaysheetDetail => ({
      ...line,
      payroll_reference: row.reference_no,
      payroll_date: row.payroll_date,
    }))
  )

  const earnings = details.filter((line) => payrollDetailKind(line) === 'earning')
  const workEarnings = earnings.filter((line) => !isAllowanceOrAdditionalEarning(line))
  const allowances = earnings.filter(isAllowanceOrAdditionalEarning)
  const deductions = details.filter((line) => payrollDetailKind(line) === 'deduction')
  const contributions = details.filter((line) => payrollDetailKind(line) === 'contribution')

  const workEarningsTotal = sumPayrollLines(workEarnings)
  const allowanceTotal = sumPayrollLines(allowances)
  const earningsTotal = sumPayrollLines(earnings)
  const deductionsTotal = sumPayrollLines(deductions)
  const contributionsTotal = sumPayrollLines(contributions)

  const gross = monthlyPayrolls.reduce((sum, row) => sum + numberValue(row.gross_pay), 0) || earningsTotal
  const deductionsValue = monthlyPayrolls.reduce((sum, row) => sum + numberValue(row.deductions_total), 0) || deductionsTotal
  const net = monthlyPayrolls.reduce((sum, row) => sum + numberValue(row.net_pay), 0) || Math.max(0, gross - deductionsValue)
  const paid = monthlyPayrolls.reduce((sum, row) => sum + numberValue(row.paid_amount), 0)
  const due = monthlyPayrolls.reduce((sum, row) => sum + numberValue(row.balance_due), 0)
  const totalEmployerCost = gross + contributionsTotal

  const monthlyRate = numberValue(employee.monthly_rate) || firstPayrollRate(workEarnings, (type) => type.includes('monthly'))
  const dailyRate = numberValue(employee.daily_rate) || firstPayrollRate(workEarnings, (type) => type.includes('daily'))
  const otRate = numberValue(employee.ot_rate) || firstPayrollRate(workEarnings, (type) => type.includes('overtime') || type === 'ot')
  const payModel = employee.pay_model || inferredPayModel(workEarnings)
  const epfNumber = employee.epf_no?.trim() || ''
  const etfReference = employee.etf_ref?.trim() || ''

  const employeeEpfAmount = deductions
    .filter((line) => ['employee_epf', 'epf_employee'].includes(normalizePayrollType(line)) || normalizePayrollType(line).includes('employee_epf'))
    .reduce((sum, line) => sum + numberValue(line.amount), 0)
  const employerEpfAmount = contributions
    .filter((line) => ['employer_epf', 'epf_employer'].includes(normalizePayrollType(line)) || normalizePayrollType(line).includes('employer_epf'))
    .reduce((sum, line) => sum + numberValue(line.amount), 0)
  const employerEtfAmount = contributions
    .filter((line) => ['employer_etf', 'etf_employer'].includes(normalizePayrollType(line)) || normalizePayrollType(line).includes('employer_etf'))
    .reduce((sum, line) => sum + numberValue(line.amount), 0)

  const payments: MonthlyPaysheetPayment[] = monthlyPayrolls.flatMap((row) =>
    (row.payroll_payments ?? []).map((payment) => ({ ...payment, payroll_reference: row.reference_no }))
  )

  const initialSettlements = monthlyPayrolls.map((row) => {
    const activeSeparatePayments = (row.payroll_payments ?? []).filter((payment) => payment.status !== 'reversed')
    const separateTotal = activeSeparatePayments.reduce((sum, payment) => sum + numberValue(payment.amount), 0)
    const initial = Math.max(0, numberValue(row.paid_amount) - separateTotal)
    const meta = row as Payroll & { payment_method?: string | null }
    return {
      id: `initial-${row.id}`,
      payroll_reference: row.reference_no,
      payment_date: row.payroll_date,
      method: meta.payment_method || 'payroll_settlement',
      status: 'posted',
      amount: initial,
    }
  }).filter((payment) => payment.amount > 0)

  const allSettlementRows = [...initialSettlements, ...payments]
    .sort((a, b) => String(a.payment_date ?? '').localeCompare(String(b.payment_date ?? '')))

  const hasMonthlyPayroll = monthlyPayrolls.length > 0
  const sectionClass = (value: PaysheetSection) => `paysheet-section${section === value ? ' paysheet-section--active' : ''}`
  const employeeDisplayName = payrollEmployeeDisplay(monthlyPayrolls[0] || payroll)
  const employeeNumber = employee.employee_no || payroll.employee_no || '—'
  const sendPaysheetWhatsApp = () => {
    const phone = normalizeWhatsAppPhone(employee.phone)
    if (!phone) {
      toast.error('WhatsApp message not opened', 'Add a valid phone number to the employee profile first.')
      return
    }
    const references = monthlyPayrolls.map((row) => row.reference_no).filter(Boolean).join(', ')
    const message = payrollWhatsAppMessage({
      employeeName: employeeDisplayName,
      companyName,
      salaryMonth: selectedMonth,
      reference: references || payroll.reference_no,
      gross,
      deductions: deductionsValue,
      net,
      paid,
      due,
    })
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer')
  }

  return (
    <Dialog
      open={Boolean(payroll)}
      title={`Paysheet · ${payrollEmployeeDisplay(payroll)}`}
      description="Select a month, then use the sections below to review the employee's complete salary, allowances, deductions, contributions, payments and accounting detail."
      size="workspace"
      onClose={onClose}
    >
      <style>{`
        .paysheet-window { width: 100%; min-width: 0; gap: 11px !important; }
        .paysheet-topbar {
          position: sticky;
          top: 0;
          z-index: 20;
          display: grid;
          gap: 8px;
          padding: 9px 10px;
          margin-bottom: 11px;
          background: var(--surface, var(--card-background, #fff));
          border: 1px solid var(--border, var(--border-color, #e5e7eb));
          border-radius: 16px;
          box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
        }
        .paysheet-topbar__row { display: flex; align-items: end; justify-content: space-between; gap: 8px 10px; flex-wrap: wrap; }
        .paysheet-month-control { min-width: 190px; flex: 0 1 235px; }
        .paysheet-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
        .paysheet-nav { display: flex; gap: 7px; overflow-x: auto; padding: 2px 0 4px; scrollbar-width: thin; }
        .paysheet-nav__button {
          appearance: none;
          border: 1px solid var(--border, var(--border-color, #dbe1e8));
          background: var(--surface, var(--card-background, #fff));
          color: inherit;
          border-radius: 999px;
          padding: 7px 11px;
          font: inherit;
          font-size: 13px;
          font-weight: 700;
          white-space: nowrap;
          cursor: pointer;
          transition: background .16s ease, border-color .16s ease, box-shadow .16s ease;
        }
        .paysheet-nav__button:hover { background: var(--surface-soft, #f6f7f9); }
        .paysheet-nav__button--active {
          background: var(--text, #111827);
          border-color: var(--text, #111827);
          color: var(--surface, #fff);
          box-shadow: 0 4px 12px rgba(15, 23, 42, 0.14);
        }
        .paysheet-section { display: none; min-width: 0; }
        .paysheet-section--active { display: block; }
        .paysheet-section > * + * { margin-top: 10px; }
        .paysheet-summary-strip { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 7px; margin-bottom: 11px; }
        .paysheet-summary-card {
          min-width: 0;
          padding: 10px 11px;
          border: 1px solid var(--border, var(--border-color, #e5e7eb));
          border-radius: 14px;
          background: var(--surface-soft, #fafafa);
        }
        .paysheet-summary-card span { display: block; font-size: 11px; opacity: .68; margin-bottom: 5px; }
        .paysheet-summary-card strong { display: block; font-size: 15px; overflow-wrap: anywhere; }
.paysheet-overview-breakdown{display:grid;gap:16px}.paysheet-overview-breakdown h4{margin:0 0 8px;font-size:14px}.paysheet-data-table tbody tr td{background:transparent!important}
                .paysheet-master-note { margin: -6px 0 4px; font-size: 12px; opacity: .68; }
        .paysheet-print-document { display: none; }

        @media (max-width: 980px) {
          .paysheet-summary-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        @media (max-width: 640px) {
          .paysheet-topbar { position: static; padding: 10px; }
          .paysheet-topbar__row { align-items: stretch; }
          .paysheet-month-control { min-width: 100%; flex-basis: 100%; }
          .paysheet-actions { width: 100%; justify-content: stretch; }
          .paysheet-actions > * { flex: 1 1 auto; }
          .paysheet-summary-strip { grid-template-columns: 1fr 1fr; }
        }

        @media print {
          @page { size: A4 portrait; margin: 8mm 9mm 9mm; }
          html, body { background: #fff !important; }
          body * { visibility: hidden !important; }
          .paysheet-print-document, .paysheet-print-document * { visibility: visible !important; }
          .paysheet-print-document {
            display: block !important;
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            margin: 0 !important;
            padding: 0 !important;
            color: #111318 !important;
            background: #fff !important;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI", Arial, sans-serif !important;
            font-size: 9.2pt !important;
            line-height: 1.25 !important;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
          .paysheet-print-document * { box-sizing: border-box !important; }
          .ps-print-shell { width: 100%; }
          .ps-print-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 12mm;
            padding-bottom: 4mm;
            margin-bottom: 4mm;
            border-bottom: 1.2px solid #d8dce3;
          }
          .ps-print-kicker { font-size: 7.5pt; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: #6b7280; }
          .ps-print-title { margin: 1mm 0 0; font-size: 21pt; line-height: 1.05; font-weight: 760; letter-spacing: -.025em; }
          .ps-print-subtitle { margin-top: 1.2mm; font-size: 9pt; color: #5d6470; }
          .ps-print-month { min-width: 42mm; text-align: right; }
          .ps-print-month strong { display: block; font-size: 14pt; line-height: 1.1; }
          .ps-print-month span { display: block; margin-top: 1mm; font-size: 8pt; color: #6b7280; }
          .ps-print-employee {
            display: grid;
            grid-template-columns: 1.6fr repeat(3, 1fr);
            border: 1px solid #dfe3e9;
            border-radius: 10px;
            overflow: hidden;
            margin-bottom: 3.5mm;
          }
          .ps-print-cell { padding: 2.1mm 2.5mm; min-width: 0; border-right: 1px solid #e6e9ee; border-bottom: 1px solid #e6e9ee; }
          .ps-print-cell:nth-child(4n) { border-right: 0; }
          .ps-print-cell:nth-last-child(-n+4) { border-bottom: 0; }
          .ps-print-cell label { display: block; margin-bottom: .7mm; color: #777e89; font-size: 6.9pt; font-weight: 650; text-transform: uppercase; letter-spacing: .045em; }
          .ps-print-cell strong { display: block; font-size: 9.2pt; font-weight: 690; overflow-wrap: anywhere; }
          .ps-print-summary { display: grid; grid-template-columns: repeat(5, 1fr); gap: 2mm; margin-bottom: 4mm; }
          .ps-print-summary-card { border: 1px solid #dfe3e9; border-radius: 8px; padding: 1.8mm 2.1mm; background: #fff; }
          .ps-print-summary-card span { display: block; color: #6e7480; font-size: 6.9pt; margin-bottom: .7mm; }
          .ps-print-summary-card strong { display: block; font-size: 10.5pt; font-weight: 760; white-space: nowrap; }
          .ps-print-section { margin-top: 2.6mm; break-inside: auto; }
          .ps-print-section-header { display: flex; justify-content: space-between; align-items: end; gap: 6mm; margin-bottom: 1.5mm; }
          .ps-print-section-header h2 { margin: 0; font-size: 10.5pt; line-height: 1.15; font-weight: 760; }
          .ps-print-section-header span { font-size: 7.4pt; color: #747b86; }
          .ps-print-table { width: 100%; border-collapse: separate; border-spacing: 0; border: 1px solid #e0e4ea; border-radius: 8px; overflow: hidden; font-size: 7.9pt; }
          .ps-print-table thead { display: table-header-group; }
          .ps-print-table th { padding: 1.25mm 1.55mm; background: #f4f5f7; border-bottom: 1px solid #dfe3e9; color: #666d78; font-size: 6.6pt; font-weight: 720; letter-spacing: .035em; text-transform: uppercase; text-align: left; }
          .ps-print-table td { padding: 1.25mm 1.55mm; border-bottom: 1px solid #eceef2; vertical-align: top; }
          .ps-print-table tr:last-child td { border-bottom: 0; }
          .ps-print-table tr { break-inside: avoid; }
          .ps-print-table .num { text-align: right; white-space: nowrap; }
          .ps-print-table .muted { color: #777e89; font-size: 7pt; margin-top: .3mm; }
          .ps-print-total-row td { font-weight: 760; background: #f7f8fa; }
          .ps-print-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm; align-items: start; }
          .ps-print-note { margin-top: 3.5mm; padding-top: 2mm; border-top: 1px solid #e5e7eb; color: #7a808a; font-size: 6.8pt; text-align: center; }
          .ps-print-accounting { font-size: 7.4pt; }
          .no-print, .paysheet-window > :not(.paysheet-print-document) { display: none !important; }
        }
      `}</style>

      <div className="form-stack print-area paysheet-window">
        <div className="paysheet-topbar no-print">
          <div className="paysheet-topbar__row">
            <label className="payroll-month-filter paysheet-month-control">
              <span>Paysheet month</span>
              <Input type="month" value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)} />
            </label>

            <div className="paysheet-actions">
              <div className="input-like">
                <strong>{monthLabel(selectedMonth)}</strong>
                <span className="table-subtext">{monthlyPayrollQuery.isFetching ? 'Loading…' : `${monthlyPayrolls.length} payroll record${monthlyPayrolls.length === 1 ? '' : 's'}`}</span>
              </div>
              <Button variant="secondary" icon={MessageCircle} onClick={sendPaysheetWhatsApp} disabled={!hasMonthlyPayroll}>WhatsApp</Button>
              <Button variant="secondary" icon={Printer} onClick={() => window.print()} disabled={!hasMonthlyPayroll}>Print / save PDF</Button>
              <Button variant="secondary" onClick={onClose}>Close</Button>
            </div>
          </div>

          <nav className="paysheet-nav" aria-label="Paysheet sections">
            {paysheetSections.map((item) => (
              <button key={item.value} type="button" className={`paysheet-nav__button${section === item.value ? ' paysheet-nav__button--active' : ''}`} onClick={() => setSection(item.value)} aria-pressed={section === item.value}>
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        {monthlyPayrollQuery.isLoading || monthlyPayrollQuery.isFetching && !monthlyPayrollQuery.data ? <LoadingState /> : monthlyPayrollQuery.isError ? (
          <ErrorState error={monthlyPayrollQuery.error} onRetry={() => void monthlyPayrollQuery.refetch()} />
        ) : !hasMonthlyPayroll ? (
          <EmptyState message={`No posted payroll exists for ${payrollEmployeeDisplay(payroll)} in ${monthLabel(selectedMonth)}.`} />
        ) : (
          <>
            <div className="paysheet-summary-strip">
              <div className="paysheet-summary-card"><span>Gross earnings</span><strong>{money(gross)}</strong></div>
              <div className="paysheet-summary-card"><span>Deductions</span><strong>{money(deductionsValue)}</strong></div>
              <div className="paysheet-summary-card"><span>Net pay</span><strong>{money(net)}</strong></div>
              <div className="paysheet-summary-card"><span>Paid</span><strong>{money(paid)}</strong></div>
              <div className="paysheet-summary-card"><span>Balance due</span><strong>{money(due)}</strong></div>
            </div>

            <section className={sectionClass('overview')}>
              <SectionTitle title="Monthly paysheet overview" description={`Complete posted payroll for ${monthLabel(selectedMonth)}. Multiple payroll postings in the month are combined without hiding their individual references.`} />
              {employeeMasterQuery.isFetching ? <div className="paysheet-master-note">Loading the latest employee master record…</div> : employeeMasterQuery.data ? <div className="paysheet-master-note">Rates, EPF/ETF references and staff details are read from the employee master record.</div> : <div className="paysheet-master-note">Employee master details were not returned; the payroll snapshot and recorded payroll rates are being used.</div>}

              <div className="form-grid form-grid--four">
                <Field label="Employee"><div className="input-like"><strong>{employeeDisplayName}</strong></div></Field>
                <Field label="Employee number"><div className="input-like">{employeeNumber}</div></Field>
                <Field label="Paysheet month"><div className="input-like"><strong>{monthLabel(selectedMonth)}</strong></div></Field>
                <Field label="Pay model"><div className="input-like"><strong>{payModel ? titleCase(payModel) : '—'}</strong></div></Field>
                <Field label="NIC"><div className="input-like">{employee.nic || '—'}</div></Field>
                <Field label="Job role"><div className="input-like">{employee.job_role || '—'}</div></Field>
                <Field label="Employment type"><div className="input-like">{employee.employment_type ? titleCase(employee.employment_type) : '—'}</div></Field>
                <Field label="Shift"><div className="input-like">{employee.shift || '—'}</div></Field>
                <Field label="Monthly rate"><div className="input-like"><strong>{money(monthlyRate)}</strong></div></Field>
                <Field label="Daily rate"><div className="input-like"><strong>{money(dailyRate)}</strong></div></Field>
                <Field label="OT rate"><div className="input-like"><strong>{money(otRate)}</strong></div></Field>
                <Field label="EPF / ETF"><div className="input-like"><strong>{epfNumber || 'No EPF'} · {etfReference || 'No ETF'}</strong></div></Field>
              </div>

              <SectionTitle title="Payroll records in this month" description="Every active payroll posting used to build this monthly paysheet." />
              <TableWrap>
                <table>
                  <thead><tr><th>Date / reference</th><th>Status</th><th className="numeric">Gross</th><th className="numeric">Deductions</th><th className="numeric">Net</th><th className="numeric">Paid</th><th className="numeric">Due</th></tr></thead>
                  <tbody>
                    {monthlyPayrolls.map((row) => (
                      <tr key={row.id}>
                        <td><strong className="mono">{row.reference_no || row.id.slice(0, 8)}</strong><span className="table-subtext">{shortDate(row.payroll_date)}</span></td>
                        <td><Badge tone={statusTone(row.payment_status)}>{titleCase(row.payment_status ?? 'payable')}</Badge></td>
                        <td className="numeric">{money(row.gross_pay)}</td>
                        <td className="numeric">{money(row.deductions_total)}</td>
                        <td className="numeric"><strong>{money(row.net_pay)}</strong></td>
                        <td className="numeric">{money(row.paid_amount)}</td>
                        <td className="numeric">{money(row.balance_due)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>

              <SectionTitle title="Monthly pay calculation" />
              <TableWrap>
                <table>
                  <tbody>
                    <tr><td>Salary / work earnings</td><td className="numeric">{money(workEarningsTotal)}</td></tr>
                    <tr><td>Allowances & additional earnings</td><td className="numeric">{money(allowanceTotal)}</td></tr>
                    <tr><td><strong>Gross earnings</strong></td><td className="numeric"><strong>{money(gross)}</strong></td></tr>
                    <tr><td>Employee deductions</td><td className="numeric">({money(deductionsValue)})</td></tr>
                    <tr><td><strong>Net pay</strong></td><td className="numeric"><strong>{money(net)}</strong></td></tr>
                    <tr><td>Employer contributions</td><td className="numeric">{money(contributionsTotal)}</td></tr>
                    <tr><td><strong>Total employer payroll cost</strong></td><td className="numeric"><strong>{money(totalEmployerCost)}</strong></td></tr>
                    <tr><td>Amount paid</td><td className="numeric">{money(paid)}</td></tr>
                    <tr><td>Balance due</td><td className="numeric"><strong>{money(due)}</strong></td></tr>
                  </tbody>
                </table>
              </TableWrap>

              <SectionTitle title="Detailed monthly breakdown" description="Every earning, allowance and deduction used in this paysheet is shown below instead of only showing summary totals." />
              <div className="paysheet-overview-breakdown">
                <div><h4>Salary & work earnings</h4><PaysheetLines title="Salary & work earnings" lines={workEarnings} /></div>
                <div><h4>Allowances & additional earnings</h4><PaysheetLines title="Allowances & additional earnings" lines={allowances} /></div>
                <div><h4>Employee deductions</h4><PaysheetLines title="Employee deductions" lines={deductions} /></div>
              </div>

              <SectionTitle title="Bank details" />
              <div className="form-grid form-grid--four">
                <Field label="Bank"><div className="input-like">{bank.bank_name || '—'}</div></Field>
                <Field label="Branch"><div className="input-like">{bank.branch || '—'}</div></Field>
                <Field label="Account name"><div className="input-like">{bank.account_name || '—'}</div></Field>
                <Field label="Account number"><div className="input-like">{bank.account_number || '—'}</div></Field>
              </div>
            </section>

            <section className={sectionClass('earnings')}>
              <SectionTitle title="Salary & work earnings" description="Monthly salary, daily wages, overtime, piecework and other direct work earnings recorded for the selected month." />
              <PaysheetLines title="Salary & work earnings" lines={workEarnings} />
              <div className="form-total"><span>Salary / work earnings total</span><strong>{money(workEarningsTotal)}</strong></div>
            </section>

            <section className={sectionClass('allowances')}>
              <SectionTitle title="Allowances & additional earnings" description="Every allowance and additional earning is listed separately so the employee can clearly see how gross pay was built." />
              <PaysheetLines title="Allowances & additional earnings" lines={allowances} />
              <div className="form-total"><span>Total allowances & additional earnings</span><strong>{money(allowanceTotal)}</strong></div>
            </section>

            <section className={sectionClass('deductions')}>
              <SectionTitle title="Employee deductions" description="EPF, salary advances, loan repayments, no-pay, tax and every other deduction applied in the selected month." />
              <PaysheetLines title="Employee deductions" lines={deductions} />
              <div className="form-total"><span>Total employee deductions</span><strong>{money(deductionsValue)}</strong></div>
            </section>

            <section className={sectionClass('contributions')}>
              <SectionTitle title="Employer contributions" description="Employer EPF, ETF, insurance and other employer-side contributions. These do not reduce employee net pay." />
              <PaysheetLines title="Employer contributions" lines={contributions} />
              <div className="form-total"><span>Total employer contributions</span><strong>{money(contributionsTotal)}</strong></div>
            </section>

            <section className={sectionClass('payments')}>
              <SectionTitle title="Payment / settlement history" description="All payments for the selected month are shown with their payroll reference. Reversed payments remain visible for audit history." />
              {allSettlementRows.length ? (
                <TableWrap>
                  <table>
                    <thead><tr><th>Payment date</th><th>Payroll reference</th><th>Payment reference</th><th>Method</th><th>Status</th><th className="numeric">Amount</th></tr></thead>
                    <tbody>
                      {allSettlementRows.map((payment, index) => (
                        <tr key={`${payment.id}-${index}`}>
                          <td>{shortDate(payment.payment_date)}</td>
                          <td className="mono">{payment.payroll_reference || '—'}</td>
                          <td className="mono">{'reference_no' in payment && payment.reference_no ? payment.reference_no : 'Initial settlement'}</td>
                          <td>{titleCase(payment.method)}</td>
                          <td><Badge tone={statusTone(payment.status)}>{titleCase(payment.status ?? 'posted')}</Badge></td>
                          <td className="numeric"><strong>{money(payment.amount)}</strong></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              ) : <EmptyState message="No payment has been settled against this month's payroll." />}
            </section>

            <section className={sectionClass('accounting')}>
              <SectionTitle title="Accounting posting detail" description="Each payroll component keeps its accounting account mapping. This view reads the posted payroll data and does not create a second journal entry." />
              <TableWrap>
                <table>
                  <thead><tr><th>Payroll component</th><th>Category</th><th>Account code</th><th className="numeric">Amount</th></tr></thead>
                  <tbody>
                    {workEarnings.map((line, index) => <tr key={`acc-w-${index}`}><td>{payrollDetailLabel(line)}</td><td>Salary / work earning</td><td className="mono">{payrollDetailAccount(line)}</td><td className="numeric">{money(line.amount)}</td></tr>)}
                    {allowances.map((line, index) => <tr key={`acc-a-${index}`}><td>{payrollDetailLabel(line)}</td><td>Allowance / additional earning</td><td className="mono">{payrollDetailAccount(line)}</td><td className="numeric">{money(line.amount)}</td></tr>)}
                    {deductions.map((line, index) => <tr key={`acc-d-${index}`}><td>{payrollDetailLabel(line)}</td><td>Employee deduction / payable</td><td className="mono">{payrollDetailAccount(line)}</td><td className="numeric">{money(line.amount)}</td></tr>)}
                    {contributions.map((line, index) => <tr key={`acc-c-${index}`}><td>{payrollDetailLabel(line)}</td><td>Employer contribution / payable</td><td className="mono">{payrollDetailAccount(line)}</td><td className="numeric">{money(line.amount)}</td></tr>)}
                    {!details.length ? <tr><td colSpan={4}>No payroll detail lines were returned for this month.</td></tr> : null}
                  </tbody>
                </table>
              </TableWrap>
            </section>
          </>
        )}

        {hasMonthlyPayroll ? (
          <div className="paysheet-print-document" aria-hidden="true">
            <div className="ps-print-shell">
              <header className="ps-print-header">
                <div>
                  <div className="ps-print-kicker">Confidential employee payroll</div>
                  <h1 className="ps-print-title">Monthly Paysheet</h1>
                  <div className="ps-print-subtitle">{employeeDisplayName} · {employeeNumber}</div>
                </div>
                <div className="ps-print-month"><strong>{monthLabel(selectedMonth)}</strong><span>{monthlyPayrolls.map((row) => row.reference_no).filter(Boolean).join(' · ') || `${monthlyPayrolls.length} payroll record${monthlyPayrolls.length === 1 ? '' : 's'}`}</span></div>
              </header>

              <section className="ps-print-employee">
                <div className="ps-print-cell"><label>Employee</label><strong>{employeeDisplayName}</strong></div>
                <div className="ps-print-cell"><label>Employee no.</label><strong>{employeeNumber}</strong></div>
                <div className="ps-print-cell"><label>NIC</label><strong>{employee.nic || '—'}</strong></div>
                <div className="ps-print-cell"><label>Role</label><strong>{employee.job_role || '—'}</strong></div>
                <div className="ps-print-cell"><label>Pay model</label><strong>{payModel ? titleCase(payModel) : '—'}</strong></div>
                <div className="ps-print-cell"><label>Monthly rate</label><strong>{money(monthlyRate)}</strong></div>
                <div className="ps-print-cell"><label>Daily / OT rate</label><strong>{money(dailyRate)} / {money(otRate)}</strong></div>
                <div className="ps-print-cell"><label>EPF / ETF</label><strong>{epfNumber || 'No EPF'} · {etfReference || 'No ETF'}</strong></div>
              </section>

              <section className="ps-print-summary">
                <div className="ps-print-summary-card"><span>Gross earnings</span><strong>{money(gross)}</strong></div>
                <div className="ps-print-summary-card"><span>Deductions</span><strong>{money(deductionsValue)}</strong></div>
                <div className="ps-print-summary-card"><span>Net pay</span><strong>{money(net)}</strong></div>
                <div className="ps-print-summary-card"><span>Paid</span><strong>{money(paid)}</strong></div>
                <div className="ps-print-summary-card"><span>Balance due</span><strong>{money(due)}</strong></div>
              </section>

              <section className="ps-print-section">
                <div className="ps-print-section-header"><h2>Earnings & additions</h2><span>Gross {money(gross)}</span></div>
                <table className="ps-print-table">
                  <thead><tr><th>Category</th><th>Description / source</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Amount</th></tr></thead>
                  <tbody>
                    {[...workEarnings, ...allowances].length ? [...workEarnings, ...allowances].map((line, index) => (
                      <tr key={`print-earning-${index}`}>
                        <td>{isAllowanceOrAdditionalEarning(line) ? 'Allowance / addition' : printLineType(line)}</td>
                        <td><strong>{payrollDetailLabel(line)}</strong>{payrollDetailSource(line) ? <div className="muted">{payrollDetailSource(line)}</div> : null}</td>
                        <td className="num">{numberValue(line.quantity) ? quantity(line.quantity, 3) : '—'}</td>
                        <td className="num">{numberValue(line.rate) ? money(line.rate) : '—'}</td>
                        <td className="num"><strong>{money(line.amount)}</strong></td>
                      </tr>
                    )) : <tr><td colSpan={5}>No earnings recorded.</td></tr>}
                    <tr className="ps-print-total-row"><td colSpan={4}>Gross earnings</td><td className="num">{money(gross)}</td></tr>
                  </tbody>
                </table>
              </section>

              <section className="ps-print-section">
                <div className="ps-print-section-header"><h2>Employee deductions</h2><span>Total {money(deductionsValue)}</span></div>
                <table className="ps-print-table">
                  <thead><tr><th>Deduction</th><th>Description</th><th>Account</th><th className="num">Amount</th></tr></thead>
                  <tbody>
                    {deductions.length ? deductions.map((line, index) => (
                      <tr key={`print-ded-${index}`}>
                        <td>{titleCase(normalizePayrollType(line) || 'Deduction')}</td>
                        <td>{payrollDetailLabel(line)}</td>
                        <td>{payrollDetailAccount(line)}</td>
                        <td className="num"><strong>{money(line.amount)}</strong></td>
                      </tr>
                    )) : <tr><td colSpan={4}>No employee deductions recorded.</td></tr>}
                    <tr className="ps-print-total-row"><td colSpan={3}>Total employee deductions</td><td className="num">{money(deductionsValue)}</td></tr>
                    <tr className="ps-print-total-row"><td colSpan={3}>Net pay</td><td className="num">{money(net)}</td></tr>
                  </tbody>
                </table>
              </section>

              <section className="ps-print-section ps-print-two-col">
                <div>
                  <div className="ps-print-section-header"><h2>Employer / statutory</h2><span>{money(contributionsTotal)}</span></div>
                  <table className="ps-print-table"><tbody>
                    <tr><td>Employee EPF</td><td className="num">{money(employeeEpfAmount)}</td></tr>
                    <tr><td>Employer EPF</td><td className="num">{money(employerEpfAmount)}</td></tr>
                    <tr><td>Employer ETF</td><td className="num">{money(employerEtfAmount)}</td></tr>
                    <tr><td>Employer contributions</td><td className="num">{money(contributionsTotal)}</td></tr>
                    <tr className="ps-print-total-row"><td>Total employer payroll cost</td><td className="num">{money(totalEmployerCost)}</td></tr>
                  </tbody></table>
                </div>
                <div>
                  <div className="ps-print-section-header"><h2>Settlement</h2><span>{titleCase(monthlyPayrolls[monthlyPayrolls.length - 1]?.payment_status ?? 'payable')}</span></div>
                  <table className="ps-print-table"><tbody>
                    <tr><td>Net pay</td><td className="num"><strong>{money(net)}</strong></td></tr>
                    <tr><td>Paid</td><td className="num">{money(paid)}</td></tr>
                    <tr><td>Balance due</td><td className="num"><strong>{money(due)}</strong></td></tr>
                    <tr><td>Bank</td><td className="num">{bank.bank_name || '—'}</td></tr>
                    <tr><td>Account</td><td className="num">{bank.account_number || '—'}</td></tr>
                  </tbody></table>
                </div>
              </section>

              {allSettlementRows.length ? (
                <section className="ps-print-section">
                  <div className="ps-print-section-header"><h2>Payment history</h2><span>{allSettlementRows.length} record{allSettlementRows.length === 1 ? '' : 's'}</span></div>
                  <table className="ps-print-table">
                    <thead><tr><th>Date</th><th>Reference</th><th>Method</th><th>Status</th><th className="num">Amount</th></tr></thead>
                    <tbody>{allSettlementRows.map((payment, index) => <tr key={`print-pay-${index}`}><td>{shortDate(payment.payment_date)}</td><td>{'reference_no' in payment && payment.reference_no ? payment.reference_no : payment.payroll_reference || 'Initial settlement'}</td><td>{titleCase(payment.method)}</td><td>{titleCase(payment.status ?? 'posted')}</td><td className="num">{money(payment.amount)}</td></tr>)}</tbody>
                  </table>
                </section>
              ) : null}

              <div className="ps-print-note">{monthLabel(selectedMonth)} · {employeeDisplayName} · Payroll accounting detail remains available in the system record.</div>
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}
