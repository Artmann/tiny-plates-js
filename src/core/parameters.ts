// Parameters as callers write them, and how they go over the wire. The spec
// types every query parameter as a string, so lists, numbers and flags are
// typed here and encoded the way the API reads them.

import type {
  IngredientsListParams,
  IngredientsPairingsParams,
  IngredientsResolveParams,
  Language,
  PantryListParams,
  PopularListParams,
  RecipesByIdParams,
  RecipesListParams,
  SearchSearchParams,
  ShoppingListBuildParams,
  SubstitutionsListParams,
} from '../generated/types.ts'

export type NutritionPreset = 'high-fiber' | 'high-protein' | 'low-calorie' | 'low-sodium'
export type UnitSystem = 'imperial' | 'metric'

export type Page = {
  readonly limit?: number
  readonly offset?: number
}

export type IngredientListParameters = {
  readonly limit?: number
}

export type PairingParameters = {
  readonly limit?: number
  // Salt, pepper, oil, sugar, flour and water are left out unless this is true.
  readonly staples?: boolean
}

export type PantryParameters = Page & {
  // The pantry: 1 to 20 ingredient names or canonical ids, in any language.
  readonly ingredients: ReadonlyArray<string>
  readonly language?: Language
  // 0 returns only what you can cook right now.
  readonly maxMissing?: number
  // Salt, pepper, water, oil, sugar and flour count as already in the kitchen
  // unless this is false.
  readonly staples?: boolean
  // Allergen features from vocabularies, such as 'milk' or 'peanuts'.
  readonly without?: ReadonlyArray<string>
}

export type PopularParameters = Page & {
  readonly language?: Language
}

export type RecipeFilters = Page & {
  readonly category?: string
  readonly course?: string
  readonly cuisine?: string
  readonly diet?: string
  // Recipes need all of the listed equipment.
  readonly equipment?: ReadonlyArray<string>
  readonly excludeIngredients?: ReadonlyArray<string>
  // A canonical ingredient id, such as 'chicken-thigh'.
  readonly ingredient?: string
  // Recipes need all of the listed ingredient names or ids.
  readonly ingredients?: ReadonlyArray<string>
  readonly language?: Language
  readonly maxCalories?: number
  readonly maxCookMinutes?: number
  readonly maxSodium?: number
  readonly maxTotalMinutes?: number
  readonly minFiber?: number
  readonly minProtein?: number
  readonly nutrition?: NutritionPreset
  readonly time?: string
  // Allergen features from vocabularies, such as 'milk' or 'peanuts'.
  readonly without?: ReadonlyArray<string>
}

export type RecipeOptions = {
  // Rewrites every quantity for this many servings.
  readonly servings?: number
  readonly units?: UnitSystem
}

export type SearchParameters = {
  // Only return these fields of each result.
  readonly fields?: ReadonlyArray<string>
  readonly language?: Language
  readonly limit?: number
  readonly query: string
  readonly without?: ReadonlyArray<string>
}

export type ShoppingListRecipe = {
  readonly id: string
  // Scales the recipe to this many servings before adding it to the list.
  readonly servings?: number
}

type QueryValue = boolean | number | ReadonlyArray<string> | string | undefined

function encode(values: Readonly<Record<string, QueryValue>>) {
  const query: Record<string, string> = {}

  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      continue
    }

    query[name] = typeof value === 'object' ? value.join(',') : String(value)
  }

  return query
}

export function encodeIngredientListQuery(parameters: IngredientListParameters = {}): IngredientsListParams {
  return encode(parameters)
}

export function encodeIngredientNames(names: ReadonlyArray<string>): IngredientsResolveParams {
  return { names: names.join(',') }
}

export function encodePairingQuery(parameters: PairingParameters = {}): IngredientsPairingsParams {
  return encode(parameters)
}

export function encodePantryQuery(parameters: PantryParameters): PantryListParams {
  return { ...encode(parameters), ingredients: parameters.ingredients.join(',') }
}

export function encodePopularQuery(parameters: PopularParameters = {}): PopularListParams {
  return encode(parameters)
}

export function encodeRecipeFilters(filters: RecipeFilters = {}): RecipesListParams {
  return encode(filters)
}

export function encodeRecipeOptions(options: RecipeOptions = {}): RecipesByIdParams {
  return encode(options)
}

export function encodeSearchQuery(parameters: SearchParameters): SearchSearchParams {
  return { ...encode(parameters), query: parameters.query }
}

// The API takes `id:servings` pairs, such as `66d0a1b2:6,66d0a1b3`.
export function encodeShoppingList(recipes: ReadonlyArray<ShoppingListRecipe>): ShoppingListBuildParams {
  const encoded = recipes.map((recipe) => {
    return recipe.servings === undefined ? recipe.id : `${recipe.id}:${recipe.servings}`
  })

  return { recipes: encoded.join(',') }
}

export function encodeSubstitutionQuery(ingredients: ReadonlyArray<string>): SubstitutionsListParams {
  return { ingredients: ingredients.join(',') }
}
