import { supabase } from './supabase'
import type { Page } from '../types/api'

type QueryValue = string | number | boolean | null | undefined
export type ApiQuery = Record<string, QueryValue | QueryValue[]>

export interface ApiRequestOptions<TBody = unknown> {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | undefined
  query?: ApiQuery | undefined
  body?: TBody | undefined
  signal?: AbortSignal | undefined
  idempotencyKey?: string | undefined
  requestId?: string | undefined
  retryAuth?: boolean | undefined
}

export interface ApiProblem {
  detail?: string | Array<{ msg?: string; message?: string }> | undefined
  message?: string | undefined
  code?: string | undefined
  request_id?: string | undefined
  [key: string]: unknown
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly requestId: string | undefined
  readonly problem: ApiProblem | undefined

  constructor(message: string, status: number, problem?: ApiProblem, requestId?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.problem = problem
    this.code = problem?.code
    this.requestId = requestId
  }
}

const apiBase = (import.meta.env.VITE_API_URL || '').trim().replace(/\/$/, '')
let refreshInFlight: Promise<string | null> | null = null
let activeCompanyId: string | null = null

export function setActiveCompanyId(companyId: string | null | undefined) {
  const normalized = companyId?.trim()
  activeCompanyId = normalized || null
}

export function getActiveCompanyId() {
  return activeCompanyId
}

export function makeRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function buildUrl(path: string, query?: ApiQuery) {
  if (!apiBase) throw new ApiError('VITE_API_URL is not configured.', 0)
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  const url = new URL(`${apiBase}${normalizedPath}`, window.location.origin)

  Object.entries(query ?? {}).forEach(([key, raw]) => {
    const values = Array.isArray(raw) ? raw : [raw]
    values.forEach((value) => {
      if (value !== null && value !== undefined && value !== '') {
        url.searchParams.append(key, String(value))
      }
    })
  })
  return url.toString()
}

function problemMessage(problem: ApiProblem | undefined, fallback: string) {
  if (typeof problem?.detail === 'string') return problem.detail
  if (Array.isArray(problem?.detail)) {
    const messages = problem.detail
      .map((entry) => entry.msg ?? entry.message)
      .filter((value): value is string => Boolean(value))
    if (messages.length) return messages.join('. ')
  }
  return problem?.message || fallback
}

async function currentAccessToken() {
  const { data, error } = await supabase.auth.getSession()
  if (error) throw new ApiError(error.message, 401)
  return data.session?.access_token ?? null
}

async function refreshedAccessToken() {
  refreshInFlight ??= supabase.auth
    .refreshSession()
    .then(({ data, error }) => {
      if (error) throw new ApiError(error.message, 401)
      return data.session?.access_token ?? null
    })
    .finally(() => {
      refreshInFlight = null
    })
  return refreshInFlight
}

async function parsePayload(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('json')) return undefined
  try {
    return await response.json()
  } catch {
    throw new ApiError('The server returned an invalid JSON response.', response.status)
  }
}

export async function apiRequest<TResponse, TBody = unknown>(
  path: string,
  options: ApiRequestOptions<TBody> = {},
): Promise<TResponse> {
  const method = options.method ?? 'GET'
  const requestId = options.requestId ?? makeRequestId()
  const idempotencyKey = method === 'GET' ? undefined : (options.idempotencyKey ?? makeRequestId())

  const execute = async (refresh: boolean) => {
    const token = refresh ? await refreshedAccessToken() : await currentAccessToken()
    if (!token) throw new ApiError('Your in-memory session has ended. Please sign in again.', 401)

    const headers = new Headers({
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'X-Request-ID': requestId,
    })
    if (options.body !== undefined) headers.set('Content-Type', 'application/json')
    if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey)
    if (activeCompanyId) headers.set('X-Company-ID', activeCompanyId)

    const init: RequestInit = {
      method,
      headers,
      credentials: 'omit',
      cache: 'no-store',
    }
    if (options.body !== undefined) init.body = JSON.stringify(options.body)
    if (options.signal) init.signal = options.signal

    try {
      return await fetch(buildUrl(path, options.query), init)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      throw new ApiError(
        navigator.onLine
          ? 'The API could not be reached. Please try again.'
          : 'You are offline. Reconnect before trying again.',
        0,
      )
    }
  }

  let response = await execute(false)
  if (response.status === 401 && options.retryAuth !== false) response = await execute(true)

  const responseRequestId = response.headers.get('x-request-id') ?? requestId
  const payload = await parsePayload(response)
  if (!response.ok) {
    const problem = payload && typeof payload === 'object' ? payload as ApiProblem : undefined
    throw new ApiError(
      problemMessage(problem, `Request failed with status ${response.status}.`),
      response.status,
      problem,
      responseRequestId,
    )
  }

  return payload as TResponse
}

export const api = {
  get: <T>(path: string, query?: ApiQuery, signal?: AbortSignal) =>
    apiRequest<T>(path, { query, signal }),
  list: <T>(path: string, query?: ApiQuery, signal?: AbortSignal) =>
    apiRequest<Page<T>>(path, { query, signal }),
  post: <T, B = unknown>(path: string, body: B, idempotencyKey?: string) =>
    apiRequest<T, B>(path, { method: 'POST', body, idempotencyKey }),
  patch: <T, B = unknown>(path: string, body: B, idempotencyKey?: string) =>
    apiRequest<T, B>(path, { method: 'PATCH', body, idempotencyKey }),
  delete: <T, B = unknown>(path: string, body?: B, idempotencyKey?: string) =>
    apiRequest<T, B>(path, { method: 'DELETE', body, idempotencyKey }),
}

export function pageItems<T>(payload: Page<T> | T[] | { items?: T[] } | null | undefined): T[] {
  if (!payload) return []
  if (Array.isArray(payload)) return payload
  return Array.isArray(payload.items) ? payload.items : []
}
