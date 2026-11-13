import { describe, expect, test } from 'bun:test'
import { s, toJSONSchema, validate } from '../src/schema/index.ts'

describe('s schema builder', () => {
  const User = s.object({
    name: s.string({ min: 1 }).describe('Full name'),
    age: s.integer({ min: 0 }).optional(),
    role: s.enum(['admin', 'user']).default('user'),
    tags: s.array(s.string(), { max: 3 }),
    email: s.string({ format: 'email' }).nullable(),
  })

  test('parses valid input, applies defaults, strips unknown keys', () => {
    expect(User.parse({ name: 'Ada', tags: [], email: null, extra: 1 })).toEqual({
      name: 'Ada',
      role: 'user',
      tags: [],
      email: null,
    })
  })

  test('reports issues with paths', () => {
    const r = User.safeParse({ name: '', age: 1.5, tags: ['a', 'b', 'c', 'd'], email: 'nope' })
    expect(r.issues?.map((i) => [i.path?.join('.'), i.message])).toEqual([
      ['name', 'Must be at least 1 character'],
      ['age', 'Expected integer'],
      ['tags', 'Must contain at most 3 items'],
      ['email', 'Must be a valid email'],
    ])
    const missing = User.safeParse({})
    expect(missing.issues?.[0]).toEqual({ message: 'Required', path: ['name'] })
  })

  test('nested array item paths', () => {
    const r = s.object({ items: s.array(s.object({ n: s.number() })) }).safeParse({ items: [{ n: 1 }, { n: 'x' }] })
    expect(r.issues?.[0]?.path).toEqual(['items', 1, 'n'])
  })

  test('emits JSON Schema', () => {
    expect(User.toJSONSchema()).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: 'Full name' },
        age: { type: 'integer', minimum: 0 },
        role: { type: 'string', enum: ['admin', 'user'], default: 'user' },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 3 },
        email: { type: ['string', 'null'], format: 'email' },
      },
      required: ['name', 'tags', 'email'],
      additionalProperties: false,
    })
  })

  test('implements Standard Schema', async () => {
    expect(User['~standard'].version).toBe(1)
    expect(User['~standard'].vendor).toBe('mach')
    const r = await validate(User, { name: 'x', tags: [], email: null })
    expect(r.issues).toBeUndefined()
    expect(toJSONSchema(User)).toEqual(User.toJSONSchema())
  })

  test('union, literal, record, coerce, passthrough', () => {
    const U = s.union([s.literal('a'), s.number()])
    expect(U.parse('a')).toBe('a')
    expect(U.parse(3)).toBe(3)
    expect(U.safeParse(true).issues?.[0]?.message).toBe('Did not match any allowed type')
    expect(s.record(s.number()).parse({ a: 1 })).toEqual({ a: 1 })
    expect(s.coerce.number().parse('3.5')).toBe(3.5)
    expect(s.coerce.boolean().parse('false')).toBe(false)
    expect(s.object({ a: s.number() }).passthrough().parse({ a: 1, b: 2 }) as unknown).toEqual({ a: 1, b: 2 })
  })

  test('modifiers return new schemas (immutable)', () => {
    const base = s.string()
    const opt = base.optional()
    expect(base.safeParse(undefined).issues).toBeDefined()
    expect(opt.safeParse(undefined).issues).toBeUndefined()
  })

  test('defaults are cloned', () => {
    const S = s.object({ list: s.array(s.number()).default([]) })
    const a = S.parse({})
    a.list.push(1)
    expect(S.parse({}).list).toEqual([])
  })
})
