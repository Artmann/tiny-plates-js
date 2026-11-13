#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import packageJson from '../../package.json' with { type: 'json' }
import { runCli } from './commands.ts'
import { Browser } from './login.ts'

const services = Layer.mergeAll(Browser.layer, FetchHttpClient.layer, NodeServices.layer)

runCli(process.argv.slice(2), packageJson.version).pipe(
  Effect.provide(services),
  NodeRuntime.runMain,
)
