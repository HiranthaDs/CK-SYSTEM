import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './auth/AuthProvider'
import { LoadingState } from './components/UI'
import { AppShell, PermissionRoute } from './layout/AppShell'

const LoginPage = lazy(() => import('./auth/LoginPage').then((module) => ({ default: module.LoginPage })))
const DashboardPage = lazy(() => import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })))
const AccountingPage = lazy(() => import('./pages/AccountingPage').then((module) => ({ default: module.AccountingPage })))
const ProductionPage = lazy(() => import('./pages/ProductionPage').then((module) => ({ default: module.ProductionPage })))
const InventoryPage = lazy(() => import('./pages/InventoryPage').then((module) => ({ default: module.InventoryPage })))
const SalesPage = lazy(() => import('./pages/SalesPage').then((module) => ({ default: module.SalesPage })))
const EmployeesPage = lazy(() => import('./pages/EmployeesPage').then((module) => ({ default: module.EmployeesPage })))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((module) => ({ default: module.SettingsPage })))
const NotFoundPage = lazy(() => import('./pages/NotFoundPage').then((module) => ({ default: module.NotFoundPage })))

function ProtectedApp() {
  const { session, loading } = useAuth()
  const location = useLocation()
  if (loading) return <div className="full-page-state"><LoadingState label="Restoring secure session…" /></div>
  if (!session) return <Navigate to="/login" state={{ from: location.pathname }} replace />
  return <AppShell />
}

export function App() {
  return (
    <Suspense fallback={<div className="full-page-state"><LoadingState label="Loading workspace…" /></div>}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<ProtectedApp />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route element={<PermissionRoute anyOf={['dashboard.read']} />}>
            <Route path="dashboard" element={<DashboardPage />} />
          </Route>
          <Route element={<PermissionRoute anyOf={['production.read', 'inventory.read']} />}>
            <Route path="production" element={<ProductionPage />} />
          </Route>
          <Route element={<PermissionRoute anyOf={['inventory.read']} />}>
            <Route path="inventory" element={<InventoryPage />} />
          </Route>
          <Route element={<PermissionRoute anyOf={['sales.read']} />}>
            <Route path="sales" element={<SalesPage />} />
          </Route>
          <Route element={<PermissionRoute anyOf={['employees.read', 'payroll.read']} />}>
            <Route path="employees" element={<EmployeesPage />} />
          </Route>
          <Route element={<PermissionRoute anyOf={['finance.read']} />}>
            <Route path="accounting" element={<AccountingPage />} />
          </Route>
          <Route element={<PermissionRoute anyOf={['system.admin']} />}>
            <Route path="settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Suspense>
  )
}
