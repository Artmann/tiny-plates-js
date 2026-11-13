// What the command does differently when a person is watching: colours on
// standard output, and a spinner on standard error while it waits. Neither
// shows up when the output is piped, so `--json | jq` and scripts get plain
// text.

import { Effect } from 'effect'

// How to emphasise text in the command's output.
export type Style = {
  readonly bold: (text: string) => string
  readonly cyan: (text: string) => string
  readonly dim: (text: string) => string
  readonly green: (text: string) => string
  readonly red: (text: string) => string
  readonly yellow: (text: string) => string
}

function ansi(open: number, close: number) {
  return (text: string) => `\u001B[${open}m${text}\u001B[${close}m`
}

export const plain: Style = {
  bold: (text) => text,
  cyan: (text) => text,
  dim: (text) => text,
  green: (text) => text,
  red: (text) => text,
  yellow: (text) => text,
}

export const colored: Style = {
  bold: ansi(1, 22),
  cyan: ansi(36, 39),
  dim: ansi(2, 22),
  green: ansi(32, 39),
  red: ansi(31, 39),
  yellow: ansi(33, 39),
}

// See https://no-color.org.
function colorsAllowed() {
  return process.env.NO_COLOR === undefined || process.env.NO_COLOR === ''
}

// Read at call time, not at import, so tests and pipes get plain text.
export function outputStyle(): Style {
  return process.stdout.isTTY === true && colorsAllowed() ? colored : plain
}

export function errorStyle(): Style {
  return process.stderr.isTTY === true && colorsAllowed() ? colored : plain
}

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// Shows a spinner with the message while the effect runs, and clears it when
// the effect ends, whether it succeeded, failed or was interrupted.
export function withSpinner<A, E, R>(message: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  if (process.stderr.isTTY !== true) {
    return effect
  }

  const style = errorStyle()

  return Effect.acquireUseRelease(
    Effect.sync(() => {
      let frame = 0

      const draw = () => {
        process.stderr.write(`\r${style.cyan(frames[frame % frames.length] ?? '')} ${message}`)
        frame += 1
      }

      // Hide the cursor, so it doesn't flicker after the spinner.
      process.stderr.write('\u001B[?25l')
      draw()

      return setInterval(draw, 80)
    }),
    () => effect,
    (timer) => {
      return Effect.sync(() => {
        clearInterval(timer)
        process.stderr.write('\r\u001B[2K\u001B[?25h')
      })
    },
  )
}
