import { MapPinOff } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button } from '../components/UI'
import { companyPath, getCompanyPortal } from '../lib/companyPortal'

export function NotFoundPage() {
  const navigate = useNavigate()
  const portal = getCompanyPortal(useParams().companyCode)
  return (
    <div className="access-denied">
      <MapPinOff size={38} />
      <h1>Page not found</h1>
      <p>The workspace you requested does not exist.</p>
      <Button onClick={() => void navigate(portal ? companyPath(portal.routeCode, 'dashboard') : '/login')}>Back to overview</Button>
    </div>
  )
}
