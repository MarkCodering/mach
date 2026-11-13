import { describe, expect, test } from 'bun:test'
import { HTTPException, Mach, s } from '../src/index.ts'

describe('Mach app', () => {
  test('return values become responses', async () => {
    const app = new Mach()
      .get('/text', () => 'hello')
      .get('/json', () => ({ ok: true }))
      .get('/num', () => 42)
      .get('/null', () => null)
      .get('/res', () => new Response('raw', { status: 201 }))
      .get('/bytes', () => new TextEncoder().encode('bin'))
      .get('/async', async () => ({ later: true }))

    let r = await app.request('/text')
    // Bun sets the implied text/plain header lazily (on the wire); node.test.ts checks the wire value.
    expect(r.headers.get('content-type') ?? 'text/plain;charset=utf-8').toMatch(/^text\/plain; ?charset=utf-8$/i)
    expect(await r.text()).toBe('hello')
    r = await app.request('/json')
    expect(await r.json()).toEqual({ ok: true })
    expect(await (await app.request('/num')).json()).toBe(42)
    expect((await app.request('/null')).status).toBe(204)
    r = await app.request('/res')
    expect(r.status).toBe(201)
    r = await app.request('/bytes')
    expect(r.headers.get('content-type')).toBe('application/octet-stream')
    expect(await (await app.request('/async')).json()).toEqual({ later: true })
  })

  test('params and query', async () => {
    const app = new Mach().get('/users/:id', (c) => ({ id: c.params.id, q: c.query('q'), all: c.query() }))
    const r = await app.request('/users/7?q=hi&x=1')
    expect(await r.json()).toEqual({ id: '7', q: 'hi', all: { q: 'hi', x: '1' } })
  })

  test('status and headers helpers', async () => {
    const app = new Mach().get('/', (c) => {
      c.status(202).header('x-a', '1')
      return { accepted: true }
    })
    const r = await app.request('/')
    expect(r.status).toBe(202)
    expect(r.headers.get('x-a')).toBe('1')
    expect(r.headers.get('content-type')).toBe('application/json')
  })

  test('middleware order, scoping and post-processing', async () => {
    const order: string[] = []
    const app = new Mach()
    app.use(async (_c, next) => {
      order.push('a:before')
      await next()
      order.push('a:after')
    })
    app.use('/api/*', async (c, next) => {
      order.push('api')
      await next()
      c.header('x-api', 'yes')
    })
    app.get('/api/x', () => {
      order.push('handler')
      return 'ok'
    })
    app.get('/other', () => 'other')

    const r = await app.request('/api/x')
    expect(order).toEqual(['a:before', 'api', 'handler', 'a:after'])
    expect(r.headers.get('x-api')).toBe('yes')
    const r2 = await app.request('/other')
    expect(r2.headers.get('x-api')).toBeNull()
  })

  test('middleware can short-circuit', async () => {
    const app = new Mach()
    app.use((c) => {
      if (!c.req.headers.get('authorization')) return c.json({ error: 'nope' }, 401)
    })
    app.get('/', () => 'secret')
    expect((await app.request('/')).status).toBe(401)
    expect(await (await app.request('/', { headers: { authorization: 'x' } })).text()).toBe('secret')
  })

  test('typed variables', async () => {
    const app = new Mach<{ Variables: { user: { id: string } } }>()
    app.use(async (c, next) => {
      c.set('user', { id: 'u1' })
      await next()
    })
    app.get('/me', (c) => ({ id: c.get('user').id, viaVar: c.var.user.id }))
    expect(await (await app.request('/me')).json()).toEqual({ id: 'u1', viaVar: 'u1' })
  })

  test('validation of body, query, params', async () => {
    const app = new Mach()
    app.post(
      '/items/:id',
      {
        params: s.object({ id: s.coerce.integer() }),
        query: s.object({ dryRun: s.coerce.boolean().optional() }),
        body: s.object({ name: s.string({ min: 1 }), tags: s.array(s.string()).default([]) }),
      },
      (c) => ({ id: c.input.params.id, dryRun: c.input.query.dryRun ?? false, ...c.input.body }),
    )
    let r = await app.request('/items/5?dryRun=true', { json: { name: 'x' } })
    expect(await r.json()).toEqual({ id: 5, dryRun: true, name: 'x', tags: [] })

    r = await app.request('/items/abc', { json: { name: 'x' } })
    expect(r.status).toBe(400)
    expect((await r.json()).target).toBe('params')

    r = await app.request('/items/1', { json: { name: '' } })
    const err = await r.json()
    expect(r.status).toBe(400)
    expect(err.issues[0]).toEqual({ message: 'Must be at least 1 character', path: 'name' })

    r = await app.request('/items/1', { method: 'POST', body: '{bad', headers: { 'content-type': 'application/json' } })
    expect(r.status).toBe(400)
    expect((await r.json()).error).toBe('Malformed JSON body')
  })

  test('form bodies validate too', async () => {
    const app = new Mach().post('/f', { body: s.object({ a: s.string() }) }, (c) => c.input.body)
    const r = await app.request('/f', { method: 'POST', body: new URLSearchParams({ a: '1' }) })
    expect(await r.json()).toEqual({ a: '1' })
  })

  test('errors: HTTPException, unknown errors, custom handler, middleware still runs', async () => {
    const app = new Mach()
    app.use(async (c, next) => {
      await next()
      c.header('x-cors', '1')
    })
    app.get('/teapot', () => {
      throw new HTTPException(418, 'I am a teapot')
    })
    app.get('/boom', () => {
      throw new Error('secret internals')
    })
    const origError = console.error
    console.error = () => {}
    try {
      let r = await app.request('/teapot')
      expect(r.status).toBe(418)
      expect(r.headers.get('x-cors')).toBe('1')
      expect(await r.json()).toEqual({ error: 'I am a teapot' })
      r = await app.request('/boom')
      expect(r.status).toBe(500)
      expect(await r.text()).not.toContain('secret internals')

      app.onError((err, c) => c.json({ custom: (err as Error).message }, 503))
      r = await app.request('/boom')
      expect(r.status).toBe(503)
      expect(await r.json()).toEqual({ custom: 'secret internals' })
    } finally {
      console.error = origError
    }
  })

  test('404, 405 and custom notFound; middleware runs on misses', async () => {
    const app = new Mach()
    app.use(async (c, next) => {
      await next()
      c.header('x-seen', '1')
    })
    app.get('/only-get', () => 'x')
    let r = await app.request('/missing')
    expect(r.status).toBe(404)
    expect(r.headers.get('x-seen')).toBe('1')
    r = await app.request('/only-get', { method: 'DELETE' })
    expect(r.status).toBe(405)
    expect(r.headers.get('allow')).toBe('GET')
    app.notFound((c) => c.text('custom 404', 404))
    expect(await (await app.request('/missing')).text()).toBe('custom 404')
  })

  test('HEAD falls back to GET without a body', async () => {
    const app = new Mach().get('/', () => 'body')
    const r = await app.request('/', { method: 'HEAD' })
    expect(r.status).toBe(200)
    expect(await r.text()).toBe('')
  })

  test('all() and on() with multiple methods', async () => {
    const app = new Mach().all('/any', (c) => c.req.method).on(['PUT', 'PATCH'], '/up', () => 'up')
    expect(await (await app.request('/any', { method: 'PATCH' })).text()).toBe('PATCH')
    expect(await (await app.request('/up', { method: 'PUT' })).text()).toBe('up')
  })

  test('sub-app mounting with scoped middleware', async () => {
    const api = new Mach()
    api.use(async (c, next) => {
      await next()
      c.header('x-api', '1')
    })
    api.get('/', () => 'api root')
    api.get('/users/:id', (c) => c.params.id)
    const app = new Mach().get('/', () => 'home').route('/api/v1', api)

    expect(await (await app.request('/api/v1')).text()).toBe('api root')
    const r = await app.request('/api/v1/users/3')
    expect(await r.text()).toBe('3')
    expect(r.headers.get('x-api')).toBe('1')
    expect((await app.request('/')).headers.get('x-api')).toBeNull()
    expect(app.routes.map((x) => `${x.method} ${x.path}`)).toEqual(['GET /', 'GET /api/v1', 'GET /api/v1/users/:id'])
  })

  test('async iterables stream as SSE', async () => {
    const app = new Mach().get('/events', async function* () {
      yield { type: 'greeting', text: 'hi' }
      yield 'plain'
    })
    const r = await app.request('/events')
    expect(r.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(r.headers.get('cache-control')).toBe('no-cache, no-transform')
    expect(await r.text()).toBe('event: greeting\ndata: {"type":"greeting","text":"hi"}\n\ndata: plain\n\n')
  })

  test('c.sse writer and c.stream', async () => {
    const app = new Mach()
      .get('/sse', (c) =>
        c.sse(async (s) => {
          await s.write({ type: 'n', n: 1 })
          await s.comment('note')
          await s.write({ type: 'n', n: 2 })
        }),
      )
      .get('/raw', (c) =>
        c.stream(async (s) => {
          await s.write('a')
          await s.write(new TextEncoder().encode('b'))
        }),
      )
    expect(await (await app.request('/sse')).text()).toBe(
      'event: n\ndata: {"type":"n","n":1}\n\n: note\n\nevent: n\ndata: {"type":"n","n":2}\n\n',
    )
    expect(await (await app.request('/raw')).text()).toBe('ab')
  })

  test('handler returning nothing is a clear 500', async () => {
    const app = new Mach().get('/', () => undefined)
    const logs: unknown[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => logs.push(a.join(' '))
    try {
      expect((await app.request('/')).status).toBe(500)
      expect(String(logs[0])).toContain('GET / returned nothing')
    } finally {
      console.error = orig
    }
  })

  test('next() called twice is an error', async () => {
    const app = new Mach()
    app.use(async (_c, next) => {
      await next()
      await next()
    })
    app.get('/', () => 'x')
    const orig = console.error
    console.error = () => {}
    try {
      expect((await app.request('/')).status).toBe(500)
    } finally {
      console.error = orig
    }
  })

  test('route registration errors are descriptive', () => {
    const app = new Mach()
    expect(() => app.get('/x' as string)).toThrow(/No handler/)
  })

  test('fetch passes env bindings', async () => {
    const app = new Mach<{ Bindings: { SECRET: string } }>().get('/', (c) => c.env.SECRET)
    const r = await app.fetch(new Request('http://localhost/'), { SECRET: 's3' })
    expect(await r.text()).toBe('s3')
  })
})
