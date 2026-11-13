import { describe, expect, test } from 'bun:test'
import { createClient } from './client.ts'
import {
  AuthenticationError,
  ConnectionError,
  InternalError,
  NotFoundError,
  RateLimitError,
  UnexpectedResponseError,
} from './errors.ts'

type Reply = Response | ((signal: AbortSignal) => Promise<Response>)

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers }, status })
}

// A fetch that answers with the given replies in order and records each request.
function mockFetch(...replies: ReadonlyArray<Reply>) {
  const requests: Array<{ authorization: string | null, url: string }> = []

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const reply = replies[requests.length]
    const headers = new Headers(init?.headers)

    requests.push({ authorization: headers.get('authorization'), url: String(input) })

    if (reply === undefined) {
      throw new Error(`No reply for request ${requests.length}.`)
    }

    if (reply instanceof Response) {
      return reply
    }

    if (init?.signal) {
      return reply(init.signal)
    }

    throw new Error('Expected a signal.')
  }

  return { fetch: fetch as typeof globalThis.fetch, requests }
}

// Never answers, so only an abort ends the request.
function hang(signal: AbortSignal) {
  return new Promise<Response>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(signal.reason)
    }, { once: true })
  })
}

const internalError = { error: { code: 'internal_error', message: 'Something went wrong on our side.' } }

describe('createClient', () => {
  test('refuses a blank API key', () => {
    expect(() => {
      return createClient({ apiKey: ' ' })
    }).toThrow('An API key is required. Pass it as the apiKey option. Create a key at https://www.tinyplates.dev.')
  })

  test('sends the key and the encoded query', async () => {
    const recipe = { id: 'carbonara', title: 'Carbonara' }
    const { fetch, requests } = mockFetch(json(200, recipe))
    const client = createClient({ apiKey: 'key', fetch })

    const result = await client.recipes.byId('carbonara', { servings: 4, units: 'metric' })

    expect(result).toEqual(recipe as never)
    expect(requests).toEqual([{ authorization: 'Bearer key', url: 'https://api.tinyplates.dev/recipes/carbonara?servings=4&units=metric' }])
  })

  test('encodes ids in the path', async () => {
    const { fetch, requests } = mockFetch(json(200, {}))
    const client = createClient({ apiKey: 'key', baseUrl: 'http://localhost:3000', fetch })

    await client.ingredients.pairings('a/b', { limit: 5 })

    expect(requests).toEqual([{ authorization: 'Bearer key', url: 'http://localhost:3000/ingredients/a%2Fb/pairings?limit=5' }])
  })

  test('throws a NotFoundError for a missing recipe', async () => {
    const { fetch } = mockFetch(json(404, { error: { code: 'recipe_not_found', message: 'No recipe has the id "nope".' } }))
    const client = createClient({ apiKey: 'key', fetch })

    const error = await client.recipes.byId('nope').catch((error: unknown) => {
      return error
    })

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error).toMatchObject({ code: 'recipe_not_found', message: 'No recipe has the id "nope".', name: 'NotFoundError', status: 404 })
  })

  test('throws an AuthenticationError for a bad key', async () => {
    const { fetch } = mockFetch(json(401, { error: { code: 'invalid_api_key', message: 'The API key is not valid.' } }))
    const client = createClient({ apiKey: 'key', fetch })

    const error = await client.status.read().catch((error: unknown) => {
      return error
    })

    expect(error).toBeInstanceOf(AuthenticationError)
    expect(error).toMatchObject({ code: 'invalid_api_key', status: 401 })
  })

  test('retries internal errors, then succeeds', async () => {
    const { fetch, requests } = mockFetch(json(500, internalError), json(200, { status: 'ok' }))
    const client = createClient({ apiKey: 'key', fetch })

    const result = await client.health.check()

    expect(result).toEqual({ status: 'ok' } as never)
    expect(requests.length).toEqual(2)
  })

  test('gives up after the last retry', async () => {
    const { fetch, requests } = mockFetch(json(500, internalError), json(500, internalError))
    const client = createClient({ apiKey: 'key', fetch, maxRetries: 1 })

    const error = await client.health.check().catch((error: unknown) => {
      return error
    })

    expect(error).toBeInstanceOf(InternalError)
    expect(requests.length).toEqual(2)
  })

  test('does not retry rate limits', async () => {
    const { fetch, requests } = mockFetch(json(429, { error: { code: 'daily_limit_reached', message: 'You have used today\'s requests.' } }, { 'retry-after': '3600' }))
    const client = createClient({ apiKey: 'key', fetch })

    const error = await client.popular.list().catch((error: unknown) => {
      return error
    })

    expect(error).toBeInstanceOf(RateLimitError)
    expect(error).toMatchObject({ code: 'daily_limit_reached', retryAfter: 3600, status: 429, window: 'daily' })
    expect(requests.length).toEqual(1)
  })

  test('reports a response that is not a documented error', async () => {
    const { fetch } = mockFetch(new Response('Bad gateway', { status: 502 }))
    const client = createClient({ apiKey: 'key', fetch })

    const error = await client.status.read().catch((error: unknown) => {
      return error
    })

    expect(error).toBeInstanceOf(UnexpectedResponseError)
    expect(error).toMatchObject({
      code: 'unexpected_response',
      message: 'Tiny Plates returned an unexpected response (status 502). Try again, and contact support at https://www.tinyplates.dev if it continues.',
      status: 502,
    })
  })

  test('times out a request that never answers', async () => {
    const { fetch } = mockFetch(hang)
    const client = createClient({ apiKey: 'key', fetch, maxRetries: 0, timeout: 20 })

    const error = await client.status.read().catch((error: unknown) => {
      return error
    })

    expect(error).toBeInstanceOf(ConnectionError)
    expect(error).toMatchObject({
      code: 'timeout',
      message: 'Tiny Plates did not respond within 0.02 seconds. Check your connection or raise the timeout option.',
    })
  })

  test('reports a network failure', async () => {
    const { fetch } = mockFetch(async () => {
      throw new TypeError('fetch failed')
    })
    const client = createClient({ apiKey: 'key', fetch, maxRetries: 0 })

    const error = await client.status.read().catch((error: unknown) => {
      return error
    })

    expect(error).toBeInstanceOf(ConnectionError)
    expect(error).toMatchObject({ code: 'network_error' })
  })

  test('hands back the caller\'s abort reason unchanged', async () => {
    const { fetch } = mockFetch(hang)
    const client = createClient({ apiKey: 'key', fetch })
    const controller = new AbortController()
    const reason = new Error('The user left the page.')

    const request = client.status.read({ signal: controller.signal })

    controller.abort(reason)

    await expect(request).rejects.toEqual(reason)
  })

  test('iterates every page', async () => {
    const { fetch, requests } = mockFetch(
      json(200, { pagination: { limit: 2, offset: 0, total: 3 }, recipes: [{ id: 'a' }, { id: 'b' }] }),
      json(200, { pagination: { limit: 2, offset: 2, total: 3 }, recipes: [{ id: 'c' }] }),
    )
    const client = createClient({ apiKey: 'key', fetch })
    const ids: Array<string> = []

    for await (const recipe of client.popular.iterate({ limit: 2 })) {
      ids.push(recipe.id)
    }

    expect(ids).toEqual(['a', 'b', 'c'])
    expect(requests.map((request) => {
      return request.url
    })).toEqual([
      'https://api.tinyplates.dev/popular?limit=2&offset=0',
      'https://api.tinyplates.dev/popular?limit=2&offset=2',
    ])
  })
})
