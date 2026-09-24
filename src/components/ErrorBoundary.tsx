import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from './UI'

interface State { error: Error | null }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Application render error', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className="full-page-state">
        <div className="state-panel state-panel--error" role="alert">
          <AlertTriangle size={34} />
          <strong>This screen could not be displayed</strong>
          <span>{this.state.error.message}</span>
          <Button onClick={() => window.location.reload()}>Reload application</Button>
        </div>
      </main>
    )
  }
}
