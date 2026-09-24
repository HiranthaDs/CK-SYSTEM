import { MapPinOff } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../components/UI'

export function NotFoundPage() {
  const navigate = useNavigate()
  return (
    <div className="access-denied">
      <MapPinOff size={38} />
      <h1>Page not found</h1>
      <p>The workspace you requested does not exist.</p>
      <Button onClick={() => void navigate('/dashboard')}>Back to overview</Button>
    </div>
  )
}
