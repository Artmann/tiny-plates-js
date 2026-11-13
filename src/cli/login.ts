// Signs the command in to Tiny Plates the way MCP clients do: it registers
// itself as a client, sends you to the sign-in page in your browser, and waits
// for the browser to come back to a server on this machine with a code. The
// code becomes an access token, which the API takes in place of an API key.
//
// The auth server has no device flow, so this is the authorization code flow
// with PKCE (RFC 7636) and a loopback redirect (RFC 8252).

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { Config, Console, Context, Data, Deferred, Effect, FileSystem, Layer, Option, Path, Redacted, Schema } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'
import { withSpinner } from './terminal.ts'

const authUrl = 'https://www.tinyplates.dev/api/auth'

// Tokens are only accepted by the API when they are issued for this resource.
// Without it the auth server hands out an opaque token the API can't verify.
const resource = 'https://api.tinyplates.dev/mcp'

// The port is left out. The auth server lets a loopback redirect use any port,
// so one registration works whichever port is free.
const registeredRedirectUri = 'http://127.0.0.1/callback'

const requestTimeout = '15 seconds'
const scope = 'openid profile email offline_access'
const signInTimeout = '5 minutes'

// Refresh a little before the token runs out, so it doesn't expire in flight.
const expiryMarginMilliseconds = 60_000

export const loginMessages = {
  cancelled: (reason: string) => {
    return `Sign-in didn't finish: ${reason}. Run tiny-plates login to try again.`
  },
  expired: 'Your sign-in has expired. Run tiny-plates login to sign in again.',
  invalidCredentials: (path: string) => {
    return `The saved sign-in in ${path} can't be read. Run tiny-plates login to sign in again.`
  },
  mismatchedState: 'The browser came back from a different sign-in. Run tiny-plates login to try again.',
  registrationFailed: 'Tiny Plates did not accept the command line tool as a client. Try again in a minute.',
  storageFailed: (path: string) => {
    return `Could not save your sign-in to ${path}. Check that you can write to that folder.`
  },
  timedOut: 'Sign-in timed out after 5 minutes. Run tiny-plates login to try again.',
  tokenFailed: 'Tiny Plates did not accept the sign-in. Run tiny-plates login to try again.',
  unreachable: 'Could not reach Tiny Plates. Check your internet connection and try again.',
}

export class LoginError extends Data.TaggedError('LoginError')<{
  readonly cause?: unknown
  readonly message: string
}> {}

// What a sign-in leaves on disk. The client id is kept because refreshing and
// revoking a token both need it.
const StoredCredentials = Schema.Struct({
  accessToken: Schema.String,
  clientId: Schema.String,
  expiresAt: Schema.Number,
  refreshToken: Schema.optional(Schema.String),
})

export type StoredCredentials = typeof StoredCredentials.Type

const decodeStoredCredentials = Schema.decodeUnknownOption(StoredCredentials)

const RegisteredClient = Schema.Struct({
  client_id: Schema.String,
})

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
  refresh_token: Schema.optional(Schema.String),
})

// Opens a page in the browser. A service, so tests can play the browser.
export class Browser extends Context.Service<Browser, {
  readonly open: (url: string) => Effect.Effect<void>
}>()('tiny-plates/cli/Browser') {
  static readonly layer = Layer.succeed(Browser, {
    open: (url) => {
      return Effect.sync(() => {
        openInBrowser(url)
      })
    },
  })
}

function openInBrowser(url: string) {
  // rundll32 takes the URL as one argument, where `start` would split it on &.
  const [command, args] = process.platform === 'win32'
    ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]]

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })

    // The URL is printed too, so a browser that doesn't open is not fatal.
    child.on('error', () => {})
    child.unref()
  } catch {
    // Same as above.
  }
}

function base64Url(bytes: Buffer) {
  return bytes.toString('base64url')
}

// The verifier stays here. Only its hash goes to the browser, so a code that
// leaks from the redirect is useless without it.
export function createPkce() {
  const verifier = base64Url(randomBytes(32))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())

  return { challenge, verifier }
}

export function authorizationUrl(options: {
  readonly challenge: string
  readonly clientId: string
  readonly redirectUri: string
  readonly state: string
}) {
  const url = new URL(`${authUrl}/oauth2/authorize`)

  url.search = new URLSearchParams({
    client_id: options.clientId,
    code_challenge: options.challenge,
    code_challenge_method: 'S256',
    redirect_uri: options.redirectUri,
    resource,
    response_type: 'code',
    scope,
    state: options.state,
  }).toString()

  return url.toString()
}

const credentialsPath = Effect.gen(function* () {
  const path = yield* Path.Path
  const configHome = yield* Config.option(Config.String('XDG_CONFIG_HOME'))
  const appData = yield* Config.option(Config.String('APPDATA'))
  const base = Option.getOrElse(Option.orElse(configHome, () => appData), () => path.join(homedir(), '.config'))

  return path.join(base, 'tiny-plates', 'credentials.json')
}).pipe(Effect.orDie)

export const readCredentials = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* credentialsPath
  const exists = yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false))

  if (!exists) {
    return Option.none<StoredCredentials>()
  }

  const text = yield* fileSystem.readFileString(path).pipe(
    Effect.mapError((cause) => new LoginError({ cause, message: loginMessages.invalidCredentials(path) })),
  )

  const parsed = Option.liftThrowable(JSON.parse)(text)
  const credentials = Option.flatMap(parsed, decodeStoredCredentials)

  if (Option.isNone(credentials)) {
    return yield* new LoginError({ message: loginMessages.invalidCredentials(path) })
  }

  return credentials
})

const writeCredentials = Effect.fnUntraced(function* (credentials: StoredCredentials) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = yield* credentialsPath

  // Only you can read the folder and the file, since the tokens act as you.
  yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(path.dirname(file), { mode: 0o700, recursive: true })
    yield* fileSystem.writeFileString(file, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 })
  }).pipe(
    Effect.mapError((cause) => new LoginError({ cause, message: loginMessages.storageFailed(file) })),
  )

  return file
})

const removeCredentials = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* credentialsPath

  yield* fileSystem.remove(path, { force: true }).pipe(
    Effect.mapError((cause) => new LoginError({ cause, message: loginMessages.storageFailed(path) })),
  )
})

// Sends a request to the auth server and decodes the JSON reply. Network
// failures and timeouts say so. Any other failure gets the message for the step.
const send = Effect.fnUntraced(function* <A>(
  request: HttpClientRequest.HttpClientRequest,
  schema: Schema.Decoder<A>,
  message: string,
) {
  const client = yield* HttpClient.HttpClient

  const response = yield* client.execute(HttpClientRequest.acceptJson(request)).pipe(
    Effect.timeoutOrElse({
      duration: requestTimeout,
      orElse: () => Effect.fail(new LoginError({ message: loginMessages.unreachable })),
    }),
    Effect.mapError((cause) => {
      return cause instanceof LoginError ? cause : new LoginError({ cause, message: loginMessages.unreachable })
    }),
  )

  const body = yield* response.json.pipe(Effect.orElseSucceed(() => undefined))

  if (response.status >= 400) {
    return yield* new LoginError({ cause: { body, status: response.status }, message })
  }

  return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
    Effect.mapError((cause) => new LoginError({ cause, message })),
  )
})

function postForm<A>(path: string, form: Record<string, string>, schema: Schema.Decoder<A>, message: string) {
  return send(HttpClientRequest.post(`${authUrl}${path}`).pipe(HttpClientRequest.bodyUrlParams(form)), schema, message)
}

const registerClient = Effect.gen(function* () {
  const request = HttpClientRequest.post(`${authUrl}/oauth2/register`).pipe(
    HttpClientRequest.bodyJsonUnsafe({
      application_type: 'native',
      client_name: 'Tiny Plates command line',
      grant_types: ['authorization_code', 'refresh_token'],
      redirect_uris: [registeredRedirectUri],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  )
  const registered = yield* send(request, RegisteredClient, loginMessages.registrationFailed)

  return registered.client_id
})

function toCredentials(clientId: string, tokens: typeof TokenResponse.Type, previousRefreshToken?: string): StoredCredentials {
  const refreshToken = tokens.refresh_token ?? previousRefreshToken

  return {
    accessToken: tokens.access_token,
    clientId,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    ...(refreshToken === undefined ? {} : { refreshToken }),
  }
}

const page = (title: string, text: string) => {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,sans-serif;margin:3rem auto;max-width:32rem;padding:0 1rem"><h1>${title}</h1><p>${text}</p></body>`
}

// Listens on a free port on 127.0.0.1 for the browser to come back. The
// server closes when the scope does, whether sign-in worked or not.
const listenForCallback = Effect.fnUntraced(function* (state: string) {
  const code = yield* Deferred.make<string, LoginError>()

  const respond = (response: ServerResponse, status: number, html: string) => {
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
    response.end(html)
  }

  const handle = (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')

    if (url.pathname !== '/callback') {
      respond(response, 404, page('Not found', 'This page is only here to finish signing in.'))

      return
    }

    const error = url.searchParams.get('error')

    if (error !== null) {
      const reason = url.searchParams.get('error_description') ?? error

      respond(response, 400, page('Sign-in didn\'t finish', 'Go back to the terminal to try again.'))
      Deferred.doneUnsafe(code, Effect.fail(new LoginError({ message: loginMessages.cancelled(reason) })))

      return
    }

    const value = url.searchParams.get('code')

    if (url.searchParams.get('state') !== state || value === null) {
      respond(response, 400, page('Sign-in didn\'t finish', 'Go back to the terminal to try again.'))
      Deferred.doneUnsafe(code, Effect.fail(new LoginError({ message: loginMessages.mismatchedState })))

      return
    }

    respond(response, 200, page('You are signed in', 'You can close this tab and go back to the terminal.'))
    Deferred.doneUnsafe(code, Effect.succeed(value))
  }

  const server = yield* Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>, LoginError>((resume) => {
      const created = createServer(handle)

      created.once('error', (cause) => {
        resume(Effect.fail(new LoginError({ cause, message: loginMessages.cancelled('could not listen for the browser on this machine') })))
      })
      created.listen(0, '127.0.0.1', () => {
        resume(Effect.succeed(created))
      })
    }),
    (created) => {
      return Effect.callback<void>((resume) => {
        created.closeAllConnections()
        created.close(() => {
          resume(Effect.void)
        })
      })
    },
  )

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return { code: Deferred.await(code), redirectUri: `http://127.0.0.1:${port}/callback` }
})

// Signs in and saves the tokens. Returns where they were saved.
export const login = Effect.gen(function* () {
  const browser = yield* Browser
  const pkce = createPkce()
  const state = base64Url(randomBytes(16))
  const callback = yield* listenForCallback(state)
  const clientId = yield* registerClient
  const url = authorizationUrl({ challenge: pkce.challenge, clientId, redirectUri: callback.redirectUri, state })

  yield* Console.log(`Opening your browser to sign in. If it doesn't open, go to:\n\n  ${url}\n`)
  yield* browser.open(url)

  const code = yield* withSpinner('Waiting for you to sign in in your browser…', callback.code.pipe(
    Effect.timeoutOrElse({
      duration: signInTimeout,
      orElse: () => Effect.fail(new LoginError({ message: loginMessages.timedOut })),
    }),
  ))

  const tokens = yield* postForm('/oauth2/token', {
    client_id: clientId,
    code,
    code_verifier: pkce.verifier,
    grant_type: 'authorization_code',
    redirect_uri: callback.redirectUri,
    resource,
  }, TokenResponse, loginMessages.tokenFailed)

  return yield* writeCredentials(toCredentials(clientId, tokens))
}).pipe(Effect.scoped)

// Revokes the saved tokens and forgets them. Returns false when there was
// nothing to forget. Revoking is best effort: the tokens are deleted here
// either way, and the access token runs out on its own within the hour.
export const logout = Effect.gen(function* () {
  const credentials = yield* readCredentials.pipe(
    Effect.catchTag('LoginError', () => Effect.succeed(Option.none<StoredCredentials>())),
  )

  yield* Effect.forEach(Option.toArray(credentials), (saved) => {
    const token = saved.refreshToken ?? saved.accessToken

    return postForm('/oauth2/revoke', { client_id: saved.clientId, token }, Schema.Unknown, loginMessages.unreachable).pipe(Effect.ignore)
  })

  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* credentialsPath
  const exists = yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false))

  yield* removeCredentials

  return exists
})

// The access token to send to the API, refreshed first when it has run out.
// None when you haven't signed in.
export const readAccessToken = Effect.gen(function* () {
  const saved = yield* readCredentials

  if (Option.isNone(saved)) {
    return Option.none<Redacted.Redacted<string>>()
  }

  const credentials = saved.value

  if (credentials.expiresAt - expiryMarginMilliseconds > Date.now()) {
    return Option.some(Redacted.make(credentials.accessToken))
  }

  if (credentials.refreshToken === undefined) {
    return yield* new LoginError({ message: loginMessages.expired })
  }

  const tokens = yield* postForm('/oauth2/token', {
    client_id: credentials.clientId,
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
    resource,
  }, TokenResponse, loginMessages.expired)

  const refreshed = toCredentials(credentials.clientId, tokens, credentials.refreshToken)

  yield* writeCredentials(refreshed)

  return Option.some(Redacted.make(refreshed.accessToken))
})
