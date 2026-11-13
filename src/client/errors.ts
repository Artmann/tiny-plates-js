import type {
  ApiFailure,
  AuthenticationErrorCode,
  ConnectionErrorCode,
  InternalErrorCode,
  InvalidRequestErrorCode,
  NotFoundErrorCode,
  PlanRequiredErrorCode,
  RateLimitErrorCode,
  RateLimitWindow,
  UnexpectedResponseErrorCode,
} from '../core/errors.ts'
import type { Issue } from '../generated/types.ts'

type ErrorDetails<Code extends string> = {
  readonly cause?: unknown
  readonly code: Code
  readonly message: string
  readonly status?: number
}

// Base class for every error the client throws. Check the subclass with
// instanceof, or branch on `code` for the exact reason.
export abstract class TinyPlatesError extends Error {
  abstract readonly code: string
  readonly status: number | undefined

  constructor(details: ErrorDetails<string>) {
    super(details.message, { cause: details.cause })
    this.status = details.status
  }
}

// The API key is missing, wrong, expired or disabled.
export class AuthenticationError extends TinyPlatesError {
  readonly code: AuthenticationErrorCode
  override readonly name = 'AuthenticationError'

  constructor(details: ErrorDetails<AuthenticationErrorCode>) {
    super(details)
    this.code = details.code
  }
}

// Tiny Plates could not be reached, or did not answer in time.
export class ConnectionError extends TinyPlatesError {
  readonly code: ConnectionErrorCode
  override readonly name = 'ConnectionError'

  constructor(details: ErrorDetails<ConnectionErrorCode>) {
    super(details)
    this.code = details.code
  }
}

// Something went wrong on the Tiny Plates side. Safe to retry.
export class InternalError extends TinyPlatesError {
  readonly code: InternalErrorCode
  override readonly name = 'InternalError'

  constructor(details: ErrorDetails<InternalErrorCode>) {
    super(details)
    this.code = details.code
  }
}

// The request had a missing or invalid parameter. `issues` lists them when the
// API could not decode the request at all.
export class InvalidRequestError extends TinyPlatesError {
  readonly code: InvalidRequestErrorCode
  readonly issues: ReadonlyArray<Issue>
  override readonly name = 'InvalidRequestError'

  constructor(details: ErrorDetails<InvalidRequestErrorCode> & { readonly issues: ReadonlyArray<Issue> }) {
    super(details)
    this.code = details.code
    this.issues = details.issues
  }
}

// The recipe or ingredient does not exist.
export class NotFoundError extends TinyPlatesError {
  readonly code: NotFoundErrorCode
  override readonly name = 'NotFoundError'

  constructor(details: ErrorDetails<NotFoundErrorCode>) {
    super(details)
    this.code = details.code
  }
}

// The endpoint needs a business plan.
export class PlanRequiredError extends TinyPlatesError {
  readonly code: PlanRequiredErrorCode
  override readonly name = 'PlanRequiredError'

  constructor(details: ErrorDetails<PlanRequiredErrorCode>) {
    super(details)
    this.code = details.code
  }
}

// The account used its daily or weekly requests.
export class RateLimitError extends TinyPlatesError {
  readonly code: RateLimitErrorCode
  override readonly name = 'RateLimitError'
  readonly window: RateLimitWindow

  constructor(details: ErrorDetails<RateLimitErrorCode> & { readonly window: RateLimitWindow }) {
    super(details)
    this.code = details.code
    this.window = details.window
  }
}

// Tiny Plates answered with something the client doesn't recognise.
export class UnexpectedResponseError extends TinyPlatesError {
  readonly code: UnexpectedResponseErrorCode
  override readonly name = 'UnexpectedResponseError'

  constructor(details: ErrorDetails<UnexpectedResponseErrorCode>) {
    super(details)
    this.code = details.code
  }
}

export function fromApiFailure(failure: ApiFailure): TinyPlatesError {
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
