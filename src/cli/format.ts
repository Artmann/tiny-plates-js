// Turns API responses into text for people to read in a terminal. Every
// function is pure and returns the whole text, so the commands only print it.

import type {
  Duration,
  HealthCheck200,
  IngredientsById200,
  IngredientsList200,
  IngredientsPairings200,
  IngredientsResolve200,
  IngredientsVocabularies200,
  Pagination,
  PantryList200,
  PopularList200,
  Rating,
  RecipeTimes,
  RecipesById200,
  RecipesList200,
  SearchSearch200,
  Servings,
  ShoppingItem,
  ShoppingListBuild200,
  StatusRead200,
  SubstitutionsList200,
} from '../generated/types.ts'
import { plain } from './terminal.ts'
import type { Style } from './terminal.ts'

type Row = readonly [string, string]

// Lines up the second column, so titles start in the same place.
function table(rows: ReadonlyArray<Row>) {
  const width = Math.max(0, ...rows.map(([first]) => first.length))

  return rows.map(([first, second]) => `${first.padEnd(width)}  ${second}`.trimEnd())
}

function lines(...parts: ReadonlyArray<string | ReadonlyArray<string> | undefined>) {
  return parts.flatMap((part) => part ?? []).join('\n')
}

function percent(share: number) {
  return `${Math.round(share * 100)}%`
}

export function formatDuration(duration: Duration) {
  const minutes = Math.round(duration.seconds / 60)

  if (minutes < 60) {
    return `${minutes} min`
  }

  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60

  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

// Says which page this is and how to get the next one.
export function formatPagination(pagination: Pagination, shown: number) {
  if (shown === 0) {
    return pagination.total === 0 ? 'No recipes found.' : `No recipes at offset ${pagination.offset}. There are ${pagination.total} in total.`
  }

  const first = pagination.offset + 1
  const last = pagination.offset + shown
  const summary = `Showing ${first}-${last} of ${pagination.total}.`

  if (last >= pagination.total) {
    return summary
  }

  return `${summary} Use --offset ${last} to see more.`
}

export function formatHealth(response: HealthCheck200) {
  return `Tiny Plates is ${response.status === 'ok' ? 'up' : response.status}. Running ${response.gitSha}, started ${response.startedAt}.`
}

export function formatIngredient({ ingredient }: IngredientsById200) {
  const substitutions = ingredient.substitutions.map((substitution) => {
    return `  ${substitution.ratio} × ${substitution.ingredient}${substitution.note === undefined ? '' : ` (${substitution.note})`}`
  })

  return lines(
    `${ingredient.name} (${ingredient.id})`,
    `Used in ${ingredient.recipeCount} recipes.`,
    ingredient.parent === undefined ? undefined : `A kind of ${ingredient.parent}.`,
    ingredient.staple ? 'A staple most kitchens have.' : undefined,
    substitutions.length === 0 ? undefined : ['', 'Substitutions:', ...substitutions],
  )
}

export function formatIngredients({ ingredients }: IngredientsList200) {
  if (ingredients.length === 0) {
    return 'No ingredients found.'
  }

  return lines(table(ingredients.map((ingredient) => {
    return [ingredient.id, `${ingredient.names.en ?? ingredient.id} (${ingredient.recipeCount} recipes)`]
  })))
}

export function formatPairings(response: IngredientsPairings200) {
  if (response.pairings.length === 0) {
    return `No pairings found for ${response.ingredient.name}.`
  }

  return lines(
    `Goes well with ${response.ingredient.name}, from ${response.recipeCount} recipes:`,
    '',
    table(response.pairings.map((pairing) => {
      return [percent(pairing.share), `${pairing.name} (${pairing.id})`]
    })),
  )
}

// The parts of a recipe a list shows. Search results only have the fields
// that were asked for, so everything but the id is optional.
type ListedRecipe = {
  readonly courses?: ReadonlyArray<string>
  readonly cuisines?: ReadonlyArray<string>
  readonly id: string
  readonly rating?: Rating
  readonly servings?: Servings
  readonly times?: RecipeTimes
  readonly title?: string
}

// Turns a vocabulary value like main-course into Main course.
function humanize(value: string) {
  const words = value.replaceAll('-', ' ')

  return `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}`
}

function totalTime(times: RecipeTimes | undefined) {
  if (times?.total !== undefined) {
    return times.total
  }

  const seconds = (times?.prep?.seconds ?? 0) + (times?.cook?.seconds ?? 0)

  return seconds === 0 ? undefined : { seconds }
}

// One line that helps pick a recipe: where it's from, what it is, how long it
// takes, how many it feeds and what people thought of it.
export function formatRecipeDetails(recipe: ListedRecipe, style: Style = plain) {
  const time = totalTime(recipe.times)

  return [
    ...(recipe.cuisines ?? []).slice(0, 2).map(humanize),
    ...(recipe.courses ?? []).slice(0, 1).map(humanize),
    time === undefined ? undefined : formatDuration(time),
    recipe.servings?.quantity === undefined ? undefined : `Serves ${recipe.servings.quantity}`,
    recipe.rating === undefined || recipe.rating.count === 0
      ? undefined
      : `${style.yellow('★')} ${recipe.rating.value.toFixed(1)} (${recipe.rating.count})`,
  ].filter((part) => part !== undefined).join(style.dim(' · '))
}

// A numbered list with the title first, the details under it and the id
// last, dimmed, for `tiny-plates recipe <id>`.
function formatRecipeList(
  recipes: ReadonlyArray<ListedRecipe & { readonly extra?: string }>,
  firstNumber: number,
  style: Style,
) {
  const width = `${firstNumber + recipes.length - 1}.`.length
  const indent = ' '.repeat(width + 1)

  return recipes.flatMap((recipe, index) => {
    const details = formatRecipeDetails(recipe, style)

    return [
      ...(index === 0 ? [] : ['']),
      `${style.cyan(`${firstNumber + index}.`.padStart(width))} ${style.bold(recipe.title ?? recipe.id)}`,
      details === '' ? undefined : `${indent}${details}`,
      recipe.extra === undefined ? undefined : `${indent}${recipe.extra}`,
      `${indent}${style.dim(recipe.id)}`,
    ].filter((line) => line !== undefined)
  })
}

const recipeHint = 'Run tiny-plates recipe <id> to see a recipe.'

function formatPagedRecipes(
  recipes: ReadonlyArray<ListedRecipe & { readonly extra?: string }>,
  pagination: Pagination,
  style: Style,
) {
  if (recipes.length === 0) {
    return formatPagination(pagination, 0)
  }

  return lines(
    formatRecipeList(recipes, pagination.offset + 1, style),
    '',
    style.dim(formatPagination(pagination, recipes.length)),
    style.dim(recipeHint),
  )
}

export function formatPantry(response: PantryList200, style: Style = plain) {
  const recipes = response.recipes.map((recipe) => {
    const complete = recipe.missingIngredients.length === 0
    const missing = complete ? 'You have everything' : `Missing ${recipe.missingIngredients.join(', ')}`
    const color = complete ? style.green : style.yellow

    return { ...recipe, extra: color(`${percent(recipe.coverage)} covered · ${missing}`) }
  })

  return formatPagedRecipes(recipes, response.pagination, style)
}

export function formatPopular(response: PopularList200 | RecipesList200, style: Style = plain) {
  return formatPagedRecipes(response.recipes, response.pagination, style)
}

export function formatRecipe(response: RecipesById200, style: Style = plain) {
  const { recipe } = response
  const times = [
    recipe.times.prep === undefined ? undefined : `Prep ${formatDuration(recipe.times.prep)}`,
    recipe.times.cook === undefined ? undefined : `Cook ${formatDuration(recipe.times.cook)}`,
    recipe.times.total === undefined ? undefined : `Total ${formatDuration(recipe.times.total)}`,
  ].filter((time) => time !== undefined)
  const servings = response.nutritionTotals?.servings ?? recipe.servings?.quantity

  return lines(
    style.bold(recipe.title),
    recipe.description === undefined ? undefined : style.dim(recipe.description),
    '',
    servings === undefined ? undefined : `Serves ${servings}`,
    times.length === 0 ? undefined : times.join(style.dim(' · ')),
    '',
    style.bold('Ingredients:'),
    recipe.ingredients.map((ingredient) => {
      return `  ${style.cyan('-')} ${ingredient.display}${ingredient.optional ? style.dim(' (optional)') : ''}`
    }),
    '',
    style.bold('Steps:'),
    recipe.instructions.map((instruction) => {
      return `  ${style.cyan(`${instruction.step}.`)} ${instruction.text}`
    }),
    '',
    style.dim(`Source: ${recipe.url}`),
  )
}

export function formatResolvedIngredients(response: IngredientsResolve200) {
  const rows = response.ingredients.map((ingredient): Row => {
    return [ingredient.query, `${ingredient.id} (${ingredient.name})`]
  })

  return lines(
    table(rows),
    response.unknown.length === 0 ? undefined : `Unknown: ${response.unknown.join(', ')}`,
  )
}

export function formatSearch(response: SearchSearch200, style: Style = plain) {
  if (response.results.length === 0) {
    return 'No recipes found. Try fewer or different words.'
  }

  return lines(formatRecipeList(response.results, 1, style), '', style.dim(recipeHint))
}

function formatShoppingItem(item: ShoppingItem, style: Style) {
  return `  ${style.cyan('-')} ${item.display}${item.plusMore === true ? style.dim(', plus more') : ''}`
}

export function formatShoppingList(response: ShoppingListBuild200, style: Style = plain) {
  const categories = [...new Set(response.items.map((item) => item.category))].sort()

  return lines(
    style.bold(`Shopping list for ${response.recipes.map((recipe) => `${recipe.title} (serves ${recipe.servings})`).join(', ')}`),
    categories.flatMap((category) => {
      const items = response.items.filter((item) => item.category === category)

      return ['', style.bold(`${humanize(category)}:`), ...items.map((item) => formatShoppingItem(item, style))]
    }),
  )
}

export function formatStatus(response: StatusRead200) {
  return `${response.recipes} recipes from ${response.sites} sites.`
}

export function formatSubstitutions(response: SubstitutionsList200) {
  const sections = response.substitutions.flatMap((substitution, index) => {
    const options = substitution.options.length === 0
      ? ['  No substitutions known.']
      : substitution.options.map((option) => {
          const note = option.note === undefined ? '' : ` (${option.note})`
          const caution = option.caution === undefined ? '' : ` Caution: ${option.caution}`

          return `  ${option.ratio} × ${option.ingredient}${note}${caution}`
        })

    return [...(index === 0 ? [] : ['']), `Instead of ${substitution.ingredient}:`, ...options]
  })

  return lines(
    sections,
    response.unknown.length === 0 ? undefined : [...(sections.length === 0 ? [] : ['']), `Unknown: ${response.unknown.join(', ')}`],
  )
}

export function formatVocabularies(response: IngredientsVocabularies200) {
  return lines(
    `Allergens: ${response.allergens.map((allergen) => allergen.feature).join(', ')}`,
    `Courses: ${response.courses.join(', ')}`,
    `Cuisines: ${response.cuisines.join(', ')}`,
    `Diets: ${response.diets.join(', ')}`,
    `Units: ${response.units.join(', ')}`,
  )
}
