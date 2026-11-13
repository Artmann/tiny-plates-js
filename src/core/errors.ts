// Shared by the plain and the Effect client. Turns what the API sends back into
// one of a few failures, grouped by what the caller can do about them.

import type { Issue } from '../generated/types.ts'

export type AuthenticationErrorCode = 'api_key_disabled' | 'api_key_expired' | 'api_key_required' | 'invalid_api_key'
export type ConnectionErrorCode = 'network_error' | 'timeout'
export type InternalErrorCode = 'internal_error'
export type InvalidRequestErrorCode = 'invalid_parameter' | 'invalid_request' | 'search_query_required'
export type NotFoundErrorCode = 'ingredient_not_found' | 'recipe_not_found'
export type PlanRequiredErrorCode = 'business_plan_required'
export type RateLimitErrorCode = 'daily_allowance_exceeded' | 'daily_limit_reached' | 'weekly_allowance_exceeded' | 'weekly_limit_reached'
export type UnexpectedResponseErrorCode = 'unexpected_response'

export type ApiErrorCode =
  | AuthenticationErrorCode
  | InternalErrorCode
  | InvalidRequestErrorCode
  | NotFoundErrorCode
  | PlanRequiredErrorCode
  | RateLimitErrorCode

export type RateLimitWindow = 'daily' | 'weekly'

// A failure the API reported. `status` is the HTTP status the API uses for it.
export type ApiFailure =
  | { readonly code: AuthenticationErrorCode, readonly kind: 'authentication', readonly message: string, readonly status: 401 }
  | { readonly code: InternalErrorCode, readonly kind: 'internal', readonly message: string, readonly status: 500 }
  | { readonly code: InvalidRequestErrorCode, readonly issues: ReadonlyArray<Issue>, readonly kind: 'invalid_request', readonly message: string, readonly status: 400 }
  | { readonly code: NotFoundErrorCode, readonly kind: 'not_found', readonly message: string, readonly status: 404 }
  | { readonly code: PlanRequiredErrorCode, readonly kind: 'plan_required', readonly message: string, readonly status: 403 }
  | { readonly code: RateLimitErrorCode, readonly kind: 'rate_limit', readonly message: string, readonly status: 429, readonly window: RateLimitWindow }

export type ApiFailureKind = ApiFailure['kind']

export const apiErrorKinds: Readonly<Record<ApiErrorCode, ApiFailureKind>> = {
  api_key_disabled: 'authentication',
  api_key_expired: 'authentication',
  api_key_required: 'authentication',
  business_plan_required: 'plan_required',
  daily_allowance_exceeded: 'rate_limit',
  daily_limit_reached: 'rate_limit',
  ingredient_not_found: 'not_found',
  internal_error: 'internal',
  invalid_api_key: 'authentication',
  invalid_parameter: 'invalid_request',
  invalid_request: 'invalid_request',
  recipe_not_found: 'not_found',
  search_query_required: 'invalid_request',
  weekly_allowance_exceeded: 'rate_limit',
  weekly_limit_reached: 'rate_limit',
}

// Messages for failures the API never sees, so it can't describe them itself.
export const clientMessages = {
  missingApiKey: 'An API key is required. Pass it as the apiKey option. Create a key at https://www.tinyplates.dev.',
  networkError: (baseUrl: string) => {
    return `Could not reach Tiny Plates at ${baseUrl}. Check your network connection and the baseUrl option, then try again.`
  },
  timeout: (milliseconds: number) => {
    return `Tiny Plates did not respond within ${formatSeconds(milliseconds)}. Check your connection or raise the timeout option.`
  },
  unexpectedResponse: (status: number | undefined) => {
    const statusText = status === undefined ? '' : ` (status ${status})`

    return `Tiny Plates returned an unexpected response${statusText}. Try again, and contact support at https://www.tinyplates.dev if it continues.`
  },
}

function formatSeconds(milliseconds: number) {
  const seconds = milliseconds / 1000

  return seconds === 1 ? '1 second' : `${seconds} seconds`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && Object.hasOwn(apiErrorKinds, value)
}

function isIssueList(value: unknown): value is ReadonlyArray<Issue> {
  return Array.isArray(value) && value.every((issue) => {
    return isRecord(issue) && typeof issue.message === 'string' && Array.isArray(issue.path)
  })
}

export function rateLimitWindow(code: RateLimitErrorCode): RateLimitWindow {
  return code.startsWith('daily') ? 'daily' : 'weekly'
}

// Reads an error body from the API. Returns undefined when the body isn't one of
// the documented errors, which the caller reports as an unexpected response.
export function readApiFailure(body: unknown): ApiFailure | undefined {
  if (!isRecord(body)) {
    return undefined
  }

  // Requests the API can't decode get its framework's error shape instead of
  // the usual { error: { code, message } }.
  if (body._tag === 'HttpApiDecodeError' && typeof body.message === 'string') {
    return {
      code: 'invalid_request',
      issues: isIssueList(body.issues) ? body.issues : [],
      kind: 'invalid_request',
      message: body.message,
      status: 400,
    }
  }

  const detail = body.error

  if (!isRecord(detail) || !isApiErrorCode(detail.code) || typeof detail.message !== 'string') {
    return undefined
  }

  return toApiFailure(detail.code, detail.message)
}

function toApiFailure(code: ApiErrorCode, message: string): ApiFailure {
  switch (code) {
    case 'api_key_disabled':
    case 'api_key_expired':
    case 'api_key_required':
    case 'invalid_api_key': {
      return { code, kind: 'authentication', message, status: 401 }
    }
    case 'business_plan_required': {
      return { code, kind: 'plan_required', message, status: 403 }
    }
    case 'daily_allowance_exceeded':
    case 'daily_limit_reached':
    case 'weekly_allowance_exceeded':
    case 'weekly_limit_reached': {
      return { code, kind: 'rate_limit', message, status: 429, window: rateLimitWindow(code) }
    }
    case 'ingredient_not_found':
    case 'recipe_not_found': {
      return { code, kind: 'not_found', message, status: 404 }
    }
    case 'internal_error': {
      return { code, kind: 'internal', message, status: 500 }
    }
    case 'invalid_parameter':
    case 'invalid_request':
    case 'search_query_required': {
      return { code, issues: [], kind: 'invalid_request', message, status: 400 }
    }
  }
}
