export { createClient } from './client/client.ts'
export type { TinyPlatesClient } from './client/client.ts'
export {
  AuthenticationError,
  ConnectionError,
  InternalError,
  InvalidRequestError,
  NotFoundError,
  PlanRequiredError,
  RateLimitError,
  TinyPlatesError,
  UnexpectedResponseError,
} from './client/errors.ts'
export type { ClientOptions, RequestOptions } from './client/transport.ts'
export type * from './core/errors.ts'
export type * from './core/parameters.ts'
export type * from './generated/types.ts'
