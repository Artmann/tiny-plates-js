import { Config, Console, Effect, Option, Redacted } from 'effect'
import { Argument, CliError, Command, Flag } from 'effect/cli'
import type { ShoppingListRecipe } from '../core/parameters.ts'
import type { TinyPlatesError } from '../effect/errors.ts'
import { TinyPlates } from '../effect/TinyPlates.ts'
import type { TinyPlatesService } from '../effect/TinyPlates.ts'
import {
  formatHealth,
  formatIngredient,
  formatIngredients,
  formatPairings,
  formatPantry,
  formatPopular,
  formatRecipe,
  formatResolvedIngredients,
  formatSearch,
  formatShoppingList,
  formatStatus,
  formatSubstitutions,
  formatVocabularies,
} from './format.ts'
import { login as signIn, logout as signOut, readAccessToken } from './login.ts'
import type { LoginError } from './login.ts'
import { outputStyle, withSpinner } from './terminal.ts'
import type { Style } from './terminal.ts'

export const cliMessages = {
  invalidShoppingListRecipe: (value: string) => {
    return `"${value}" is not a recipe. Write a recipe id, optionally followed by a colon and a number of servings, like carbonara:4.`
  },
  loggedIn: (path: string) => {
    return `You are signed in. Your sign-in is saved in ${path}.`
  },
  loggedOut: 'You are signed out.',
  missingApiKey: 'You are not signed in. Run tiny-plates login, or set the TINY_PLATES_API_KEY environment variable or pass --api-key. Create a key at https://www.tinyplates.dev/sign-up.',
  notLoggedIn: 'You were not signed in.',
}

function toUserError(error: LoginError) {
  return new CliError.UserError({ cause: error, userMessage: error.message })
}

// Flags every command takes. They can go before or after the command name.
const tinyPlates = Command.make('tiny-plates').pipe(
  Command.withSharedFlags({
    apiKey: Flag.Redacted('api-key').pipe(
      Flag.withDescription('Your Tiny Plates API key. Defaults to the TINY_PLATES_API_KEY environment variable.'),
      Flag.withFallbackConfig(Config.Redacted('TINY_PLATES_API_KEY')),
      Flag.optional,
    ),
    json: Flag.Boolean('json').pipe(
      Flag.withDescription('Print the API response as JSON.'),
      Flag.withDefault(false),
    ),
  }),
  Command.withDescription('Search recipes, cook from your pantry, build shopping lists and look up ingredients with the Tiny Plates API.'),
)

// Lists can be given as one comma-separated value, as repeated flags, or both:
// `--without milk,peanuts` and `--without milk --without peanuts` are the same.
function listFlag(name: string, description: string) {
  return Flag.String(name).pipe(
    Flag.atLeast(0),
    Flag.map(splitList),
    Flag.withDescription(description),
  )
}

function splitList(values: ReadonlyArray<string>) {
  return values.flatMap((value) => value.split(',')).map((value) => value.trim()).filter((value) => value !== '')
}

function optionalList(values: ReadonlyArray<string>) {
  return values.length === 0 ? undefined : values
}

const language = Flag.String('language').pipe(
  Flag.withDescription('A language code, such as en or sv.'),
  Flag.optional,
)

const limit = Flag.Int('limit').pipe(
  Flag.withDescription('How many results to return.'),
  Flag.optional,
)

const offset = Flag.Int('offset').pipe(
  Flag.withDescription('How many results to skip.'),
  Flag.optional,
)

const without = listFlag('without', 'Leave out recipes with these allergens, such as milk or peanuts.')

// Runs one request with the client and prints the response, as JSON or as
// text. API failures become errors with the API's message, which says what to
// do about it.
const request = Effect.fnUntraced(function* <Response>(
  call: (client: TinyPlatesService) => Effect.Effect<Response, TinyPlatesError>,
  format: (response: Response, style: Style) => string,
  options: { readonly anonymous?: boolean } = {},
) {
  const { apiKey, json } = yield* tinyPlates

  const response = yield* withSpinner('Asking Tiny Plates…', Effect.gen(function* () {
    const key = yield* readCredential(apiKey, options.anonymous ?? false)
    const client = yield* TinyPlates.pipe(Effect.provide(TinyPlates.layer({ apiKey: key })))

    return yield* call(client).pipe(
      Effect.catch((error) => {
        return Effect.fail(new CliError.UserError({ cause: error, userMessage: error.message }))
      }),
    )
  }))

  yield* Console.log(json ? JSON.stringify(response, null, 2) : format(response, outputStyle()))
})

// An API key wins over a saved sign-in, so a key in the environment still
// works for scripts on a machine where someone has signed in.
const readCredential = Effect.fnUntraced(function* (apiKey: Option.Option<Redacted.Redacted<string>>, anonymous: boolean) {
  if (Option.isSome(apiKey) && Redacted.value(apiKey.value).trim() !== '') {
    return apiKey.value
  }

  // The client needs a key, but endpoints like /health don't read it.
  if (anonymous) {
    return Redacted.make('anonymous')
  }

  const accessToken = yield* readAccessToken.pipe(Effect.mapError(toUserError))

  if (Option.isSome(accessToken)) {
    return accessToken.value
  }

  return yield* new CliError.UserError({ cause: cliMessages.missingApiKey, userMessage: cliMessages.missingApiKey })
})

// Reads `id` or `id:servings`.
export function parseShoppingListRecipe(value: string): ShoppingListRecipe | undefined {
  const match = /^([^:\s]+)(?::(\d+))?$/.exec(value.trim())

  if (match === null || match[1] === undefined) {
    return undefined
  }

  const servings = match[2] === undefined ? undefined : Number(match[2])

  if (servings === 0) {
    return undefined
  }

  return servings === undefined ? { id: match[1] } : { id: match[1], servings }
}

const health = Command.make('health', {}, () => {
  return request((client) => client.health.check(), formatHealth, { anonymous: true })
}).pipe(
  Command.withDescription('Check whether the API is up. Needs no API key.'),
)

const ingredient = Command.make('ingredient', {
  id: Argument.String('id').pipe(Argument.withDescription('An ingredient id, such as chicken-thigh.')),
}, ({ id }) => {
  return request((client) => client.ingredients.byId(id), formatIngredient)
}).pipe(
  Command.withDescription('Show one ingredient and what to use instead of it.'),
  Command.withExamples([{ command: 'tiny-plates ingredient buttermilk', description: 'Look up buttermilk' }]),
)

const ingredients = Command.make('ingredients', { limit }, ({ limit }) => {
  return request((client) => client.ingredients.list({ limit: Option.getOrUndefined(limit) }), formatIngredients)
}).pipe(
  Command.withDescription('List every ingredient. Needs a business plan.'),
)

const login = Command.make('login', {}, Effect.fnUntraced(function* () {
  const path = yield* signIn.pipe(Effect.mapError(toUserError))

  yield* Console.log(outputStyle().green(cliMessages.loggedIn(path)))
})).pipe(
  Command.withDescription('Sign in to Tiny Plates in your browser, instead of using an API key.'),
)

const logout = Command.make('logout', {}, Effect.fnUntraced(function* () {
  const wasSignedIn = yield* signOut.pipe(Effect.mapError(toUserError))

  yield* Console.log(wasSignedIn ? outputStyle().green(cliMessages.loggedOut) : cliMessages.notLoggedIn)
})).pipe(
  Command.withDescription('Sign out and forget the saved sign-in.'),
)

const pairings = Command.make('pairings', {
  id: Argument.String('id').pipe(Argument.withDescription('An ingredient id, such as tomato.')),
  limit,
  staples: Flag.Boolean('staples').pipe(
    Flag.withDescription('Include salt, pepper, oil, sugar, flour and water.'),
    Flag.withDefault(false),
  ),
}, ({ id, limit, staples }) => {
  return request((client) => client.ingredients.pairings(id, { limit: Option.getOrUndefined(limit), staples }), formatPairings)
}).pipe(
  Command.withDescription('Show ingredients that go well with an ingredient.'),
  Command.withExamples([{ command: 'tiny-plates pairings tomato --limit 10', description: 'The ten best pairings for tomato' }]),
)

const pantry = Command.make('pantry', {
  ingredients: Argument.String('ingredients').pipe(
    Argument.withDescription('What you have, 1 to 20 ingredient names or ids, in any language.'),
    Argument.variadic({ min: 1 }),
  ),
  language,
  limit,
  maxMissing: Flag.Int('max-missing').pipe(
    Flag.withDescription('How many ingredients a recipe may need that you don\'t have. 0 shows only what you can cook now.'),
    Flag.optional,
  ),
  offset,
  staples: Flag.Boolean('staples').pipe(
    Flag.withDescription('Count salt, pepper, water, oil, sugar and flour as in the kitchen. Turn off with --no-staples.'),
    Flag.withDefault(true),
  ),
  without,
}, (input) => {
  return request((client) => {
    return client.pantry.list({
      ingredients: splitList(input.ingredients),
      language: Option.getOrUndefined(input.language),
      limit: Option.getOrUndefined(input.limit),
      maxMissing: Option.getOrUndefined(input.maxMissing),
      offset: Option.getOrUndefined(input.offset),
      staples: input.staples,
      without: optionalList(input.without),
    })
  }, formatPantry)
}).pipe(
  Command.withDescription('Find recipes you can cook with what you have, best match first.'),
  Command.withExamples([
    { command: 'tiny-plates pantry egg tomato onion --max-missing 1', description: 'Recipes missing at most one ingredient' },
    { command: 'tiny-plates pantry egg tomato --without milk', description: 'Recipes without milk' },
  ]),
)

const popular = Command.make('popular', { language, limit, offset }, (input) => {
  return request((client) => {
    return client.popular.list({
      language: Option.getOrUndefined(input.language),
      limit: Option.getOrUndefined(input.limit),
      offset: Option.getOrUndefined(input.offset),
    })
  }, formatPopular)
}).pipe(
  Command.withDescription('List the most popular recipes.'),
)

const recipe = Command.make('recipe', {
  id: Argument.String('id').pipe(Argument.withDescription('A recipe id, from search or popular.')),
  servings: Flag.Int('servings').pipe(
    Flag.withDescription('Scale every quantity for this many servings.'),
    Flag.optional,
  ),
  units: Flag.Literals('units', ['metric', 'imperial']).pipe(
    Flag.withDescription('Convert quantities to metric or imperial.'),
    Flag.optional,
  ),
}, ({ id, servings, units }) => {
  return request((client) => {
    return client.recipes.byId(id, { servings: Option.getOrUndefined(servings), units: Option.getOrUndefined(units) })
  }, formatRecipe)
}).pipe(
  Command.withDescription('Show one recipe, with its ingredients and steps.'),
  Command.withExamples([{ command: 'tiny-plates recipe carbonara --servings 4 --units metric', description: 'Carbonara for four, in metric' }]),
)

const recipes = Command.make('recipes', {
  category: Flag.String('category').pipe(Flag.withDescription('Only recipes in this category.'), Flag.optional),
  course: Flag.String('course').pipe(Flag.withDescription('Only recipes for this course, such as dessert.'), Flag.optional),
  cuisine: Flag.String('cuisine').pipe(Flag.withDescription('Only recipes from this cuisine, such as italian.'), Flag.optional),
  diet: Flag.String('diet').pipe(Flag.withDescription('Only recipes for this diet, such as vegan.'), Flag.optional),
  equipment: listFlag('equipment', 'Only recipes that use all of this equipment.'),
  excludeIngredients: listFlag('exclude-ingredients', 'Leave out recipes with any of these ingredients.'),
  ingredient: Flag.String('ingredient').pipe(Flag.withDescription('Only recipes with this ingredient id, such as chicken-thigh.'), Flag.optional),
  ingredients: listFlag('ingredients', 'Only recipes with all of these ingredients.'),
  language,
  limit,
  maxCalories: Flag.Int('max-calories').pipe(Flag.withDescription('At most this many calories per serving.'), Flag.optional),
  maxCookMinutes: Flag.Int('max-cook-minutes').pipe(Flag.withDescription('At most this many minutes of cooking.'), Flag.optional),
  maxSodium: Flag.Int('max-sodium').pipe(Flag.withDescription('At most this many milligrams of sodium per serving.'), Flag.optional),
  maxTotalMinutes: Flag.Int('max-total-minutes').pipe(Flag.withDescription('At most this many minutes in total.'), Flag.optional),
  minFiber: Flag.Int('min-fiber').pipe(Flag.withDescription('At least this many grams of fiber per serving.'), Flag.optional),
  minProtein: Flag.Int('min-protein').pipe(Flag.withDescription('At least this many grams of protein per serving.'), Flag.optional),
  nutrition: Flag.Literals('nutrition', ['high-fiber', 'high-protein', 'low-calorie', 'low-sodium']).pipe(
    Flag.withDescription('A nutrition preset.'),
    Flag.optional,
  ),
  offset,
  time: Flag.String('time').pipe(Flag.withDescription('A time bucket, such as quick.'), Flag.optional),
  without,
}, (input) => {
  return request((client) => {
    return client.recipes.list({
      category: Option.getOrUndefined(input.category),
      course: Option.getOrUndefined(input.course),
      cuisine: Option.getOrUndefined(input.cuisine),
      diet: Option.getOrUndefined(input.diet),
      equipment: optionalList(input.equipment),
      excludeIngredients: optionalList(input.excludeIngredients),
      ingredient: Option.getOrUndefined(input.ingredient),
      ingredients: optionalList(input.ingredients),
      language: Option.getOrUndefined(input.language),
      limit: Option.getOrUndefined(input.limit),
      maxCalories: Option.getOrUndefined(input.maxCalories),
      maxCookMinutes: Option.getOrUndefined(input.maxCookMinutes),
      maxSodium: Option.getOrUndefined(input.maxSodium),
      maxTotalMinutes: Option.getOrUndefined(input.maxTotalMinutes),
      minFiber: Option.getOrUndefined(input.minFiber),
      minProtein: Option.getOrUndefined(input.minProtein),
      nutrition: Option.getOrUndefined(input.nutrition),
      offset: Option.getOrUndefined(input.offset),
      time: Option.getOrUndefined(input.time),
      without: optionalList(input.without),
    })
  }, formatPopular)
}).pipe(
  Command.withDescription('Filter every recipe by cuisine, diet, time, nutrition and more. Needs a business plan.'),
  Command.withExamples([{ command: 'tiny-plates recipes --cuisine italian --diet vegetarian --max-total-minutes 30', description: 'Quick vegetarian Italian recipes' }]),
)

const resolve = Command.make('resolve', {
  names: Argument.String('names').pipe(
    Argument.withDescription('Ingredient names, in any language.'),
    Argument.variadic({ min: 1 }),
  ),
}, ({ names }) => {
  return request((client) => client.ingredients.resolve(splitList(names)), formatResolvedIngredients)
}).pipe(
  Command.withDescription('Turn ingredient names into ingredient ids.'),
  Command.withExamples([{ command: 'tiny-plates resolve tomate ägg', description: 'Resolve names in Spanish and Swedish' }]),
)

const search = Command.make('search', {
  fields: listFlag('fields', 'Only return these fields of each result. Most useful with --json.'),
  language,
  limit,
  query: Argument.String('query').pipe(
    Argument.withDescription('What to search for.'),
    Argument.variadic({ min: 1 }),
  ),
  without,
}, (input) => {
  return request((client) => {
    return client.search({
      fields: optionalList(input.fields),
      language: Option.getOrUndefined(input.language),
      limit: Option.getOrUndefined(input.limit),
      query: input.query.join(' '),
      without: optionalList(input.without),
    })
  }, formatSearch)
}).pipe(
  Command.withDescription('Search recipes by text.'),
  Command.withExamples([
    { command: 'tiny-plates search carbonara', description: 'Search for carbonara' },
    { command: 'tiny-plates search chocolate cake --without eggs --limit 5', description: 'Five egg-free chocolate cakes' },
  ]),
)

const shoppingList = Command.make('shopping-list', {
  recipes: Argument.String('recipes').pipe(
    Argument.withDescription('Recipe ids, each optionally followed by a colon and a number of servings.'),
    Argument.variadic({ min: 1 }),
  ),
}, Effect.fnUntraced(function* ({ recipes }) {
  const parsed: Array<ShoppingListRecipe> = []

  for (const value of splitList(recipes)) {
    const recipe = parseShoppingListRecipe(value)

    if (recipe === undefined) {
      const message = cliMessages.invalidShoppingListRecipe(value)

      return yield* new CliError.UserError({ cause: message, userMessage: message })
    }

    parsed.push(recipe)
  }

  return yield* request((client) => client.shoppingList.build(parsed), formatShoppingList)
})).pipe(
  Command.withDescription('Build one shopping list for several recipes, grouped by aisle.'),
  Command.withExamples([{ command: 'tiny-plates shopping-list carbonara:4 caesar-salad', description: 'Carbonara for four and a Caesar salad' }]),
)

const status = Command.make('status', {}, () => {
  return request((client) => client.status.read(), formatStatus)
}).pipe(
  Command.withDescription('Show how many recipes and sites the catalogue has.'),
)

const substitutions = Command.make('substitutions', {
  ingredients: Argument.String('ingredients').pipe(
    Argument.withDescription('The ingredients to replace.'),
    Argument.variadic({ min: 1 }),
  ),
}, ({ ingredients }) => {
  return request((client) => client.substitutions.list(splitList(ingredients)), formatSubstitutions)
}).pipe(
  Command.withDescription('Show what to use instead of an ingredient.'),
  Command.withExamples([{ command: 'tiny-plates substitutions buttermilk', description: 'What to use instead of buttermilk' }]),
)

const vocabularies = Command.make('vocabularies', {}, () => {
  return request((client) => client.ingredients.vocabularies(), formatVocabularies)
}).pipe(
  Command.withDescription('List the values you can filter on, such as cuisines, diets and allergens.'),
)

export const cli = tinyPlates.pipe(
  Command.withSubcommands([
    health,
    ingredient,
    ingredients,
    login,
    logout,
    pairings,
    pantry,
    popular,
    recipe,
    recipes,
    resolve,
    search,
    shoppingList,
    status,
    substitutions,
    vocabularies,
  ]),
)

// Runs the CLI with the given arguments, without the program name. Needs an
// HttpClient for the requests, a Browser to sign in with, and the services
// Effect CLI uses.
export function runCli(args: ReadonlyArray<string>, version: string) {
  return Command.runWith(cli, { version })(args)
}
