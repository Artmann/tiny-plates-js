import { defineConfig } from 'tsdown'

// Builds both entry points as ES modules and as CommonJS, each with its own
// type declarations, so the package works with `import` and `require`.
export default defineConfig({
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
})
