/**
 * Full request benchmark: `app.fetch(Request) → Response`, in-process (no sockets).
 * Measures framework overhead: routing, context, middleware and response building.
 *   bun bench/request.bench.ts
 */
import { Hono } from 'hono'
import { bench, group, run, summary } from 'mitata'
import { Mach } from 'machjs'
import { requests, routes } from './routes.ts'

function buildMach(withMiddleware: boolean) {
  const app = new Mach()
  if (withMiddleware) {
    app.use(async (c, next) => {
      await next()
      c.header('x-powered-by', 'mach')
    })
  }
  for (const [method, path] of routes) app.on(method, path, (c) => c.text('hello'))
  app.get('/json/:id', (c) => c.json({ id: c.params.id, ok: true }))
  return app
}

function buildHono(withMiddleware: boolean) {
  const app = new Hono()
  if (withMiddleware) {
    app.use(async (c, next) => {
      await next()
      c.header('x-powered-by', 'hono')
    })
  }
  for (const [method, path] of routes) app.on(method, path, (c) => c.text('hello'))
  app.get('/json/:id', (c) => c.json({ id: c.req.param('id'), ok: true }))
  return app
}

const reqs = requests.map((r) => new Request(`http://localhost${r.path}`, { method: r.method }))
const jsonReq = new Request('http://localhost/json/42')

const machPlain = buildMach(false)
const honoPlain = buildHono(false)
const machMw = buildMach(true)
const honoMw = buildHono(true)

// Sanity check.
for (const app of [machPlain, honoPlain, machMw, honoMw]) {
  for (const req of reqs) {
    const res = await app.fetch(req)
    if (res.status !== 200) throw new Error(`unexpected ${res.status} for ${req.url}`)
  }
}

summary(() => {
  group('fetch: all routes, text response', () => {
    bench('mach', async () => {
      for (const req of reqs) await machPlain.fetch(req)
    })
    bench('hono', async () => {
      for (const req of reqs) await honoPlain.fetch(req)
    })
  })
})

summary(() => {
  group('fetch: all routes + 1 middleware', () => {
    bench('mach', async () => {
      for (const req of reqs) await machMw.fetch(req)
    })
    bench('hono', async () => {
      for (const req of reqs) await honoMw.fetch(req)
    })
  })
})

summary(() => {
  group('fetch: JSON with param', () => {
    bench('mach', async () => await machPlain.fetch(jsonReq))
    bench('hono', async () => await honoPlain.fetch(jsonReq))
  })
})

await run()
