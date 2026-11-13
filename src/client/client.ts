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
import { createTransport } from './transport.ts'
import type { ClientOptions, RequestOptions } from './transport.ts'

// The API caps a page at 100 recipes.
const largestPage = 100

type PageResponse<Item> = {
  readonly pagination: Pagination
  readonly recipes: ReadonlyArray<Item>
}

// Walks every page, starting at `offset`, until the API has no more recipes.
async function* iteratePages<Item>(offset: number, fetchPage: (offset: number) => Promise<PageResponse<Item>>) {
  let nextOffset = offset

  while (true) {
    const page = await fetchPage(nextOffset)

    yield* page.recipes

    nextOffset += page.recipes.length

    if (page.recipes.length === 0 || nextOffset >= page.pagination.total) {
      return
    }
  }
}

function path(...segments: ReadonlyArray<string>) {
  return `/${segments.map(encodeURIComponent).join('/')}`
}

export function createClient(options: ClientOptions) {
  const transport = createTransport(options)

  return {
    health: {
      // Needs no API key.
      check: (requestOptions?: RequestOptions) => {
        return transport.get<HealthCheck200>('/health', {}, requestOptions)
      },
    },
    ingredients: {
      byId: (id: string, requestOptions?: RequestOptions) => {
        return transport.get<IngredientsById200>(path('ingredients', id), {}, requestOptions)
      },
      // Needs a business plan.
      list: (parameters?: IngredientListParameters, requestOptions?: RequestOptions) => {
        return transport.get<IngredientsList200>('/ingredients', encodeIngredientListQuery(parameters), requestOptions)
      },
      pairings: (id: string, parameters?: PairingParameters, requestOptions?: RequestOptions) => {
        return transport.get<IngredientsPairings200>(path('ingredients', id, 'pairings'), encodePairingQuery(parameters), requestOptions)
      },
      // Turns names, in any language, into canonical ingredient ids.
      resolve: (names: ReadonlyArray<string>, requestOptions?: RequestOptions) => {
        return transport.get<IngredientsResolve200>('/ingredients/resolve', encodeIngredientNames(names), requestOptions)
      },
      vocabularies: (requestOptions?: RequestOptions) => {
        return transport.get<IngredientsVocabularies200>('/vocabularies', {}, requestOptions)
      },
    },
    pantry: {
      iterate: (parameters: PantryParameters, requestOptions?: RequestOptions): AsyncGenerator<PantryRecipe, void> => {
        return iteratePages(parameters.offset ?? 0, (offset) => {
          return transport.get<PantryList200>('/pantry', encodePantryQuery({ limit: largestPage, ...parameters, offset }), requestOptions)
        })
      },
      // Recipes ranked by how much of them the pantry covers.
      list: (parameters: PantryParameters, requestOptions?: RequestOptions) => {
        return transport.get<PantryList200>('/pantry', encodePantryQuery(parameters), requestOptions)
      },
    },
    popular: {
      iterate: (parameters: PopularParameters = {}, requestOptions?: RequestOptions): AsyncGenerator<PopularRecipe, void> => {
        return iteratePages(parameters.offset ?? 0, (offset) => {
          return transport.get<PopularList200>('/popular', encodePopularQuery({ limit: largestPage, ...parameters, offset }), requestOptions)
        })
      },
      list: (parameters?: PopularParameters, requestOptions?: RequestOptions) => {
        return transport.get<PopularList200>('/popular', encodePopularQuery(parameters), requestOptions)
      },
    },
    recipes: {
      byId: (id: string, options?: RecipeOptions, requestOptions?: RequestOptions) => {
        return transport.get<RecipesById200>(path('recipes', id), encodeRecipeOptions(options), requestOptions)
      },
      // Needs a business plan.
      iterate: (filters: RecipeFilters = {}, requestOptions?: RequestOptions): AsyncGenerator<Recipe, void> => {
        return iteratePages(filters.offset ?? 0, (offset) => {
          return transport.get<RecipesList200>('/recipes', encodeRecipeFilters({ limit: largestPage, ...filters, offset }), requestOptions)
        })
      },
      // Needs a business plan.
      list: (filters?: RecipeFilters, requestOptions?: RequestOptions) => {
        return transport.get<RecipesList200>('/recipes', encodeRecipeFilters(filters), requestOptions)
      },
    },
    search: (parameters: SearchParameters, requestOptions?: RequestOptions) => {
      return transport.get<SearchSearch200>('/search', encodeSearchQuery(parameters), requestOptions)
    },
    shoppingList: {
      // One list for several recipes, grouped by aisle.
      build: (recipes: ReadonlyArray<ShoppingListRecipe>, requestOptions?: RequestOptions) => {
        return transport.get<ShoppingListBuild200>('/shopping-list', encodeShoppingList(recipes), requestOptions)
      },
    },
    status: {
      read: (requestOptions?: RequestOptions) => {
        return transport.get<StatusRead200>('/status', {}, requestOptions)
      },
    },
    substitutions: {
      list: (ingredients: ReadonlyArray<string>, requestOptions?: RequestOptions) => {
        return transport.get<SubstitutionsList200>('/substitutions', encodeSubstitutionQuery(ingredients), requestOptions)
      },
    },
  }
}

export type TinyPlatesClient = ReturnType<typeof createClient>
