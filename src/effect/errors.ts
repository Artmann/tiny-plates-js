import { Cause, Effect, Schema } from 'effect'
import { HttpClientError } from 'effect/http/HttpClientError'
import { clientMessages, readApiFailure } from '../core/errors.ts'
import type { ApiFailure } from '../core/errors.ts'
// The API key is missing, wrong, expired or disabled.
export class AuthenticationError extends Schema.TaggedError<AuthenticationError>()('AuthenticationError', {
  code: Schema.Literals(['api_key_disabled', 'api_key_expired', 'api_key_required', 'invalid_api_key']),
  message: Schema.String,
  status: Schema.Literal(401),
}) {}

// Tiny Plates could not be reached, or did not answer in time.
export class ConnectionError extends Schema.TaggedError<ConnectionError>()('ConnectionError', {
  cause: Schema.optional(Schema.Unknown),
  code: Schema.Literals(['network_error', 'timeout']),
  message: Schema.String,
}) {}

// Something went wrong on the Tiny Plates side. Safe to retry.
export class InternalError extends Schema.TaggedError<InternalError>()('InternalError', {
  code: Schema.Literal('internal_error'),
  message: Schema.String,
  status: Schema.Literal(500),
}) {}

// The request had a missing or invalid parameter. The message says which.
export class InvalidRequestError extends Schema.TaggedError<InvalidRequestError>()('InvalidRequestError', {
  code: Schema.Literals(['invalid_parameter', 'search_query_required']),
  message: Schema.String,
  status: Schema.Literal(400),
}) {}

// The recipe or ingredient does not exist.
export class NotFoundError extends Schema.TaggedError<NotFoundError>()('NotFoundError', {
  code: Schema.Literals(['ingredient_not_found', 'recipe_not_found']),
  message: Schema.String,
  status: Schema.Literal(404),
}) {}

// The endpoint needs a business plan.
export class PlanRequiredError extends Schema.TaggedError<PlanRequiredError>()('PlanRequiredError', {
  code: Schema.Literal('business_plan_required'),
  message: Schema.String,
  status: Schema.Literal(403),
}) {}

// The account used its daily or weekly requests. `retryAfter` is the number of
// seconds until the limit frees up, at the next midnight UTC. A weekly limit
// may still be spent then, and the next RateLimitError names the midnight after.
export class RateLimitError extends Schema.TaggedError<RateLimitError>()('RateLimitError', {
  code: Schema.Literals(['daily_limit_reached', 'weekly_limit_reached']),
  message: Schema.String,
  retryAfter: Schema.UndefinedOr(Schema.Number),
  status: Schema.Literal(429),
  window: Schema.Literals(['daily', 'weekly']),
}) {}

// Tiny Plates answered with something the client doesn't recognise.
export class UnexpectedResponseError extends Schema.TaggedError<UnexpectedResponseError>()('UnexpectedResponseError', {
  cause: Schema.optional(Schema.Unknown),
  code: Schema.Literal('unexpected_response'),
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

export type TinyPlatesError =
  | AuthenticationError
  | ConnectionError
  | InternalError
  | InvalidRequestError
  | NotFoundError
  | PlanRequiredError
  | RateLimitError
  | UnexpectedResponseError

// Every request can fail with these, whatever the endpoint.
export type TransportError = ConnectionError | UnexpectedResponseError

export function fromApiFailure(failure: ApiFailure) {
  switch (failure.kind) {
    case 'authentication': {
      return new AuthenticationError(failure)
    }
    case 'internal': {
      return new InternalError(failure)
    }
    case 'invalid_request': {
      return new InvalidRequestError(failure)
    }
    case 'not_found': {
      return new NotFoundError(failure)
    }
    case 'plan_required': {
      return new PlanRequiredError(failure)
    }
    case 'rate_limit': {
      return new RateLimitError(failure)
    }
  }
}

type FailureContext = {
  readonly baseUrl: string
  readonly timeout: number
}

export function timeoutError(cause: unknown, context: FailureContext) {
  return new ConnectionError({ cause, code: 'timeout', message: clientMessages.timeout(context.timeout) })
}

function unexpectedResponseError(cause: unknown, status: number | undefined) {
  return new UnexpectedResponseError({ cause, code: 'unexpected_response', message: clientMessages.unexpectedResponse(status), status })
}

// Maps whatever the generated HttpApi client failed with to one of our errors.
// Error responses arrive as status code errors, so their body is read here the
// same way the plain client reads it.
export function toTinyPlatesError(error: unknown, context: FailureContext): Effect.Effect<TinyPlatesError> {
  if (Cause.isTimeoutError(error)) {
    return Effect.succeed(timeoutError(error, context))
  }

  if (error instanceof HttpClientError) {
    if (error.reason._tag === 'TransportError') {
      return Effect.succeed(new ConnectionError({ cause: error, code: 'network_error', message: clientMessages.networkError(context.baseUrl) }))
    }

    const response = error.response

    if (response === undefined) {
      return Effect.succeed(unexpectedResponseError(error, undefined))
    }

    return response.json.pipe(
      Effect.map((body) => {
        const failure = readApiFailure(body, { retryAfter: response.headers['retry-after'] })

        return failure ? fromApiFailure(failure) : unexpectedResponseError(error, response.status)
      }),
      Effect.catch(() => {
        return Effect.succeed(unexpectedResponseError(error, response.status))
      }),
    )
  }

  return Effect.succeed(unexpectedResponseError(error, undefined))
}
