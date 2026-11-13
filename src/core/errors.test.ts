import { describe, expect, test } from 'bun:test'
import spec from '../../openapi.json'
import { apiErrorKinds, clientMessages, readApiFailure } from './errors.ts'

// Every `code` enum value anywhere in the spec.
function specErrorCodes() {
  const codes = new Set<string>()

  JSON.stringify(spec, (key, value: unknown) => {
    if (key === 'code' && typeof value === 'object' && value !== null && 'enum' in value && Array.isArray(value.enum)) {
      for (const code of value.enum) {
        codes.add(String(code))
      }
    }

    return value
  })

  return [...codes].sort()
}

describe('apiErrorKinds', () => {
  test('maps every error code in the spec', () => {
    const unmapped = specErrorCodes().filter((code) => {
      return !Object.hasOwn(apiErrorKinds, code)
    })

    expect(unmapped).toEqual([])
  })
})

describe('readApiFailure', () => {
  test('reads an authentication error', () => {
    const failure = readApiFailure({ error: { code: 'invalid_api_key', message: 'The API key is not valid.' } })

    expect(failure).toEqual({ code: 'invalid_api_key', kind: 'authentication', message: 'The API key is not valid.', status: 401 })
  })

  test('reads a rate limit error with its window', () => {
    const daily = readApiFailure({ error: { code: 'daily_limit_reached', message: 'Daily limit reached.' } })
    const weekly = readApiFailure({ error: { code: 'weekly_allowance_exceeded', message: 'Weekly allowance used.' } })

    expect(daily).toEqual({ code: 'daily_limit_reached', kind: 'rate_limit', message: 'Daily limit reached.', status: 429, window: 'daily' })
    expect(weekly).toEqual({ code: 'weekly_allowance_exceeded', kind: 'rate_limit', message: 'Weekly allowance used.', status: 429, window: 'weekly' })
  })

  test('reads a decode error with its issues', () => {
    const issues = [{ _tag: 'Type' as const, message: 'Expected a number', path: ['limit'] }]
    const failure = readApiFailure({ _tag: 'HttpApiDecodeError', issues, message: 'Invalid query' })

    expect(failure).toEqual({ code: 'invalid_request', issues, kind: 'invalid_request', message: 'Invalid query', status: 400 })
  })

  test('reads a parameter error without issues', () => {
    const failure = readApiFailure({ error: { code: 'invalid_parameter', message: 'limit must be at most 100.' } })

    expect(failure).toEqual({ code: 'invalid_parameter', issues: [], kind: 'invalid_request', message: 'limit must be at most 100.', status: 400 })
  })

  test('ignores bodies that are not documented errors', () => {
    expect(readApiFailure(undefined)).toEqual(undefined)
    expect(readApiFailure('Bad gateway')).toEqual(undefined)
    expect(readApiFailure({ error: { code: 'something_new', message: 'New.' } })).toEqual(undefined)
    expect(readApiFailure({ error: { code: 'internal_error' } })).toEqual(undefined)
  })
})

describe('clientMessages', () => {
  test('says how long the client waited', () => {
    expect(clientMessages.timeout(10_000)).toEqual('Tiny Plates did not respond within 10 seconds. Check your connection or raise the timeout option.')
    expect(clientMessages.timeout(1000)).toEqual('Tiny Plates did not respond within 1 second. Check your connection or raise the timeout option.')
  })

  test('includes the status of an unexpected response when there is one', () => {
    expect(clientMessages.unexpectedResponse(502)).toEqual('Tiny Plates returned an unexpected response (status 502). Try again, and contact support at https://www.tinyplates.dev if it continues.')
    expect(clientMessages.unexpectedResponse(undefined)).toEqual('Tiny Plates returned an unexpected response. Try again, and contact support at https://www.tinyplates.dev if it continues.')
  })
})
