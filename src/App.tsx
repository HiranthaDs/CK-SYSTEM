import { lazy, Suspense, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { useAuth } from './auth/AuthProvider'
import { LoadingState } from './components/UI'
import { AppShell } from './layout/AppShell'
import { canUseNavigation, useAppContext } from './layout/AppShell'
import { companyPath, getCompanyPortal } from './lib/companyPortal'

const LoginPage = lazy(() => import('./auth/LoginPage').then((module) => ({ default: module.LoginPage })))
const DashboardPage = lazy(() => import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })))
const AccountingPage = lazy(() => import('./pages/AccountingPage').then((module) => ({ default: module.AccountingPage })))
const ProductionPage = lazy(() => import('./pages/ProductionPage').then((module) => ({ default: module.ProductionPage })))
const InventoryPage = lazy(() => import('./pages/InventoryPage').then((module) => ({ default: module.InventoryPage })))
const SalesPage = lazy(() => import('./pages/SalesPage').then((module) => ({ default: module.SalesPage })))
const EmployeesPage = lazy(() => import('./pages/EmployeesPage').then((module) => ({ default: module.EmployeesPage })))
const AccountPage = lazy(() => import('./pages/AccountPage').then((module) => ({ default: module.AccountPage })))
const ActivityPage = lazy(() => import('./pages/ActivityPage').then((module) => ({ default: module.ActivityPage })))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((module) => ({ default: module.SettingsPage })))
const NotFoundPage = lazy(() => import('./pages/NotFoundPage').then((module) => ({ default: module.NotFoundPage })))

function ProtectedApp() {
  const { session, loading } = useAuth()
  const location = useLocation()
  const portal = getCompanyPortal(useParams().companyCode)
  if (loading) return <div className="full-page-state"><LoadingState label="Restoring secure session..." /></div>
  if (!portal) return <Navigate to="/login" replace />
  if (!session) return <Navigate to={companyPath(portal.routeCode, 'login')} state={{ from: location.pathname }} replace />
  return <AppShell />
}

function PortalIndex() {
  const portal = getCompanyPortal(useParams().companyCode)
  const { me } = useAppContext()
  const choices = [
    ['dashboard', ['dashboard.read']],
    ['production', ['production.read', 'production.write']],
    ['inventory', ['inventory.read', 'inventory.write']],
    ['sales', ['sales.read', 'sales.write']],
    ['employees', ['employees.read', 'employees.write', 'payroll.read', 'payroll.write']],
    ['accounting', ['finance.read', 'finance.write', 'reports.read']],
  ] as const
  const destination = choices.find(([, permissions]) => canUseNavigation(me, [...permissions]))?.[0] ?? 'account'
  return <Navigate to={portal ? companyPath(portal.routeCode, destination) : '/login'} replace />
}

function PermissionPage({ permissions, children }: { permissions?: string[]; children: ReactNode }) {
  const { me, basePath } = useAppContext()
  return canUseNavigation(me, permissions) ? children : <Navigate to={`${basePath}/account`} replace />
}

export function App() {
  return (
    <Suspense fallback={<div className="full-page-state"><LoadingState label="Loading workspace..." /></div>}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/:companyCode/login" element={<LoginPage />} />
        <Route path="/:companyCode/reset-password" element={<LoginPage />} />
        <Route path="/:companyCode" element={<ProtectedApp />}>
          <Route index element={<PortalIndex />} />
          <Route path="dashboard" element={<PermissionPage permissions={['dashboard.read']}><DashboardPage /></PermissionPage>} />
          <Route path="production" element={<PermissionPage permissions={['production.read', 'production.write']}><ProductionPage /></PermissionPage>} />
          <Route path="inventory" element={<PermissionPage permissions={['inventory.read', 'inventory.write']}><InventoryPage /></PermissionPage>} />
          <Route path="sales" element={<PermissionPage permissions={['sales.read', 'sales.write']}><SalesPage /></PermissionPage>} />
          <Route path="employees" element={<PermissionPage permissions={['employees.read', 'employees.write', 'payroll.read', 'payroll.write']}><EmployeesPage /></PermissionPage>} />
          <Route path="accounting" element={<PermissionPage permissions={['finance.read', 'finance.write', 'reports.read']}><AccountingPage /></PermissionPage>} />
          <Route path="activity" element={<PermissionPage permissions={['audit.read']}><ActivityPage /></PermissionPage>} />
          <Route path="account" element={<AccountPage />} />
          <Route path="settings" element={<PermissionPage permissions={['system.admin']}><SettingsPage /></PermissionPage>} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </Suspense>
  )
}
