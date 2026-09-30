export type CompanyPortalCode = 'ck' | 'ar'

export const companyPortals = {
  ck: { routeCode: 'ck', companyId: '00000000-0000-4000-8000-000000000001', companyCode: 'CK', name: 'CK Plastics' },
  ar: { routeCode: 'ar', companyId: '00000000-0000-4000-8000-000000000002', companyCode: 'AR', name: 'AR Plastics' },
} as const satisfies Record<CompanyPortalCode, {
  routeCode: CompanyPortalCode
  companyId: string
  companyCode: string
  name: string
}>

export function getCompanyPortal(value: string | undefined) {
  const normalized = value?.toLowerCase()
  return normalized === 'ck' || normalized === 'ar' ? companyPortals[normalized] : null
}

export function companyPath(routeCode: CompanyPortalCode, path = '') {
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `/${routeCode}${suffix === '/' ? '' : suffix}`
}
