import { useEffect, useState } from 'react'
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BadgeDollarSign,
  Boxes,
  Factory,
  Gauge,
  KeyRound,
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
import { NavLink, Outlet, useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom'
import { api, setActiveCompanyId } from '../lib/api'
import type { Me } from '../types/api'
import { getCompanyPortal } from '../lib/companyPortal'
import { useAuth } from '../auth/AuthProvider'
import { useToast } from '../components/Toast'
import { Badge, Button, ErrorState, LoadingState } from '../components/UI'

const navItems: Array<{ to: string; label: string; icon: typeof Gauge; permissions?: string[] }> = [
  { to: '/dashboard', label: 'Overview', icon: Gauge, permissions: ['dashboard.read'] },
  { to: '/production', label: 'Production', icon: Factory, permissions: ['production.read', 'production.write'] },
  { to: '/inventory', label: 'Inventory', icon: PackageSearch, permissions: ['inventory.read', 'inventory.write'] },
  { to: '/sales', label: 'Sales', icon: ShoppingCart, permissions: ['sales.read', 'sales.write'] },
  { to: '/employees', label: 'Staff & payroll', icon: Users, permissions: ['employees.read', 'employees.write', 'payroll.read', 'payroll.write'] },
  { to: '/accounting', label: 'Accounting', icon: BadgeDollarSign, permissions: ['finance.read', 'finance.write', 'reports.read'] },
  { to: '/account', label: 'Account & security', icon: KeyRound },
  { to: '/settings', label: 'Settings', icon: Settings, permissions: ['system.admin'] },
]

export function canUseNavigation(me: Me, permissions?: string[]) {
  if (!permissions?.length) return true
  const granted = me.permission_codes ?? []
  return granted.includes('system.admin')
    || permissions.some((permission) => granted.includes(permission))
}

export interface AppOutletContext {
  me: Me
  basePath: string
  year: number
  setYear: (year: number) => void
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
  const portal = getCompanyPortal(useParams().companyCode)
  const online = useOnline()
  const fetching = useIsFetching()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [year, setYear] = useState(new Date().getFullYear())
  const basePath = portal ? `/${portal.routeCode}` : ''

  const meQuery = useQuery({
    queryKey: ['me', auth.session?.user.id, portal?.companyCode],
    queryFn: async ({ signal }) => {
      if (!portal) throw new Error('The selected company portal is unavailable.')
      setActiveCompanyId(portal.companyId)
      return api.get<Me>('/me', undefined, signal)
    },
    enabled: Boolean(portal),
    staleTime: 5 * 60_000,
  })

  const logOut = async () => {
    try {
      await auth.signOut()
      setActiveCompanyId(null)
      queryClient.clear()
      void navigate('/login', { replace: true })
    } catch (error) {
      toast.error('Could not sign out', error instanceof Error ? error.message : 'Please try again.')
    }
  }

  if (meQuery.isLoading) return <div className="full-page-state"><LoadingState label="Preparing your workspace..." /></div>
  if (meQuery.isError || !meQuery.data) return (
    <div className="full-page-state">
      <ErrorState error={meQuery.error ?? new Error('Your user profile is unavailable.')} onRetry={() => void meQuery.refetch()} />
      <Button variant="secondary" onClick={() => void logOut()}>Sign out</Button>
    </div>
  )
  const me = meQuery.data
  const identity = me.display_name || me.email || 'CK SYS user'
  const initials = identity.split(/\s|@/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('')
  const outletContext: AppOutletContext = { me, basePath, year, setYear }
  const visibleNavItems = navItems.filter((item) => canUseNavigation(me, item.permissions))

  return (
    <div className="app-shell">
      <aside className={`sidebar ${drawerOpen ? 'sidebar--open' : ''}`} aria-label="Primary navigation">
        <div className="sidebar__brand">
          <span className="brand-mark"><Boxes size={22} /></span>
          <div><strong>{me.active_company_name}</strong><span>{me.active_company_code} / CK SYS V3</span></div>
          <button className="icon-button sidebar__close" onClick={() => setDrawerOpen(false)} aria-label="Close navigation"><X /></button>
        </div>
        <nav className="sidebar__nav">
          <span className="sidebar__label">Workspace</span>
          {visibleNavItems.map((item) => {
            const Icon = item.icon
            return (
              <NavLink key={item.to} to={`${basePath}${item.to}`} onClick={() => setDrawerOpen(false)} className={({ isActive }) => `nav-link${isActive ? ' nav-link--active' : ''}`}>
                <Icon size={19} /><span>{item.label}</span>
              </NavLink>
            )
          })}
        </nav>
        <div className="sidebar__footer">
          <div className="company-switcher" aria-label="Fixed company portal">
            <span>Company portal</span>
            <strong>{me.active_company_name}</strong>
          </div>
          <div className="connection-status">
            {online ? <Wifi size={15} /> : <WifiOff size={15} />}
            <span>{online ? 'Connected' : 'Offline'}</span>
            {fetching ? <RefreshCw className="spin" size={13} /> : null}
          </div>
          <div className="profile-chip">
            <span className="avatar">{initials || 'CK'}</span>
            <div><strong>{identity}</strong><span>{me.is_super_admin ? 'Group super administrator' : (me.role_codes ?? []).map((role) => role.replaceAll('_', ' ')).join(', ') || 'Authorized user'}</span></div>
            <button className="icon-button icon-button--small" onClick={() => void logOut()} aria-label="Sign out"><LogOut size={16} /></button>
          </div>
        </div>
      </aside>

      {drawerOpen ? <button className="mobile-scrim" onClick={() => setDrawerOpen(false)} aria-label="Close navigation" /> : null}

      <div className="app-main">
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setDrawerOpen(true)} aria-label="Open navigation"><Menu /></button>
          <div className="topbar__identity">
            <div>
              <strong>{visibleNavItems.find((item) => location.pathname.startsWith(`${basePath}${item.to}`))?.label ?? 'CK SYS'}</strong>
              <span>{me.active_company_name}</span>
            </div>
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
          <Outlet key={me.active_company_id} context={outletContext} />
        </main>

        <nav className="bottom-nav" aria-label="Mobile navigation">
          {visibleNavItems.map((item) => {
            const Icon = item.icon
            return <NavLink key={item.to} to={`${basePath}${item.to}`} onClick={() => setDrawerOpen(false)} className={({ isActive }) => isActive ? 'bottom-nav__item bottom-nav__item--active' : 'bottom-nav__item'}><Icon size={19} /><span>{item.label}</span></NavLink>
          })}
        </nav>
      </div>
    </div>
  )
}
