# Contributing

Thanks for helping out. This guide covers how the library is built, how to run it locally and the conventions we follow. If you are looking for how to use the library, read the [README](README.md).

## Setup

You need [Bun](https://bun.sh) 1.4 or later. The library itself runs anywhere `fetch` does, but the tests, scripts and type checks run with Bun.

```bash
git clone https://github.com/Artmann/tiny-plates-js.git
cd tiny-plates-js
bun install
```

None of the tests call the real API, so you don't need an API key to work on the library. If you want to try your changes against the API, [sign up](https://www.tinyplates.dev/sign-up) for a free key.

## Commands

```bash
bun test                  # run the tests
bun run typecheck         # type check everything, tests included
bun run build             # build ES module and CommonJS output, with types, into dist
bun run check:package     # check that the built package resolves for import and require
bun run generate          # regenerate src/generated from openapi.json
bun run generate --fetch  # download the latest spec, then regenerate
```

Run `bun test` and `bun run typecheck` before you open a pull request. CI runs both, the build and the package check on every pull request.

The package is published as compiled JavaScript from `dist`, so it works in Node without a TypeScript loader. [tsdown](https://tsdown.dev) builds each entry point twice, as an ES module (`.js` and `.d.ts`) and as CommonJS (`.cjs` and `.d.cts`), and `exports` in `package.json` points `import` and `require` at the right files. `tsdown.config.ts` sets the entry points and `tsconfig.build.json` sets the compiler options. It leaves out Bun's types, so the build fails if library code uses anything Bun-only. To try the package the way users get it, run `npm pack` and install the tarball in another project.

## How the code is laid out

```
openapi.json          a committed snapshot of the API spec
scripts/generate.ts   generates src/generated from openapi.json
src/
  index.ts            the plain client's public exports (tiny-plates)
  client/             the plain client: methods, transport and error classes
  effect/             the Effect client (tiny-plates/effect)
  core/               shared by both: parameters and error mapping
  generated/          generated from the spec, never edited by hand
dist/                 the build output that gets published, not committed
```

The two clients share everything that isn't specific to Promises or Effect:

- `src/core/parameters.ts` defines the parameter types callers write, such as `ingredients: ['egg']`. It also encodes them into the query strings the API reads.
- `src/core/errors.ts` turns an error response from the API into one of a few failures, grouped by what the caller can do about them. It also holds the messages for failures the API never sees, like timeouts.

The plain client makes its own `fetch` calls, and its responses are typed but not checked at runtime. The Effect client is built on the generated `HttpApi` definition, so it checks every response against the schema.

## The spec and the generated code

`openapi.json` is a snapshot of https://api.tinyplates.dev/openapi.json. Everything in `src/generated` comes from it via [`@effect/openapi-generator`](https://www.npmjs.com/package/@effect/openapi-generator):

- `api.ts` is the `HttpApi` definition the Effect client uses.
- `types.ts` is plain type aliases for the plain client. It has no runtime code and doesn't import `effect`.

Don't edit these files by hand. Your changes will be lost the next time someone runs the generator. If the generated code is wrong, fix the spec in the API or the script in `scripts/generate.ts`.

When the API changes:

1. Run `bun run generate --fetch`.
2. Run `bun run typecheck` and `bun test`. Type errors point to the parts of the clients that need updating.
3. Commit `openapi.json` and `src/generated` together with the client changes.

The tests read error codes from `openapi.json`. If the spec adds an error code the client doesn't map, or drops one the client still knows, `src/core/errors.test.ts` fails. Map new codes in `apiErrorKinds` in `src/core/errors.ts`.

## Adding an endpoint

A new endpoint goes into both clients, with the same name and parameters:

1. Regenerate from the spec.
2. If the endpoint takes query parameters, add a parameter type and an encoder to `src/core/parameters.ts`. Type lists as arrays and numbers as numbers, even though the API reads them as strings.
3. Add the method to `createClient` in `src/client/client.ts`.
4. Add it to `TinyPlatesService` and the service in `src/effect/TinyPlates.ts`. List only the errors the endpoint can return in its error type.
5. Add tests for both clients and a row to the method table in the README, with a link to the endpoint's page in the [docs](https://www.tinyplates.dev/docs).

## Errors

Every error message should tell the person what went wrong and what they can do about it. "Tiny Plates did not respond within 10 seconds. Check your connection or raise the timeout option." is good. "Request failed." is not.

Most messages come from the API. Messages for failures the client finds itself go in `clientMessages` in `src/core/errors.ts`, so both clients say the same thing.

Only internal and connection errors are retried. Don't retry rate limits: the wait runs until midnight UTC, which can be hours.

## Tests

Tests live next to the code they test, as `*.test.ts`, and run with `bun test`.

- Test the clients through their public methods, with a mocked `fetch` that returns real `Response` objects. Look at `src/client/client.test.ts` and `src/effect/TinyPlates.test.ts` for the helpers.
- Unit test small modules without side effects, such as the parameter encoders and error mapping, on their own.
- Prefer `toEqual` over `toBe`, and compare whole objects rather than single properties: `expect(failure).toEqual({ code: 'recipe_not_found', kind: 'not_found', ... })`.

## Code style

- Single quotes and no semicolons.
- Always use braces for `if`, `for` and the like.
- Use whole words for names: `request`, not `req`. Don't use `CONSTANT_CASE`.
- No `any`. Use proper types or `unknown`.
- No non-null assertions (`!`). Prefer `??` over `||`.
- Always await or handle promises.
- Give every network call a timeout, and clean up timers and listeners in a `finally`.
- Keep things in alphabetical order unless there's a reason not to.
- Leave a blank line after groups of constants and control flow, and before `return`.
- Use the words the Tiny Plates docs use. If the docs call it a pantry, the code calls it a pantry.

## Commits and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org). The scope names the part of the library you changed, such as `client`, `effect`, `errors`, `parameters`, `generator` or `docs`:

```
feat(effect): Add a stream method for search results
fix(client): Retry when the connection resets
```

The commit type decides the next version and what goes in the changelog, so pick it with care:

- `fix` makes a patch release.
- `feat` makes a minor release.
- A `!` after the type, or a `BREAKING CHANGE:` footer, marks a breaking change. Until 1.0 it makes a minor release, and after that a major one.
- `docs`, `test`, `chore` and the like don't make a release on their own.

In the pull request, explain the problem you're solving and what you changed, at a high level. Mention anything that still needs to be done by hand, such as an API change that hasn't been deployed yet. When a pull request is squash merged, its title becomes the commit message, so write the title in the same format.

## Releases

Releases are made by [release-please](https://github.com/googleapis/release-please). Don't bump the version or edit `CHANGELOG.md` by hand.

1. Every push to `main` updates a release pull request. It bumps the version in `package.json` and adds the new commits to `CHANGELOG.md`.
2. Merge the release pull request when you want to ship. That tags the release and creates a GitHub release.
3. The release workflow then builds, tests and publishes the package to npm with provenance.

The setup lives in `release-please-config.json`, `.release-please-manifest.json` and `.github/workflows/release.yml`.

## Reporting bugs

Open an [issue](https://github.com/Artmann/tiny-plates-js/issues). Include the version of the library, the method you called, and the error's `code` and message. Never paste your API key.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
