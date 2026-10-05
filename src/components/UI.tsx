import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Inbox,
  LoaderCircle,
  RefreshCw,
  Search,
  type LucideIcon,
} from 'lucide-react'
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { clsx } from 'clsx'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | undefined
  size?: 'small' | 'medium' | undefined
  loading?: boolean | undefined
  icon?: LucideIcon | undefined
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'medium', loading = false, icon: Icon, className, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={clsx('button', `button--${variant}`, `button--${size}`, className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : Icon ? <Icon size={17} aria-hidden="true" /> : null}
      {children}
    </button>
  )
})

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function Card({ className, ...props }, ref) {
  return <div ref={ref} className={clsx('card', className)} {...props} />
})

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string | undefined
  title: string
  description: string
  actions?: ReactNode | undefined
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  )
}

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'blue',
  onClick,
  ariaLabel,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode | undefined
  icon: LucideIcon
  tone?: 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'slate' | undefined
  onClick?: (() => void) | undefined
  ariaLabel?: string | undefined
}) {
  const content = (
    <>
      <div className={`stat-card__icon stat-card__icon--${tone}`}><Icon size={21} /></div>
      <div className="stat-card__content">
        <span>{label}</span>
        <strong>{value}</strong>
        {hint ? <small>{hint}</small> : null}
      </div>
    </>
  )
  if (onClick) return (
    <button type="button" className="card stat-card stat-card--interactive" onClick={onClick} aria-label={ariaLabel ?? `View ${label} details`}>
      {content}
    </button>
  )
  return <Card className="stat-card">{content}</Card>
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'purple' | undefined
}) {
  return <span className={`badge badge--${tone}`}>{children}</span>
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
  ariaLabel,
}: {
  value: T
  onChange: (value: T) => void
  items: Array<{ value: T; label: string; icon?: LucideIcon | undefined; count?: number | undefined }>
  ariaLabel: string
}) {
  return (
    <div className="tabs" role="tablist" aria-label={ariaLabel}>
      {items.map((item) => {
        const Icon = item.icon
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={item.value === value}
            className={clsx('tabs__item', item.value === value && 'tabs__item--active')}
            onClick={() => onChange(item.value)}
          >
            {Icon ? <Icon size={16} /> : null}
            {item.label}
            {item.count !== undefined ? <span className="tabs__count">{item.count}</span> : null}
          </button>
        )
      })}
    </div>
  )
}

export function Field({
  label,
  error,
  hint,
  required,
  children,
  className,
}: {
  label: string
  error?: string | undefined
  hint?: string | undefined
  required?: boolean | undefined
  children: ReactNode
  className?: string | undefined
}) {
  return (
    <label className={clsx('field', className)}>
      <span className="field__label">{label}{required ? <b aria-hidden="true"> *</b> : null}</span>
      {children}
      {error ? <span className="field__error" role="alert">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={clsx('input', className)} {...props} />
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...props }, ref) {
  return <select ref={ref} className={clsx('input', 'select', className)} {...props} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={clsx('input', 'textarea', className)} {...props} />
})

export function SearchBox({ value, onChange, placeholder = 'Search…', label = 'Search' }: {
  value: string
  onChange: (value: string) => void
  placeholder?: string | undefined
  label?: string | undefined
}) {
  return (
    <label className="search-box">
      <span className="sr-only">{label}</span>
      <Search size={17} aria-hidden="true" />
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </label>
  )
}

export function LoadingState({ label = 'Loading data…' }: { label?: string | undefined }) {
  return (
    <div className="state-panel" role="status">
      <LoaderCircle className="spin" size={28} />
      <strong>{label}</strong>
      <span>Please wait while the latest records are retrieved.</span>
    </div>
  )
}

export function EmptyState({ title = 'No records yet', message, action }: { title?: string | undefined; message: string; action?: ReactNode | undefined }) {
  return (
    <div className="state-panel">
      <Inbox size={31} />
      <strong>{title}</strong>
      <span>{message}</span>
      {action}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: (() => void) | undefined }) {
  const message = error instanceof Error ? error.message : 'An unexpected error occurred.'
  return (
    <div className="state-panel state-panel--error" role="alert">
      <AlertTriangle size={31} />
      <strong>Unable to load this view</strong>
      <span>{message}</span>
      {onRetry ? <Button variant="secondary" icon={RefreshCw} onClick={onRetry}>Try again</Button> : null}
    </div>
  )
}

export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="table-wrap">{children}</div>
}

export function Pagination({ page, pages, total, onChange }: { page: number; pages: number; total: number; onChange: (page: number) => void }) {
  if (pages <= 1) return total ? <div className="pagination pagination--single">{total} record{total === 1 ? '' : 's'}</div> : null
  return (
    <nav className="pagination" aria-label="Pagination">
      <span>{total} records · Page {page} of {pages}</span>
      <div>
        <Button variant="secondary" size="small" onClick={() => onChange(page - 1)} disabled={page <= 1} aria-label="Previous page"><ChevronLeft size={16} /></Button>
        <Button variant="secondary" size="small" onClick={() => onChange(page + 1)} disabled={page >= pages} aria-label="Next page"><ChevronRight size={16} /></Button>
      </div>
    </nav>
  )
}

export function FormActions({ children }: { children: ReactNode }) {
  return <div className="form-actions">{children}</div>
}

export function SectionTitle({ title, description, actions }: { title: string; description?: string | undefined; actions?: ReactNode | undefined }) {
  return (
    <div className="section-title">
      <div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div>
      {actions ? <div>{actions}</div> : null}
    </div>
  )
}

export function InlineNotice({ tone = 'info', title, children }: { tone?: 'info' | 'warning' | 'danger' | 'success' | undefined; title: string; children: ReactNode }) {
  return <div className={`notice notice--${tone}`}><AlertTriangle size={18} /><div><strong>{title}</strong><span>{children}</span></div></div>
}
