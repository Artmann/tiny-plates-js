import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeServices } from '@effect/platform-node'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ConfigProvider, Console, Effect, Exit, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { cliMessages, parseShoppingListRecipe, runCli } from './commands.ts'
import { Browser, loginMessages } from './login.ts'
import type { StoredCredentials } from './login.ts'

// Each test gets its own config folder, so none of them read or write the
// sign-in of whoever runs the tests.
let configHome = ''

beforeEach(async () => {
  configHome = await mkdtemp(join(tmpdir(), 'tiny-plates-cli-'))
})

afterEach(async () => {
  await rm(configHome, { force: true, recursive: true })
})

function credentialsFile() {
  return join(configHome, 'tiny-plates', 'credentials.json')
}

async function saveCredentials(credentials: StoredCredentials) {
  await mkdir(join(configHome, 'tiny-plates'), { recursive: true })
  await writeFile(credentialsFile(), JSON.stringify(credentials))
}

async function savedCredentials() {
  return JSON.parse(await readFile(credentialsFile(), 'utf8')) as unknown
}

async function credentialsExist() {
  return stat(credentialsFile()).then(() => true, () => false)
}

// Plays the browser: goes back to the CLI's callback with what `reply` adds to
// the query, as the sign-in page would. Records the page it was sent to.
function fakeBrowser(opened: Array<URL>, reply: (page: URL) => Record<string, string>) {
  return Layer.succeed(Browser, {
    open: (url) => {
      return Effect.promise(async () => {
        const page = new URL(url)
        const callback = new URL(page.searchParams.get('redirect_uri') ?? '')

        opened.push(page)
        callback.search = new URLSearchParams(reply(page)).toString()
        await (await globalThis.fetch(callback)).text()
      })
    },
  })
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status })
}

// Runs the CLI against a fetch that answers with the given replies in order.
// Records each request and everything the CLI printed.
async function run(
  args: ReadonlyArray<string>,
  replies: ReadonlyArray<Response> = [],
  env: Record<string, string> = {},
  browser = fakeBrowser([], () => ({})),
) {
  const errors: Array<string> = []
  const output: Array<string> = []
  const requests: Array<{ authorization: string | null, body?: string, url: string }> = []

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const reply = replies[requests.length]
    const body = init?.body === undefined || init.body === null ? undefined : await new Response(init.body).text()

    requests.push({
      authorization: new Headers(init?.headers).get('authorization'),
      ...(body === undefined ? {} : { body }),
      url: input instanceof Request ? input.url : String(input),
    })

    if (reply === undefined) {
      throw new Error(`No reply for request ${requests.length}.`)
    }

    return reply
  }

  const testConsole: Console.Console = Object.assign(Object.create(console), {
    error: (...values: ReadonlyArray<unknown>) => {
      errors.push(values.join(' '))
    },
    log: (...values: ReadonlyArray<unknown>) => {
      output.push(values.join(' '))
    },
  })

  const layer = Layer.mergeAll(
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch))),
    NodeServices.layer,
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: { XDG_CONFIG_HOME: configHome, ...env } })),
    browser,
  )

  const exit = await runCli(args, '1.2.3').pipe(
    Effect.provide(layer),
    Effect.provideService(Console.Console, testConsole),
    Effect.runPromiseExit,
  )

  return { errors: errors.join('\n'), exit, output: output.join('\n'), requests }
}

function failureMessage(exit: Exit.Exit<unknown, unknown>) {
  if (Exit.isSuccess(exit)) {
    return undefined
  }

  const reason = exit.cause.reasons.find((candidate) => candidate._tag === 'Fail')

  return reason?._tag === 'Fail' && reason.error instanceof Error ? reason.error.message : undefined
}

function recipe(id: string, title: string) {
  return {
    categories: [],
    courses: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    cuisines: [],
    groups: [],
    id,
    ingredients: [
      { display: '200 g spaghetti', name: 'spaghetti', optional: false, original: '200 g spaghetti' },
      { display: 'Parsley', name: 'parsley', optional: true, original: 'Parsley' },
    ],
    instructions: [{ step: 1, text: 'Boil the pasta.' }, { step: 2, text: 'Add the eggs.' }],
    language: 'en',
    media: [],
    tags: [],
    text: { ingredients: [], instructions: [] },
    times: { cook: { seconds: 900 }, prep: { seconds: 600 }, total: { seconds: 1500 } },
    title,
    updatedAt: '2026-01-01T00:00:00.000Z',
    url: `https://example.com/${id}`,
  }
}

describe('search', () => {
  test('searches with the words, flags and API key, and prints a numbered list', async () => {
    const { exit, output, requests } = await run(
      ['search', 'chocolate', 'cake', '--without', 'eggs,milk', '--without', 'peanuts', '--limit', '2', '--api-key', 'key'],
      [json(200, { results: [{ id: 'cake', score: 2, title: 'Chocolate cake' }, { id: 'brownies', score: 1, title: 'Brownies' }] })],
    )

    expect(Exit.isSuccess(exit)).toEqual(true)
    expect(requests).toEqual([
      { authorization: 'Bearer key', url: 'https://api.tinyplates.dev/search?query=chocolate+cake&limit=2&without=eggs%2Cmilk%2Cpeanuts' },
    ])
    expect(output).toEqual([
      '1. Chocolate cake',
      '   cake',
      '',
      '2. Brownies',
      '   brownies',
      '',
      'Run tiny-plates recipe <id> to see a recipe.',
    ].join('\n'))
  })

  test('reads the API key from TINY_PLATES_API_KEY', async () => {
    const { requests } = await run(['search', 'soup'], [json(200, { results: [] })], { TINY_PLATES_API_KEY: 'from-env' })

    expect(requests).toEqual([{ authorization: 'Bearer from-env', url: 'https://api.tinyplates.dev/search?query=soup' }])
  })

  test('prints the response as JSON with --json', async () => {
    const response = { results: [{ id: 'cake', score: 2, title: 'Chocolate cake' }] }
    const { output } = await run(['--json', 'search', 'cake', '--api-key', 'key'], [json(200, response)])

    expect(JSON.parse(output)).toEqual(response)
  })

  test('fails without an API key and says how to set one', async () => {
    const { exit, requests } = await run(['search', 'soup'])

    expect(failureMessage(exit)).toEqual(cliMessages.missingApiKey)
    expect(requests).toEqual([])
  })

  test('fails with the message from the API', async () => {
    const { exit } = await run(
      ['search', 'soup', '--api-key', 'key'],
      [json(429, { error: { code: 'daily_limit_reached', message: 'You used your 50 requests for today. Try again tomorrow.' } })],
    )

    expect(failureMessage(exit)).toEqual('You used your 50 requests for today. Try again tomorrow.')
  })
})

describe('recipe', () => {
  test('scales and converts the recipe, and prints its ingredients and steps', async () => {
    const { output, requests } = await run(
      ['recipe', 'carbonara', '--servings', '4', '--units', 'metric', '--api-key', 'key'],
      [json(200, { recipe: recipe('carbonara', 'Carbonara') })],
    )

    expect(requests).toEqual([{ authorization: 'Bearer key', url: 'https://api.tinyplates.dev/recipes/carbonara?servings=4&units=metric' }])
    expect(output).toEqual([
      'Carbonara',
      '',
      'Prep 10 min · Cook 15 min · Total 25 min',
      '',
      'Ingredients:',
      '  - 200 g spaghetti',
      '  - Parsley (optional)',
      '',
      'Steps:',
      '  1. Boil the pasta.',
      '  2. Add the eggs.',
      '',
      'Source: https://example.com/carbonara',
    ].join('\n'))
  })
})

describe('pantry', () => {
  test('sends the pantry and prints coverage, missing ingredients and the next page', async () => {
    const { output, requests } = await run(
      ['pantry', 'egg', 'tomato,onion', '--max-missing', '1', '--no-staples', '--limit', '1', '--api-key', 'key'],
      [json(200, {
        pagination: { limit: 1, offset: 0, total: 3 },
        recipes: [{ ...recipe('shakshuka', 'Shakshuka'), assumedIngredients: [], coverage: 0.75, matchedIngredients: ['egg'], missingIngredients: ['pepper'] }],
      })],
    )

    expect(requests).toEqual([
      { authorization: 'Bearer key', url: 'https://api.tinyplates.dev/pantry?ingredients=egg%2Ctomato%2Conion&limit=1&maxMissing=1&staples=false' },
    ])
    expect(output).toEqual([
      '1. Shakshuka',
      '   25 min',
      '   75% covered · Missing pepper',
      '   shakshuka',
      '',
      'Showing 1-1 of 3. Use --offset 1 to see more.',
      'Run tiny-plates recipe <id> to see a recipe.',
    ].join('\n'))
  })
})

describe('popular', () => {
  test('numbers the recipes from the offset and shows their details', async () => {
    const { output, requests } = await run(
      ['popular', '--offset', '9', '--limit', '1', '--api-key', 'key'],
      [json(200, {
        pagination: { limit: 1, offset: 9, total: 10 },
        recipes: [{
          ...recipe('shakshuka', 'Shakshuka'),
          courses: ['main-course'],
          cuisines: ['middle-eastern'],
          popularityScore: 10,
          rating: { count: 120, value: 4.75 },
          servings: { original: '4 servings', quantity: 4 },
        }],
      })],
    )

    expect(requests).toEqual([
      { authorization: 'Bearer key', url: 'https://api.tinyplates.dev/popular?limit=1&offset=9' },
    ])
    expect(output).toEqual([
      '10. Shakshuka',
      '    Middle eastern · Main course · 25 min · Serves 4 · ★ 4.8 (120)',
      '    shakshuka',
      '',
      'Showing 10-10 of 10.',
      'Run tiny-plates recipe <id> to see a recipe.',
    ].join('\n'))
  })
})

describe('shopping-list', () => {
  test('sends each recipe with its servings and prints the items by aisle', async () => {
    const { output, requests } = await run(
      ['shopping-list', 'carbonara:4', 'caesar-salad', '--api-key', 'key'],
      [json(200, {
        items: [
          { category: 'produce', display: '1 head lettuce', name: 'lettuce', recipeIds: ['caesar-salad'] },
          { category: 'dairy', display: '100 g parmesan', name: 'parmesan', plusMore: true, recipeIds: ['carbonara', 'caesar-salad'] },
        ],
        recipes: [{ id: 'carbonara', servings: 4, title: 'Carbonara' }, { id: 'caesar-salad', servings: 2, title: 'Caesar salad' }],
      })],
    )

    expect(requests).toEqual([
      { authorization: 'Bearer key', url: 'https://api.tinyplates.dev/shopping-list?recipes=carbonara%3A4%2Ccaesar-salad' },
    ])
    expect(output).toEqual([
      'Shopping list for Carbonara (serves 4), Caesar salad (serves 2)',
      '',
      'Dairy:',
      '  - 100 g parmesan, plus more',
      '',
      'Produce:',
      '  - 1 head lettuce',
    ].join('\n'))
  })

  test('fails on a recipe it cannot read, before sending anything', async () => {
    const { exit, requests } = await run(['shopping-list', 'carbonara:four', '--api-key', 'key'])

    expect(failureMessage(exit)).toEqual(cliMessages.invalidShoppingListRecipe('carbonara:four'))
    expect(requests).toEqual([])
  })
})

describe('health', () => {
  test('works without an API key', async () => {
    const { exit, output } = await run(['health'], [json(200, { gitSha: 'abc123', startedAt: '2026-11-13T10:00:00.000Z', status: 'ok' })])

    expect(Exit.isSuccess(exit)).toEqual(true)
    expect(output).toEqual('Tiny Plates is up. Running abc123, started 2026-11-13T10:00:00.000Z.')
  })
})

describe('login', () => {
  test('signs in through the browser and saves the tokens', async () => {
    const opened: Array<URL> = []
    const { exit, output, requests } = await run(
      ['login'],
      [
        json(201, { client_id: 'client-1' }),
        json(200, { access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-1', token_type: 'Bearer' }),
      ],
      {},
      fakeBrowser(opened, (page) => ({ code: 'code-1', state: page.searchParams.get('state') ?? '' })),
    )

    const redirectUri = opened[0]?.searchParams.get('redirect_uri') ?? ''
    const verifier = new URLSearchParams(requests[1]?.body).get('code_verifier') ?? ''
    const challenge = new Bun.CryptoHasher('sha256').update(verifier).digest('base64url')

    expect(Exit.isSuccess(exit)).toEqual(true)
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(Object.fromEntries(opened[0]?.searchParams ?? [])).toEqual({
      client_id: 'client-1',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      redirect_uri: redirectUri,
      resource: 'https://api.tinyplates.dev/mcp',
      response_type: 'code',
      scope: 'openid profile email offline_access',
      state: expect.any(String),
    })
    expect(requests.map((request) => request.url)).toEqual([
      'https://www.tinyplates.dev/api/auth/oauth2/register',
      'https://www.tinyplates.dev/api/auth/oauth2/token',
    ])
    expect(JSON.parse(requests[0]?.body ?? '')).toEqual({
      application_type: 'native',
      client_name: 'Tiny Plates command line',
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: ['http://127.0.0.1/callback'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    })
    expect(Object.fromEntries(new URLSearchParams(requests[1]?.body))).toEqual({
      client_id: 'client-1',
      code: 'code-1',
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      resource: 'https://api.tinyplates.dev/mcp',
    })
    expect(await savedCredentials()).toEqual({
      accessToken: 'access-1',
      clientId: 'client-1',
      expiresAt: expect.any(Number),
      refreshToken: 'refresh-1',
    })
    expect(output).toEndWith(cliMessages.loggedIn(credentialsFile()))
  })

  test('fails when the sign-in is cancelled in the browser, and saves nothing', async () => {
    const { exit } = await run(
      ['login'],
      [json(201, { client_id: 'client-1' })],
      {},
      fakeBrowser([], () => ({ error: 'access_denied', error_description: 'the user denied access' })),
    )

    expect(failureMessage(exit)).toEqual(loginMessages.cancelled('the user denied access'))
    expect(await credentialsExist()).toEqual(false)
  })

  test('fails when the browser comes back from another sign-in', async () => {
    const { exit } = await run(
      ['login'],
      [json(201, { client_id: 'client-1' })],
      {},
      fakeBrowser([], () => ({ code: 'code-1', state: 'someone-else' })),
    )

    expect(failureMessage(exit)).toEqual(loginMessages.mismatchedState)
  })
})

describe('signed in', () => {
  test('sends the saved access token', async () => {
    await saveCredentials({ accessToken: 'access-1', clientId: 'client-1', expiresAt: Date.now() + 3_600_000, refreshToken: 'refresh-1' })

    const { requests } = await run(['search', 'soup'], [json(200, { results: [] })])

    expect(requests).toEqual([{ authorization: 'Bearer access-1', url: 'https://api.tinyplates.dev/search?query=soup' }])
  })

  test('prefers an API key over the saved sign-in', async () => {
    await saveCredentials({ accessToken: 'access-1', clientId: 'client-1', expiresAt: Date.now() + 3_600_000 })

    const { requests } = await run(['search', 'soup', '--api-key', 'key'], [json(200, { results: [] })])

    expect(requests).toEqual([{ authorization: 'Bearer key', url: 'https://api.tinyplates.dev/search?query=soup' }])
  })

  test('refreshes an expired access token and saves the new one', async () => {
    await saveCredentials({ accessToken: 'access-1', clientId: 'client-1', expiresAt: Date.now() - 1000, refreshToken: 'refresh-1' })

    const { requests } = await run(
      ['search', 'soup'],
      [json(200, { access_token: 'access-2', expires_in: 3600, token_type: 'Bearer' }), json(200, { results: [] })],
    )

    expect(requests).toEqual([
      {
        authorization: null,
        body: 'client_id=client-1&grant_type=refresh_token&refresh_token=refresh-1&resource=https%3A%2F%2Fapi.tinyplates.dev%2Fmcp',
        url: 'https://www.tinyplates.dev/api/auth/oauth2/token',
      },
      { authorization: 'Bearer access-2', url: 'https://api.tinyplates.dev/search?query=soup' },
    ])
    expect(await savedCredentials()).toEqual({
      accessToken: 'access-2',
      clientId: 'client-1',
      expiresAt: expect.any(Number),
      refreshToken: 'refresh-1',
    })
  })

  test('asks you to sign in again when the refresh token is refused', async () => {
    await saveCredentials({ accessToken: 'access-1', clientId: 'client-1', expiresAt: Date.now() - 1000, refreshToken: 'refresh-1' })

    const { exit, requests } = await run(['search', 'soup'], [json(400, { error: 'invalid_grant' })])

    expect(failureMessage(exit)).toEqual(loginMessages.expired)
    expect(requests.length).toEqual(1)
  })
})

describe('logout', () => {
  test('revokes the refresh token and deletes the saved sign-in', async () => {
    await saveCredentials({ accessToken: 'access-1', clientId: 'client-1', expiresAt: Date.now() + 3_600_000, refreshToken: 'refresh-1' })

    const { output, requests } = await run(['logout'], [new Response(null, { status: 200 })])

    expect(requests).toEqual([
      { authorization: null, body: 'client_id=client-1&token=refresh-1', url: 'https://www.tinyplates.dev/api/auth/oauth2/revoke' },
    ])
    expect(await credentialsExist()).toEqual(false)
    expect(output).toEqual(cliMessages.loggedOut)
  })

  test('says so when you were not signed in', async () => {
    const { output, requests } = await run(['logout'])

    expect(output).toEqual(cliMessages.notLoggedIn)
    expect(requests).toEqual([])
  })
})

describe('parseShoppingListRecipe', () => {
  test('reads an id with or without servings', () => {
    expect([
      parseShoppingListRecipe('carbonara'),
      parseShoppingListRecipe('carbonara:4'),
      parseShoppingListRecipe('carbonara:0'),
      parseShoppingListRecipe('carbonara:'),
      parseShoppingListRecipe(':4'),
    ]).toEqual([{ id: 'carbonara' }, { id: 'carbonara', servings: 4 }, undefined, undefined, undefined])
  })
})
