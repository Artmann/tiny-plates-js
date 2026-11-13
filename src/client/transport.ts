import { clientMessages, readApiFailure } from '../core/errors.ts'
import {
  ConnectionError,
  fromApiFailure,
  InternalError,
  TinyPlatesError,
  UnexpectedResponseError,
} from './errors.ts'

export type ClientOptions = {
  readonly apiKey: string
  // Defaults to https://api.tinyplates.dev.
  readonly baseUrl?: string
  // Defaults to the global fetch.
  readonly fetch?: typeof globalThis.fetch
  // How many times to retry internal and connection errors. Defaults to 2.
  readonly maxRetries?: number
  // How long one attempt may take, in milliseconds. Defaults to 10 seconds.
  readonly timeout?: number
}

export type RequestOptions = {
  readonly signal?: AbortSignal
}

export type Transport = {
  readonly get: <Body>(path: string, query: Readonly<Record<string, string>>, options?: RequestOptions) => Promise<Body>
}

const defaultBaseUrl = 'https://api.tinyplates.dev'
const defaultMaxRetries = 2
const defaultTimeout = 10_000
const retryDelay = 500

function isRetryable(error: unknown) {
  return error instanceof InternalError || error instanceof ConnectionError
}

// Waits before the next retry. The timer is cleared if the caller aborts.
async function wait(milliseconds: number, signal: AbortSignal | undefined) {
  signal?.throwIfAborted()

  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined

  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, milliseconds)
      onAbort = () => {
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  } finally {
    clearTimeout(timer)

    if (onAbort) {
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

async function readJson(response: Response, signal: AbortSignal) {
  try {
    const body: unknown = await response.json()

    return body
  } catch (error) {
    // The timeout and the caller's signal also cover reading the body, so an
    // abort here isn't a bad response.
    if (signal.aborted) {
      throw error
    }

    throw new UnexpectedResponseError({ cause: error, code: 'unexpected_response', message: clientMessages.unexpectedResponse(response.status), status: response.status })
  }
}

export function createTransport(options: ClientOptions): Transport {
  if (options.apiKey.trim() === '') {
    throw new TypeError(clientMessages.missingApiKey)
  }

  const baseUrl = options.baseUrl ?? defaultBaseUrl
  const fetch = options.fetch ?? globalThis.fetch
  const maxRetries = options.maxRetries ?? defaultMaxRetries
  const timeout = options.timeout ?? defaultTimeout

  async function attempt(url: URL, signal: AbortSignal | undefined) {
    const timeoutSignal = AbortSignal.timeout(timeout)
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', authorization: `Bearer ${options.apiKey}` },
        signal: combinedSignal,
      })
      const body = await readJson(response, combinedSignal)

      if (response.ok) {
        return body
      }

      const failure = readApiFailure(body, { retryAfter: response.headers.get('retry-after') })

      if (failure) {
        throw fromApiFailure(failure)
      }

      throw new UnexpectedResponseError({ code: 'unexpected_response', message: clientMessages.unexpectedResponse(response.status), status: response.status })
    } catch (error) {
      if (error instanceof TinyPlatesError) {
        throw error
      }

      // The caller cancelled the request, so hand back their reason unchanged.
      if (signal?.aborted) {
        throw signal.reason
      }

      if (timeoutSignal.aborted) {
        throw new ConnectionError({ cause: error, code: 'timeout', message: clientMessages.timeout(timeout) })
      }

      throw new ConnectionError({ cause: error, code: 'network_error', message: clientMessages.networkError(baseUrl) })
    }
  }

  async function get<Body>(path: string, query: Readonly<Record<string, string>>, requestOptions: RequestOptions = {}) {
    const url = new URL(path, baseUrl)

    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, value)
    }

    for (let retry = 0; ; retry++) {
      try {
        // The body is the documented response for this path. It isn't checked
        // at runtime, to keep the client small. The Effect client checks it.
        const body = await attempt(url, requestOptions.signal) as Body

        return body
      } catch (error) {
        if (retry >= maxRetries || !isRetryable(error)) {
          throw error
        }

        await wait(retryDelay * 2 ** retry, requestOptions.signal)
      }
    }
  }

  return { get }
}
