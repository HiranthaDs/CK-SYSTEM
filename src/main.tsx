import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from './lib/api'
import { configurationError } from './lib/supabase'
import { AuthProvider } from './auth/AuthProvider'
import { ToastProvider } from './components/Toast'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ConfigurationError } from './components/ConfigurationError'
import { App } from './App'
import './styles.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // React Query is memory-only in this app; it is never persisted to browser storage.
      staleTime: 10_000,
      gcTime: 2 * 60_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchOnMount: 'always',
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false
        return failureCount < 2
      },
    },
    mutations: { retry: false },
  },
})

const apiConfigurationError = !import.meta.env.VITE_API_URL?.trim()
  ? 'The Python API URL is missing. Set VITE_API_URL.'
  : null

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      {configurationError || apiConfigurationError ? (
        <ConfigurationError message={configurationError || apiConfigurationError || 'Configuration is incomplete.'} />
      ) : (
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <ToastProvider>
              <AuthProvider><App /></AuthProvider>
            </ToastProvider>
          </BrowserRouter>
        </QueryClientProvider>
      )}
    </ErrorBoundary>
  </StrictMode>,
)
