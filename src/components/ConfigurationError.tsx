import { Settings2 } from 'lucide-react'

export function ConfigurationError({ message }: { message: string }) {
  return (
    <main className="full-page-state">
      <div className="state-panel state-panel--error" role="alert">
        <Settings2 size={34} />
        <strong>Application configuration required</strong>
        <span>{message}</span>
        <code>VITE_SUPABASE_URL · VITE_SUPABASE_PUBLISHABLE_KEY · VITE_API_URL</code>
      </div>
    </main>
  )
}
