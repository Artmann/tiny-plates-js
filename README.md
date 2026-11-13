# tiny-plates

Clients for the [Tiny Plates](https://www.tinyplates.dev) recipe API. The package has a plain client that returns promises and an Effect client. Both have the same methods and errors.

```bash
npm install tiny-plates
```

## Plain client

```ts
import { createClient, NotFoundError } from 'tiny-plates'

const tinyPlates = createClient({ apiKey: process.env.TINY_PLATES_API_KEY ?? '' })

try {
  const recipe = await tinyPlates.recipes.byId('carbonara', { servings: 4, units: 'metric' })

  console.log(recipe.title)
} catch (error) {
  if (error instanceof NotFoundError) {
    console.log('No such recipe.')
  } else {
    throw error
  }
}
```

Every method takes an `AbortSignal` as its last argument, `{ signal }`, to cancel the request.

Lists are paged. `list` returns one page. `iterate` walks all of them:

```ts
for await (const recipe of tinyPlates.pantry.iterate({ ingredients: ['egg', 'tomato'], maxMissing: 1 })) {
  console.log(recipe.title, recipe.coverage)
}
```

The plain client has no runtime dependencies and works anywhere `fetch` does. It doesn't check response bodies at runtime.

## Effect client

Install `effect` 4 next to the package. It is an optional peer dependency.

```ts
import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { TinyPlates } from 'tiny-plates/effect'

const program = Effect.gen(function* () {
  const tinyPlates = yield* TinyPlates
  const recipe = yield* tinyPlates.recipes.byId('carbonara')

  return recipe.title
}).pipe(
  Effect.catchTag('NotFoundError', () => {
    return Effect.succeed('No such recipe.')
  }),
)

const layer = TinyPlates.layerConfig().pipe(Layer.provide(FetchHttpClient.layer))

Effect.runPromise(Effect.provide(program, layer))
```

`TinyPlates.layerConfig()` reads the key from `TINY_PLATES_API_KEY`. Use `TinyPlates.layer({ apiKey: Redacted.make(key) })` to pass it yourself. The Effect client checks every response against the schema. Its error channel lists only the errors each endpoint can return. `stream` methods return every page as a `Stream`.

## Errors

| Error | When | Retried |
| --- | --- | --- |
| `AuthenticationError` | The API key is missing, wrong, expired or disabled. | No |
| `PlanRequiredError` | The endpoint needs a business plan (`recipes.list`, `ingredients.list`). | No |
| `RateLimitError` | The account has used its daily or weekly requests. `window` says which. | No |
| `NotFoundError` | The recipe or ingredient doesn't exist. | No |
| `InvalidRequestError` | A parameter is missing or invalid. `issues` lists what was wrong. | No |
| `InternalError` | Something failed on the Tiny Plates side. | Yes |
| `ConnectionError` | The request timed out (`timeout`) or never reached the API (`network_error`). | Yes |
| `UnexpectedResponseError` | The API answered with something the client doesn't recognise. | No |

Every error has a `code` and a message you can show to people. Requests time out after 10 seconds. Internal and connection errors are retried twice, waiting 500ms and then 1s. Change these with the `timeout` and `maxRetries` options.

## Development

```bash
bun install
bun run generate          # regenerate src/generated from openapi.json
bun run generate --fetch  # download the latest spec first
bun run typecheck
bun test
```

`openapi.json` is a committed snapshot of https://api.tinyplates.dev/openapi.json. `scripts/openapi-patch.json` works around a part of the spec that the generator can't read (the `patternProperties` on `Nutrition.micronutrients`).
