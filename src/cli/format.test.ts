import { describe, expect, test } from 'bun:test'
import { formatDuration, formatPagination, formatRecipeDetails, formatSearch } from './format.ts'
import { colored } from './terminal.ts'

describe('formatDuration', () => {
  test('shows minutes, then hours and minutes', () => {
    expect([
      formatDuration({ seconds: 300 }),
      formatDuration({ seconds: 3600 }),
      formatDuration({ seconds: 4500 }),
    ]).toEqual(['5 min', '1 h', '1 h 15 min'])
  })
})

describe('formatPagination', () => {
  test('says where the next page starts, until the last page', () => {
    expect([
      formatPagination({ limit: 20, offset: 0, total: 45 }, 20),
      formatPagination({ limit: 20, offset: 40, total: 45 }, 5),
      formatPagination({ limit: 20, offset: 0, total: 0 }, 0),
      formatPagination({ limit: 20, offset: 60, total: 45 }, 0),
    ]).toEqual([
      'Showing 1-20 of 45. Use --offset 20 to see more.',
      'Showing 41-45 of 45.',
      'No recipes found.',
      'No recipes at offset 60. There are 45 in total.',
    ])
  })
})

describe('formatRecipeDetails', () => {
  test('shows cuisines, a course, the time, servings and rating', () => {
    expect(formatRecipeDetails({
      courses: ['main-course', 'side-dish'],
      cuisines: ['italian', 'french', 'spanish'],
      id: 'carbonara',
      rating: { count: 12, value: 4.25 },
      servings: { original: '2 servings', quantity: 2 },
      times: { cook: { seconds: 900 }, prep: { seconds: 300 } },
    })).toEqual('Italian · French · Main course · 20 min · Serves 2 · ★ 4.3 (12)')
  })

  test('leaves out what the recipe does not have and ratings without votes', () => {
    expect([
      formatRecipeDetails({ id: 'carbonara' }),
      formatRecipeDetails({ id: 'carbonara', rating: { count: 0, value: 0 } }),
    ]).toEqual(['', ''])
  })
})

describe('formatSearch', () => {
  test('colours the numbers and dims the ids when styled', () => {
    expect(formatSearch({ results: [{ id: 'cake', score: 1, title: 'Cake' }] }, colored)).toEqual([
      '\u001B[36m1.\u001B[39m \u001B[1mCake\u001B[22m',
      '   \u001B[2mcake\u001B[22m',
      '',
      '\u001B[2mRun tiny-plates recipe <id> to see a recipe.\u001B[22m',
    ].join('\n'))
  })

  test('suggests other words when nothing matches', () => {
    expect(formatSearch({ results: [] })).toEqual('No recipes found. Try fewer or different words.')
  })
})
