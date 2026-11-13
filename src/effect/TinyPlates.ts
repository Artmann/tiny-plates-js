import { Cause, Config, Context, Duration, Effect, Layer, Option, Redacted, Schedule, Stream } from 'effect'
import { HttpApiClient } from 'effect/http-api'
import { HttpClient, HttpClientRequest } from 'effect/http'
import { clientMessages } from '../core/errors.ts'
import {
  encodeIngredientListQuery,
  encodeIngredientNames,
  encodePairingQuery,
  encodePantryQuery,
  encodePopularQuery,
  encodeRecipeFilters,
  encodeRecipeOptions,
  encodeSearchQuery,
  encodeShoppingList,
  encodeSubstitutionQuery,
} from '../core/parameters.ts'
import type {
  IngredientListParameters,
  PairingParameters,
  PantryParameters,
  PopularParameters,
  RecipeFilters,
  RecipeOptions,
  SearchParameters,
  ShoppingListRecipe,
} from '../core/parameters.ts'
import { TinyPlatesApi } from '../generated/api.ts'
import type {
  HealthCheck200,
  IngredientsById200,
  IngredientsList200,
  IngredientsPairings200,
  IngredientsResolve200,
  IngredientsVocabularies200,
  Pagination,
  PantryList200,
  PantryRecipe,
  PopularList200,
  PopularRecipe,
  Recipe,
  RecipesById200,
  RecipesList200,
  SearchSearch200,
  ShoppingListBuild200,
  StatusRead200,
  SubstitutionsList200,
} from '../generated/types.ts'
import { timeoutError, toTinyPlatesError } from './errors.ts'
import type {
  AuthenticationError,
  InternalError,
  InvalidRequestError,
  NotFoundError,
  PlanRequiredError,
  RateLimitError,
  TinyPlatesError,
  TransportError,
} from './errors.ts'

export type TinyPlatesOptions = {
  readonly apiKey: Redacted.Redacted<string>
  // Defaults to https://api.tinyplates.dev.
  readonly baseUrl?: string
  // How many times to retry internal and connection errors. Defaults to 2.
  readonly maxRetries?: number
  // How long one attempt may take. Defaults to 10 seconds.
  readonly timeout?: Duration.Input
}

// Errors every authenticated endpoint can fail with.
type CommonError = AuthenticationError | InternalError | InvalidRequestError | RateLimitError | TransportError

export type TinyPlatesService = {
  readonly health: {
    readonly check: () => Effect.Effect<HealthCheck200, InvalidRequestError | TransportError>
  }
  readonly ingredients: {
    readonly byId: (id: string) => Effect.Effect<IngredientsById200, CommonError | NotFoundError>
    readonly list: (parameters?: IngredientListParameters) => Effect.Effect<IngredientsList200, CommonError | PlanRequiredError>
    readonly pairings: (id: string, parameters?: PairingParameters) => Effect.Effect<IngredientsPairings200, CommonError | NotFoundError>
    readonly resolve: (names: ReadonlyArray<string>) => Effect.Effect<IngredientsResolve200, CommonError>
    readonly vocabularies: () => Effect.Effect<IngredientsVocabularies200, CommonError>
  }
  readonly pantry: {
    readonly list: (parameters: PantryParameters) => Effect.Effect<PantryList200, CommonError>
    readonly stream: (parameters: PantryParameters) => Stream.Stream<PantryRecipe, CommonError>
  }
  readonly popular: {
    readonly list: (parameters?: PopularParameters) => Effect.Effect<PopularList200, CommonError>
    readonly stream: (parameters?: PopularParameters) => Stream.Stream<PopularRecipe, CommonError>
  }
  readonly recipes: {
    readonly byId: (id: string, options?: RecipeOptions) => Effect.Effect<RecipesById200, CommonError | NotFoundError>
    readonly list: (filters?: RecipeFilters) => Effect.Effect<RecipesList200, CommonError | PlanRequiredError>
    readonly stream: (filters?: RecipeFilters) => Stream.Stream<Recipe, CommonError | PlanRequiredError>
  }
  readonly search: (parameters: SearchParameters) => Effect.Effect<SearchSearch200, CommonError>
  readonly shoppingList: {
    readonly build: (recipes: ReadonlyArray<ShoppingListRecipe>) => Effect.Effect<ShoppingListBuild200, CommonError>
  }
  readonly status: {
    readonly read: () => Effect.Effect<StatusRead200, CommonError>
  }
  readonly substitutions: {
    readonly list: (ingredients: ReadonlyArray<string>) => Effect.Effect<SubstitutionsList200, CommonError>
  }
}

const defaultBaseUrl = 'https://api.tinyplates.dev'
const defaultMaxRetries = 2
const defaultTimeout = Duration.seconds(10)

// The API caps a page at 100 recipes.
const largestPage = 100

type PageResponse<Item> = {
  readonly pagination: Pagination
  readonly recipes: ReadonlyArray<Item>
}

// Walks every page, starting at `offset`, until the API has no more recipes.
function streamPages<Item, Error>(offset: number, fetchPage: (offset: number) => Effect.Effect<PageResponse<Item>, Error>) {
  return Stream.paginate(offset, (currentOffset) => {
    return Effect.map(fetchPage(currentOffset), (page) => {
      const nextOffset = currentOffset + page.recipes.length
      const done = page.recipes.length === 0 || nextOffset >= page.pagination.total

      return [page.recipes, done ? Option.none() : Option.some(nextOffset)] as const
    })
  })
}

function isRetryable(error: TinyPlatesError) {
  return error._tag === 'InternalError' || error._tag === 'ConnectionError'
}

const make = Effect.fnUntraced(function* (options: TinyPlatesOptions) {
  if (Redacted.value(options.apiKey).trim() === '') {
    return yield* Effect.die(new TypeError(clientMessages.missingApiKey))
  }

  const baseUrl = options.baseUrl ?? defaultBaseUrl
  const maxRetries = options.maxRetries ?? defaultMaxRetries
  const timeout = Duration.fromInputUnsafe(options.timeout ?? defaultTimeout)
  const context = { baseUrl, timeout: Duration.toMillis(timeout) }

  const api = yield* HttpApiClient.make(TinyPlatesApi, {
    baseUrl,
    // Error responses fail here, before the generated client decodes them, so
    // they are read in one place with their headers, like Retry-After.
    transformClient: (client) => {
      return client.pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(Redacted.value(options.apiKey))),
        HttpClient.filterStatusOk,
      )
    },
  })

  // Maps failures to our errors, gives each attempt a time limit (reading an
  // error body included) and retries the ones worth retrying. The error type is
  // narrowed by the service type above, which lists what each endpoint can
  // return.
  function run<Success, Error extends TinyPlatesError>(effect: Effect.Effect<Success, unknown>): Effect.Effect<Success, Error> {
    return effect.pipe(
      Effect.catch((error) => {
        return Effect.flatMap(toTinyPlatesError(error, context), Effect.fail)
      }),
      Effect.timeout(timeout),
      Effect.mapError((error) => {
        return (Cause.isTimeoutError(error) ? timeoutError(error, context) : error) as Error
      }),
      Effect.retry({
        schedule: Schedule.exponential('500 millis'),
        times: maxRetries,
        while: isRetryable,
      }),
    )
  }

  const service: TinyPlatesService = {
    health: {
      check: () => {
        return run(api.health.healthCheck({}))
      },
    },
    ingredients: {
      byId: (id) => {
        return run(api.ingredients.ingredientsById({ params: { id } }))
      },
      list: (parameters) => {
        return run(api.ingredients.ingredientsList({ query: encodeIngredientListQuery(parameters) }))
      },
      pairings: (id, parameters) => {
        return run(api.ingredients.ingredientsPairings({ params: { id }, query: encodePairingQuery(parameters) }))
      },
      resolve: (names) => {
        return run(api.ingredients.ingredientsResolve({ query: encodeIngredientNames(names) }))
      },
      vocabularies: () => {
        return run(api.ingredients.ingredientsVocabularies({}))
      },
    },
    pantry: {
      list: (parameters) => {
        return run(api.pantry.pantryList({ query: encodePantryQuery(parameters) }))
      },
      stream: (parameters) => {
        return streamPages(parameters.offset ?? 0, (offset) => {
          return service.pantry.list({ limit: largestPage, ...parameters, offset })
        })
      },
    },
    popular: {
      list: (parameters) => {
        return run(api.popular.popularList({ query: encodePopularQuery(parameters) }))
      },
      stream: (parameters = {}) => {
        return streamPages(parameters.offset ?? 0, (offset) => {
          return service.popular.list({ limit: largestPage, ...parameters, offset })
        })
      },
    },
    recipes: {
      byId: (id, recipeOptions) => {
        return run(api.recipes.recipesById({ params: { id }, query: encodeRecipeOptions(recipeOptions) }))
      },
      list: (filters) => {
        return run(api.recipes.recipesList({ query: encodeRecipeFilters(filters) }))
      },
      stream: (filters = {}) => {
        return streamPages(filters.offset ?? 0, (offset) => {
          return service.recipes.list({ limit: largestPage, ...filters, offset })
        })
      },
    },
    search: (parameters) => {
      return run(api.search.searchSearch({ query: encodeSearchQuery(parameters) }))
    },
    shoppingList: {
      build: (recipes) => {
        return run(api.shoppingList.shoppingListBuild({ query: encodeShoppingList(recipes) }))
      },
    },
    status: {
      read: () => {
        return run(api.status.statusRead({}))
      },
    },
    substitutions: {
      list: (ingredients) => {
        return run(api.substitutions.substitutionsList({ query: encodeSubstitutionQuery(ingredients) }))
      },
    },
  }

  return service
})

export class TinyPlates extends Context.Service<TinyPlates, TinyPlatesService>()('tiny-plates/TinyPlates') {
  // Needs an HttpClient, such as FetchHttpClient.layer from effect/http.
  static readonly layer = (options: TinyPlatesOptions) => {
    return Layer.effect(TinyPlates, make(options))
  }

  // Reads the API key from the TINY_PLATES_API_KEY config value.
  static readonly layerConfig = (options: Omit<TinyPlatesOptions, 'apiKey'> = {}) => {
    return Layer.unwrap(Effect.map(Config.Redacted('TINY_PLATES_API_KEY'), (apiKey) => {
      return TinyPlates.layer({ ...options, apiKey })
    }))
  }
}
