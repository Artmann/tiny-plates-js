import { describe, expect, test } from 'bun:test'
import { encodePantryQuery, encodeRecipeFilters, encodeSearchQuery, encodeShoppingList } from './parameters.ts'

describe('encodeRecipeFilters', () => {
  test('joins lists with commas and turns numbers into strings', () => {
    const query = encodeRecipeFilters({ cuisine: 'italian', excludeIngredients: ['peanut', 'shrimp'], limit: 20, maxTotalMinutes: 30 })

    expect(query).toEqual({ cuisine: 'italian', excludeIngredients: 'peanut,shrimp', limit: '20', maxTotalMinutes: '30' })
  })

  test('leaves out filters that are not set', () => {
    expect(encodeRecipeFilters({ cuisine: undefined })).toEqual({})
    expect(encodeRecipeFilters()).toEqual({})
  })
})

describe('encodePantryQuery', () => {
  test('encodes the pantry and its options', () => {
    const query = encodePantryQuery({ ingredients: ['egg', 'tomato'], maxMissing: 2, staples: false })

    expect(query).toEqual({ ingredients: 'egg,tomato', maxMissing: '2', staples: 'false' })
  })
})

describe('encodeSearchQuery', () => {
  test('keeps the query as it is', () => {
    const query = encodeSearchQuery({ fields: ['title', 'ingredients'], query: 'pasta, quick' })

    expect(query).toEqual({ fields: 'title,ingredients', query: 'pasta, quick' })
  })
})

describe('encodeShoppingList', () => {
  test('pairs each recipe with its servings', () => {
    const query = encodeShoppingList([{ id: 'carbonara', servings: 4 }, { id: 'tiramisu' }])

    expect(query).toEqual({ recipes: 'carbonara:4,tiramisu' })
  })
})
