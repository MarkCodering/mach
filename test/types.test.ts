/**
 * Type-level tests: these assertions are checked by `bun run typecheck` (tsc), and the file
 * also runs under `bun test` so it is never silently skipped.
 */
import { expect, test } from 'bun:test'
import { tool } from '../src/ai/index.ts'
import { Mach, s, type Infer, type ParamsOf } from '../src/index.ts'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
function assertType<T extends true>(_?: T) {}

test('path params are inferred from the route pattern', () => {
  assertType<Equal<ParamsOf<'/users/:id'>, { id: string }>>()
  assertType<Equal<ParamsOf<'/orgs/:org/repos/:repo'>, { org: string; repo: string }>>()
  assertType<Equal<ParamsOf<'/docs/:page?'>, { page?: string }>>()
  assertType<Equal<ParamsOf<'/files/*'>, { '*': string }>>()
  assertType<Equal<ParamsOf<'/static'>, {}>>()

  new Mach().get('/users/:id/posts/:postId', (c) => {
    const id: string = c.params.id
    const postId: string = c.params.postId
    // @ts-expect-error unknown param
    c.params.nope
    return { id, postId }
  })
  expect(true).toBe(true)
})

test('schema output types', () => {
  const S = s.object({
    a: s.string(),
    b: s.number().optional(),
    c: s.enum(['x', 'y']).default('x'),
    d: s.array(s.object({ e: s.boolean() })),
    f: s.string().nullable(),
    g: s.union([s.literal(1), s.literal('one')]),
  })
  assertType<
    Equal<
      Infer<typeof S>,
      { a: string; c: 'x' | 'y'; d: { e: boolean }[]; f: string | null; g: 1 | 'one'; b?: number }
    >
  >()
  expect(true).toBe(true)
})

test('route validation feeds typed c.input', () => {
  new Mach().post(
    '/items',
    { body: s.object({ name: s.string(), qty: s.integer() }), query: s.object({ dry: s.coerce.boolean().optional() }) },
    (c) => {
      assertType<Equal<typeof c.input.body, { name: string; qty: number }>>()
      assertType<Equal<typeof c.input.query, { dry?: boolean }>>()
      // @ts-expect-error params were not declared
      c.input.params
      return c.input.body
    },
  )
  expect(true).toBe(true)
})

test('typed variables', () => {
  new Mach<{ Variables: { user: { id: string } } }>().get('/', (c) => {
    assertType<Equal<ReturnType<typeof c.get<'user'>>, { id: string }>>()
    // @ts-expect-error unknown variable
    c.get('nope')
    return c.var.user.id
  })
  expect(true).toBe(true)
})

test('tool run input is typed from its schema', async () => {
  const t = tool({
    name: 't',
    description: 'd',
    input: s.object({ city: s.string() }),
    run: ({ city }) => {
      assertType<Equal<typeof city, string>>()
      return { len: city.length }
    },
  })
  const out = await t.run({ city: 'x' })
  assertType<Equal<typeof out, { len: number }>>()
  // @ts-expect-error wrong input type
  await t.run({ city: 1 }).catch(() => {})
  expect(out.len).toBe(1)
})
