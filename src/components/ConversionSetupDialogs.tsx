import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Tags, Wrench } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { api } from '../lib/api'
import { localIsoDate } from '../lib/format'
import type { ConversionType, MutationReceipt, PieceworkRate } from '../types/api'
import { Dialog } from './Dialog'
import { useToast } from './Toast'
import { Button, Field, Input, Select, Textarea } from './UI'

const conversionTypeSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(2, 'Conversion type is required.').max(160),
  default_chip_name: z.string().trim().max(160).optional(),
  status: z.enum(['active', 'inactive']),
  notes: z.string().trim().max(1000).optional(),
})

const rateSchema = z.object({
  id: z.string().optional(),
  conversion_type_id: z.string().optional(),
  work_type: z.string().trim().min(2, 'Work type is required.').max(160),
  rate_per_kg: z.coerce.number().positive('Rate must be greater than zero.'),
  effective_from: z.string().min(1, 'Effective date is required.'),
  effective_to: z.string().optional(),
  status: z.enum(['active', 'inactive']),
  notes: z.string().trim().max(1000).optional(),
}).refine((value) => !value.effective_to || value.effective_to >= value.effective_from, {
  message: 'End date cannot be before start date.',
  path: ['effective_to'],
})

type ConversionTypeValues = z.infer<typeof conversionTypeSchema>
type RateValues = z.infer<typeof rateSchema>

async function invalidateConversionSetup(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['conversion-types'] }),
    queryClient.invalidateQueries({ queryKey: ['piecework-rates'] }),
    queryClient.invalidateQueries({ queryKey: ['lookup'] }),
  ])
}

export function ConversionTypeDialog({
  open,
  record,
  onClose,
}: {
  open: boolean
  record?: ConversionType | null | undefined
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const form = useForm<ConversionTypeValues>({
    resolver: zodResolver(conversionTypeSchema),
    values: {
      id: record?.id,
      name: record?.name ?? '',
      default_chip_name: record?.default_chip_name ?? '',
      status: record?.status === 'inactive' ? 'inactive' : 'active',
      notes: record?.notes ?? '',
    },
  })
  const mutation = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: Record<string, unknown> }) => id
      ? api.patch<MutationReceipt, Record<string, unknown>>(`/conversion-types/${id}`, body)
      : api.post<MutationReceipt, Record<string, unknown>>('/conversion-types', body),
    onSuccess: async () => {
      await invalidateConversionSetup(queryClient)
      toast.success('Conversion type saved', 'The type is ready to use in bulk-to-chip entries.')
      onClose()
    },
    onError: (error) => toast.error('Conversion type not saved', error.message),
  })
  const submit = form.handleSubmit(({ id, ...values }) => mutation.mutate({
    ...(id ? { id } : {}),
    body: {
      ...values,
      default_chip_name: values.default_chip_name || null,
      notes: values.notes || null,
    },
  }))
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={record ? 'Edit conversion type' : 'Add conversion type'}
      description="Saved types appear in the bulk-to-chip conversion dropdown."
      closeDisabled={mutation.isPending}
      footer={<><Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button><Button icon={Tags} loading={mutation.isPending} onClick={() => void submit()}>Save type</Button></>}
    >
      <form className="form-grid form-grid--two" onSubmit={(event) => void submit(event)}>
        <Field label="Conversion type" required error={form.formState.errors.name?.message}>
          <Input {...form.register('name')} placeholder="Example: Bulk rubber to 10 mm chip" />
        </Field>
        <Field label="Default chip stock name" error={form.formState.errors.default_chip_name?.message} hint="Prefills the output name; it can still be changed while posting.">
          <Input {...form.register('default_chip_name')} placeholder="Example: 10 mm rubber chip" />
        </Field>
        <Field label="Status">
          <Select {...form.register('status')}><option value="active">Active</option><option value="inactive">Inactive</option></Select>
        </Field>
        <Field label="Notes" error={form.formState.errors.notes?.message}>
          <Textarea rows={2} {...form.register('notes')} />
        </Field>
      </form>
    </Dialog>
  )
}

export function PieceworkRateDialog({
  open,
  record,
  onClose,
}: {
  open: boolean
  record?: PieceworkRate | null | undefined
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const typesQuery = useQuery({
    queryKey: ['conversion-types', 'rate-dialog'],
    queryFn: ({ signal }) => api.list<ConversionType>('/conversion-types', { page: 1, page_size: 100, status: 'active', descending: false }, signal),
    enabled: open,
    staleTime: 30_000,
  })
  const form = useForm<RateValues>({
    resolver: zodResolver(rateSchema),
    values: {
      id: record?.id,
      conversion_type_id: record?.conversion_type_id ?? '',
      work_type: record?.work_type ?? record?.type ?? '',
      rate_per_kg: Number(record?.rate_per_kg ?? 0),
      effective_from: record?.effective_from ?? localIsoDate(),
      effective_to: record?.effective_to ?? '',
      status: record?.status === 'inactive' ? 'inactive' : 'active',
      notes: record?.notes ?? '',
    },
  })
  const selectedTypeId = form.watch('conversion_type_id') ?? ''
  const types = typesQuery.data?.items ?? []
  const mutation = useMutation({
    mutationFn: ({ id, body }: { id?: string; body: Record<string, unknown> }) => id
      ? api.patch<MutationReceipt, Record<string, unknown>>(`/piecework-rates/${id}`, body)
      : api.post<MutationReceipt, Record<string, unknown>>('/piecework-rates', body),
    onSuccess: async () => {
      await invalidateConversionSetup(queryClient)
      toast.success('Conversion rate saved', 'The effective-dated rate is ready for worker allocation.')
      onClose()
    },
    onError: (error) => toast.error('Conversion rate not saved', error.message),
  })
  const submit = form.handleSubmit(({ id, ...values }) => mutation.mutate({
    ...(id ? { id } : {}),
    body: {
      ...values,
      conversion_type_id: values.conversion_type_id || null,
      effective_to: values.effective_to || null,
      notes: values.notes || null,
    },
  }))
  const workTypeField = form.register('work_type')

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={record ? 'Edit conversion rate' : 'Add conversion rate'}
      description="Link a rate to a saved conversion type, or choose Manual and enter a standalone work type."
      closeDisabled={mutation.isPending}
      footer={<><Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button><Button icon={Wrench} loading={mutation.isPending} onClick={() => void submit()}>Save rate</Button></>}
    >
      <form className="form-grid form-grid--two" onSubmit={(event) => void submit(event)}>
        <Field label="Conversion type" hint={typesQuery.isError ? 'Saved types could not be loaded. Manual entry is still available.' : undefined}>
          <Select
            aria-label="Rate conversion type"
            value={selectedTypeId || '__manual__'}
            onChange={(event) => {
              const value = event.target.value
              if (value === '__manual__') {
                form.setValue('conversion_type_id', '')
                return
              }
              const selected = types.find((item) => item.id === value)
              form.setValue('conversion_type_id', value)
              if (selected) form.setValue('work_type', selected.name, { shouldValidate: true })
            }}
          >
            <option value="__manual__">Manual — type a work type</option>
            {typesQuery.isLoading ? <option value="" disabled>Loading saved types…</option> : null}
            {types.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select>
        </Field>
        <Field label="Work type" required error={form.formState.errors.work_type?.message} hint={selectedTypeId ? 'Filled from the saved type. Editing it switches this rate to Manual.' : 'Stored on every worker earning as a readable snapshot.'}>
          <Input {...workTypeField} onChange={(event) => { void workTypeField.onChange(event); if (selectedTypeId) form.setValue('conversion_type_id', '') }} placeholder="Enter the work performed" />
        </Field>
        <Field label="Rate per kg" required error={form.formState.errors.rate_per_kg?.message}>
          <Input type="number" min="0.01" step="0.01" {...form.register('rate_per_kg')} />
        </Field>
        <Field label="Effective from" required error={form.formState.errors.effective_from?.message}>
          <Input type="date" {...form.register('effective_from')} />
        </Field>
        <Field label="Effective to" error={form.formState.errors.effective_to?.message}>
          <Input type="date" {...form.register('effective_to')} />
        </Field>
        <Field label="Status">
          <Select {...form.register('status')}><option value="active">Active</option><option value="inactive">Inactive</option></Select>
        </Field>
        <Field label="Notes" className="field--span-2" error={form.formState.errors.notes?.message}>
          <Textarea rows={2} {...form.register('notes')} />
        </Field>
      </form>
    </Dialog>
  )
}
