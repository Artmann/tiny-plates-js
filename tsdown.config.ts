import { defineConfig } from 'tsdown'

export default defineConfig([
  // Builds both library entry points as ES modules and as CommonJS, each with
  // its own type declarations, so the package works with `import` and
  // `require`.
  {
    clean: true,
    dts: true,
    entry: {
      'effect/index': 'src/effect/index.ts',
      index: 'src/index.ts'
    },
    format: ['esm', 'cjs'],
    outDir: 'dist',
    platform: 'neutral',
    sourcemap: true,
    tsconfig: 'tsconfig.build.json'
  },
  // Builds the CLI as one file with Effect bundled in, so `npx tiny-plates`
  // works without installing anything, and the library keeps no runtime
  // dependencies.
  {
    clean: false,
    deps: {
      alwaysBundle: [/.*/],
      onlyBundle: false
    },
    dts: false,
    entry: {
      cli: 'src/cli/main.ts'
    },
    format: ['esm'],
    minify: true,
    outDir: 'dist',
    platform: 'node',
    tsconfig: 'tsconfig.build.json'
  }
])
