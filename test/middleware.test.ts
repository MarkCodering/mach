import { describe, expect, test } from 'bun:test'
import { Mach } from '../src/index.ts'
import { bodyLimit, cors, logger, requestId, timing } from '../src/middleware/index.ts'

describe('cors', () => {
  test('preflight for unmatched routes and decorated responses', async () => {
    const app = new Mach().use(cors({ origin: ['https://app.example'], maxAge: 600 })).post('/chat', () => 'ok')
    const pre = await app.request('/chat', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://app.example')
    expect(pre.headers.get('access-control-allow-headers')).toBe('content-type')
    expect(pre.headers.get('access-control-max-age')).toBe('600')

    const r = await app.request('/chat', { method: 'POST', headers: { origin: 'https://app.example' } })
    expect(r.headers.get('access-control-allow-origin')).toBe('https://app.example')
    expect(r.headers.get('vary')).toContain('Origin')

    const denied = await app.request('/chat', { method: 'POST', headers: { origin: 'https://evil.example' } })
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  })

  test('errors still carry CORS headers', async () => {
    const app = new Mach().use(cors()).get('/x', () => {
      throw new Error('x')
    })
    const orig = console.error
    console.error = () => {}
    try {
      const r = await app.request('/x', { headers: { origin: 'https://a.b' } })
      expect(r.status).toBe(500)
      expect(r.headers.get('access-control-allow-origin')).toBe('*')
    } finally {
      console.error = orig
    }
  })

  test('credentials with wildcard is rejected at setup', () => {
    expect(() => cors({ credentials: true })).toThrow(/credentials/)
  })
})

describe('logger, requestId, timing', () => {
  test('work together', async () => {
    const lines: string[] = []
    const app = new Mach()
      .use(logger({ log: (l) => lines.push(l) }))
      .use(requestId())
      .use(timing())
      .get('/', (c) => c.get('requestId'))
    const r = await app.request('/')
    const id = await r.text()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.headers.get('x-request-id')).toBe(id)
    expect(r.headers.get('server-timing')).toMatch(/^total;dur=/)
    expect(lines[0]).toMatch(/^GET \/ 200 \d+\.\dms$/)
  })

  test('requestId sanitises incoming ids', async () => {
    const app = new Mach().use(requestId()).get('/', (c) => c.get('requestId'))
    expect(await (await app.request('/', { headers: { 'x-request-id': 'abc-123' } })).text()).toBe('abc-123')
    expect(await (await app.request('/', { headers: { 'x-request-id': '<script>' } })).text()).not.toBe('<script>')
  })
})

describe('bodyLimit', () => {
  test('rejects by content-length and by streamed size', async () => {
    const app = new Mach().use(bodyLimit(10)).post('/', async (c) => (await c.req.text()).length)
    expect((await app.request('/', { method: 'POST', body: 'x'.repeat(11) })).status).toBe(413)
    expect(await (await app.request('/', { method: 'POST', body: 'x'.repeat(5) })).json()).toBe(5)

    const chunked = (n: number) =>
      new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < n; i++) c.enqueue(new Uint8Array(4))
          c.close()
        },
      })
    const big = new Request('http://localhost/', { method: 'POST', body: chunked(5), duplex: 'half' } as RequestInit)
    expect((await app.fetch(big)).status).toBe(413)
    const small = new Request('http://localhost/', { method: 'POST', body: chunked(2), duplex: 'half' } as RequestInit)
    expect(await (await app.fetch(small)).json()).toBe(8)
  })
})
