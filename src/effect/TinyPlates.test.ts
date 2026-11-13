import { describe, expect, test } from 'bun:test'
import { Effect, Exit, Layer, Redacted, Stream } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { TinyPlates } from './TinyPlates.ts'
import type { TinyPlatesOptions } from './TinyPlates.ts'

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers }, status })
}

// A fetch that answers with the given replies in order and records each request.
function mockFetch(...replies: ReadonlyArray<Response | ((signal: AbortSignal) => Promise<Response>)>) {
  const requests: Array<{ authorization: string | null, url: string }> = []

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const reply = replies[requests.length]
    const headers = new Headers(init?.headers)
    const signal = init?.signal ?? new AbortController().signal

    requests.push({ authorization: headers.get('authorization'), url: input instanceof Request ? input.url : String(input) })

    if (reply === undefined) {
      throw new Error(`No reply for request ${requests.length}.`)
    }

    return reply instanceof Response ? reply : reply(signal)
  }

  return { fetch: fetch as typeof globalThis.fetch, requests }
}

function hang(signal: AbortSignal) {
  return new Promise<Response>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(signal.reason)
    }, { once: true })
  })
}

function run<Success, Failure>(
  effect: Effect.Effect<Success, Failure, TinyPlates>,
  fetch: typeof globalThis.fetch,
  options: Partial<TinyPlatesOptions> = {},
) {
  const layer = TinyPlates.layer({ apiKey: Redacted.make('key'), ...options }).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  )

  return Effect.runPromiseExit(Effect.provide(effect, layer))
}

function failure<Success, Failure>(exit: Exit.Exit<Success, Failure>) {
  if (Exit.isFailure(exit)) {
    const error = exit.cause.reasons.find((reason) => {
      return reason._tag === 'Fail'
    })

    return error?._tag === 'Fail' ? error.error : undefined
  }

  return undefined
}

function popularRecipe(id: string) {
  return {
    categories: [],
    courses: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    cuisines: [],
    groups: [],
    id,
    ingredients: [{ display: '2 eggs', name: 'egg', optional: false, original: '2 eggs' }],
    instructions: [{ step: 1, text: 'Cook the eggs.' }],
    language: 'en',
    media: [],
    popularityScore: 1,
    tags: [],
    text: { ingredients: ['2 eggs'], instructions: ['Cook the eggs.'] },
    times: {},
    title: 'Eggs',
    updatedAt: '2026-01-01T00:00:00.000Z',
    url: `https://www.tinyplates.dev/recipes/${id}`,
  }
}

const health = { gitSha: 'abc123', startedAt: '2026-01-01T00:00:00.000Z', status: 'ok' }
const internalError = { error: { code: 'internal_error', message: 'Something went wrong on our side.' } }
const check = Effect.flatMap(TinyPlates, (tinyPlates) => {
  return tinyPlates.health.check()
})
const status = Effect.flatMap(TinyPlates, (tinyPlates) => {
  return tinyPlates.status.read()
})

describe('TinyPlates', () => {
  test('sends the key and decodes the response', async () => {
    const { fetch, requests } = mockFetch(json(200, health))

    const exit = await run(check, fetch)

    expect(exit).toEqual(Exit.succeed({ gitSha: 'abc123', startedAt: '2026-01-01T00:00:00.000Z', status: 'ok' }))
    expect(requests).toEqual([{ authorization: 'Bearer key', url: 'https://api.tinyplates.dev/health' }])
  })

  test('fails with a NotFoundError for a missing recipe', async () => {
    const { fetch, requests } = mockFetch(json(404, { error: { code: 'recipe_not_found', message: 'No recipe has the id "nope".' } }))
    const byId = Effect.flatMap(TinyPlates, (tinyPlates) => {
      return tinyPlates.recipes.byId('nope', { servings: 2 })
    })

    const exit = await run(byId, fetch)

    expect(failure(exit)).toMatchObject({ _tag: 'NotFoundError', code: 'recipe_not_found', message: 'No recipe has the id "nope".', status: 404 })
    expect(requests).toEqual([{ authorization: 'Bearer key', url: 'https://api.tinyplates.dev/recipes/nope?servings=2' }])
  })

  test('retries internal errors, then succeeds', async () => {
    const { fetch, requests } = mockFetch(json(500, internalError), json(200, health))

    const exit = await run(check, fetch)

    expect(Exit.isSuccess(exit)).toEqual(true)
    expect(requests.length).toEqual(2)
  })

  test('does not retry rate limits', async () => {
    const { fetch, requests } = mockFetch(json(429, { error: { code: 'weekly_limit_reached', message: 'You have used this week\'s requests.' } }, { 'retry-after': '600' }))

    const exit = await run(status, fetch)

    expect(failure(exit)).toMatchObject({ _tag: 'RateLimitError', code: 'weekly_limit_reached', retryAfter: 600, status: 429, window: 'weekly' })
    expect(requests.length).toEqual(1)
  })

  test('fails with an UnexpectedResponseError for an undocumented response', async () => {
    const { fetch } = mockFetch(new Response('Bad gateway', { status: 502 }))

    const exit = await run(status, fetch, { maxRetries: 0 })

    expect(failure(exit)).toMatchObject({ _tag: 'UnexpectedResponseError', code: 'unexpected_response', status: 502 })
  })

  test('times out a request that never answers', async () => {
    const { fetch } = mockFetch(hang)

    const exit = await run(status, fetch, { maxRetries: 0, timeout: '20 millis' })

    expect(failure(exit)).toMatchObject({
      _tag: 'ConnectionError',
      code: 'timeout',
      message: 'Tiny Plates did not respond within 0.02 seconds. Check your connection or raise the timeout option.',
    })
  })

  test('streams every page', async () => {
    const { fetch, requests } = mockFetch(
      json(200, { pagination: { limit: 2, offset: 0, total: 3 }, recipes: [popularRecipe('a'), popularRecipe('b')] }),
      json(200, { pagination: { limit: 2, offset: 2, total: 3 }, recipes: [popularRecipe('c')] }),
    )
    const ids = Effect.flatMap(TinyPlates, (tinyPlates) => {
      return tinyPlates.popular.stream({ limit: 2 }).pipe(
        Stream.map((recipe) => {
          return recipe.id
        }),
        Stream.runCollect,
      )
    })

    const exit = await run(ids, fetch)

    expect(exit).toEqual(Exit.succeed(['a', 'b', 'c']))
    expect(requests.map((request) => {
      return request.url
    })).toEqual([
      'https://api.tinyplates.dev/popular?limit=2&offset=0',
      'https://api.tinyplates.dev/popular?limit=2&offset=2',
    ])
  })

  test('dies on a blank API key', async () => {
    const { fetch } = mockFetch()

    const exit = await run(status, fetch, { apiKey: Redacted.make('') })

    expect(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => {
      return reason._tag === 'Die'
    })).toEqual(true)
  })
})
