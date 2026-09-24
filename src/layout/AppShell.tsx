import { useEffect, useState } from 'react'
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BadgeDollarSign,
  Boxes,
  Factory,
  Gauge,
  LogOut,
  Menu,
  PackageSearch,
  RefreshCw,
  Settings,
  ShoppingCart,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import { NavLink, Outlet, useLocation, useNavigate, useOutletContext } from 'react-router-dom'
import { api } from '../lib/api'
import type { Me } from '../types/api'
import { useAuth } from '../auth/AuthProvider'
import { useToast } from '../components/Toast'
import { Badge, Button, ErrorState, LoadingState } from '../components/UI'

const navItems = [
  { to: '/dashboard', label: 'Overview', icon: Gauge, permissions: ['dashboard.read'] },
  { to: '/production', label: 'Production', icon: Factory, permissions: ['production.read', 'inventory.read'] },
  { to: '/inventory', label: 'Inventory', icon: PackageSearch, permissions: ['inventory.read'] },
  { to: '/sales', label: 'Sales', icon: ShoppingCart, permissions: ['sales.read'] },
  { to: '/employees', label: 'Staff & payroll', icon: Users, permissions: ['employees.read', 'payroll.read'] },
  { to: '/accounting', label: 'Accounting', icon: BadgeDollarSign, permissions: ['finance.read'] },
  { to: '/settings', label: 'Settings', icon: Settings, permissions: ['system.admin'] },
]

export interface AppOutletContext {
  me: Me
  year: number
  setYear: (year: number) => void
  can: (permission: string) => boolean
  hasAnyPermission: (...permissions: string[]) => boolean
}

export function useAppContext() {
  return useOutletContext<AppOutletContext>()
}

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

export function AppShell() {
  const auth = useAuth()
  const toast = useToast()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const online = useOnline()
  const fetching = useIsFetching()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [year, setYear] = useState(new Date().getFullYear())

  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: ({ signal }) => api.get<Me>('/me', undefined, signal),
    staleTime: 5 * 60_000,
  })

  const logOut = async () => {
    try {
      queryClient.clear()
      await auth.signOut()
      void navigate('/login', { replace: true })
    } catch (error) {
      toast.error('Could not sign out', error instanceof Error ? error.message : 'Please try again.')
    }
  }

  if (meQuery.isLoading) return <div className="full-page-state"><LoadingState label="Verifying access…" /></div>
  if (meQuery.isError || !meQuery.data) return (
    <div className="full-page-state">
      <ErrorState error={meQuery.error ?? new Error('Your user profile is unavailable.')} onRetry={() => void meQuery.refetch()} />
      <Button variant="secondary" onClick={() => void logOut()}>Sign out</Button>
    </div>
  )

  const me = meQuery.data
  const roles = me.role_codes ?? []
  const permissions = me.permission_codes ?? []
  const isAdmin = permissions.includes('system.admin')
  const can = (permission: string) => isAdmin || permissions.includes(permission)
  const hasAnyPermission = (...required: string[]) => isAdmin || required.some((permission) => permissions.includes(permission))
  const visibleNav = navItems.filter((item) => hasAnyPermission(...item.permissions))
  const identity = me.display_name || me.email || 'CK SYS user'
  const initials = identity.split(/\s|@/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('')
  const outletContext: AppOutletContext = { me, year, setYear, can, hasAnyPermission }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${drawerOpen ? 'sidebar--open' : ''}`} aria-label="Primary navigation">
        <div className="sidebar__brand">
          <span className="brand-mark"><Boxes size={22} /></span>
          <div><strong>CK SYS</strong><span>Operations V3</span></div>
          <button className="icon-button sidebar__close" onClick={() => setDrawerOpen(false)} aria-label="Close navigation"><X /></button>
        </div>
        <nav className="sidebar__nav">
          <span className="sidebar__label">Workspace</span>
          {visibleNav.map((item) => {
            const Icon = item.icon
            return (
              <NavLink key={item.to} to={item.to} onClick={() => setDrawerOpen(false)} className={({ isActive }) => `nav-link${isActive ? ' nav-link--active' : ''}`}>
                <Icon size={19} /><span>{item.label}</span>
              </NavLink>
            )
          })}
        </nav>
        <div className="sidebar__footer">
          <div className="connection-status">
            {online ? <Wifi size={15} /> : <WifiOff size={15} />}
            <span>{online ? 'Connected' : 'Offline'}</span>
            {fetching ? <RefreshCw className="spin" size={13} /> : null}
          </div>
          <div className="profile-chip">
            <span className="avatar">{initials || 'CK'}</span>
            <div><strong>{identity}</strong><span>{roles.join(' · ') || 'staff'}</span></div>
            <button className="icon-button icon-button--small" onClick={() => void logOut()} aria-label="Sign out"><LogOut size={16} /></button>
          </div>
        </div>
      </aside>

      {drawerOpen ? <button className="mobile-scrim" onClick={() => setDrawerOpen(false)} aria-label="Close navigation" /> : null}

      <div className="app-main">
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setDrawerOpen(true)} aria-label="Open navigation"><Menu /></button>
          <div className="topbar__identity">
            <strong>{visibleNav.find((item) => location.pathname.startsWith(item.to))?.label ?? 'CK SYS'}</strong>
            <span className={`status-dot ${online ? 'status-dot--online' : ''}`} aria-hidden="true" />
          </div>
          <div className="topbar__actions">
            <label className="year-picker"><span>Fiscal year</span><select value={year} onChange={(event) => setYear(Number(event.target.value))}>
              {Array.from({ length: 7 }, (_, index) => new Date().getFullYear() + 1 - index).map((option) => <option key={option}>{option}</option>)}
            </select></label>
            <Badge tone={online ? 'success' : 'danger'}>{online ? 'Live API' : 'Offline'}</Badge>
            <Button variant="secondary" size="small" icon={RefreshCw} loading={Boolean(fetching)} onClick={() => void queryClient.invalidateQueries()}>Refresh</Button>
          </div>
        </header>

        <main className="page-content" id="main-content">
          <Outlet context={outletContext} />
        </main>

        <nav className="bottom-nav" aria-label="Mobile navigation">
          {visibleNav.map((item) => {
            const Icon = item.icon
            return <NavLink key={item.to} to={item.to} onClick={() => setDrawerOpen(false)} className={({ isActive }) => isActive ? 'bottom-nav__item bottom-nav__item--active' : 'bottom-nav__item'}><Icon size={19} /><span>{item.label}</span></NavLink>
          })}
        </nav>
      </div>
    </div>
  )
}

export function PermissionRoute({ anyOf }: { anyOf: string[] }) {
  const context = useAppContext()
  const navigate = useNavigate()
  const view = context.hasAnyPermission(...anyOf)
  if (view) return <Outlet context={context} />
  return (
    <div className="access-denied">
      <BadgeDollarSign size={38} />
      <h1>This workspace is restricted</h1>
      <p>Your assigned role does not permit access to this area.</p>
      <Button onClick={() => void navigate('/dashboard')}>Return to overview</Button>
    </div>
  )
}
