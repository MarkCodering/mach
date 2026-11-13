/**
 * The basics: routing, params, validation, middleware, errors and streaming.
 *
 *   bun examples/basic/index.ts
 */
import { HTTPException, Mach, s } from 'machjs'
import { cors, logger, requestId } from 'machjs/middleware'

const app = new Mach<{ Variables: { requestId: string } }>()

app.use(logger(), requestId(), cors())

// Return anything: strings → text, objects → JSON, Responses as-is.
app.get('/', () => 'Mach is running')

// Params are typed from the path.
app.get('/users/:id', (c) => ({ id: c.params.id, requestId: c.get('requestId') }))

// Validation with typed `c.input`.
app.post(
  '/todos',
  {
    body: s.object({
      title: s.string({ min: 1, max: 200 }),
      done: s.boolean().default(false),
    }),
  },
  (c) => {
    const todo = { id: crypto.randomUUID(), ...c.input.body }
    return c.json(todo, 201)
  },
)

// Errors become proper HTTP responses (and still pass through CORS/logging).
app.get('/admin', (c) => {
  if (c.req.headers.get('authorization') !== 'Bearer secret') throw new HTTPException(401, 'Unauthorized')
  return { ok: true }
})

// Return an async generator → Server-Sent Events.
app.get('/clock', async function* () {
  for (let i = 0; i < 5; i++) {
    yield { type: 'tick', time: new Date().toISOString() }
    await new Promise((r) => setTimeout(r, 1000))
  }
})

// Sub-apps.
const v1 = new Mach().get('/health', () => ({ status: 'ok' }))
app.route('/api/v1', v1)

export default { port: Number(process.env.PORT ?? 3000), fetch: app.fetch }
console.log(`Mach basic example on http://localhost:${process.env.PORT ?? 3000}`)
