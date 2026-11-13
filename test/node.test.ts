import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Server } from 'node:http'
import { serve } from '../src/adapters/node.ts'
import { agent } from '../src/ai/index.ts'
import { mockModel } from '../src/ai/providers/mock.ts'
import { chat } from '../src/client.ts'
import { Mach, s } from '../src/index.ts'

let server: Server
let base = ''
let aborted = false

beforeAll(async () => {
  const app = new Mach()
    .get('/', () => 'hello node')
    .post('/echo', { body: s.object({ msg: s.string() }) }, (c) => c.input.body)
    .get('/cookies', (c) => {
      c.header('set-cookie', 'a=1', { append: true })
      c.header('set-cookie', 'b=2', { append: true })
      return 'ok'
    })
    .get('/slow', (c) =>
      c.sse(async (stream) => {
        stream.signal.addEventListener('abort', () => (aborted = true))
        for (let i = 0; i < 1000 && !stream.signal.aborted; i++) {
          await stream.write({ type: 'tick', i })
          await new Promise((r) => setTimeout(r, 5))
        }
      }),
    )
    .agent('/chat', agent({ model: mockModel(['Hi from the agent']) }))

  await new Promise<void>((resolve) => {
    server = serve(app, {
      port: 0,
      hostname: '127.0.0.1',
      onListen: ({ url }) => {
        base = url
        resolve()
      },
    })
  })
})

afterAll(() => server.close())

describe('node adapter', () => {
  test('basic GET and JSON POST', async () => {
    const home = await fetch(`${base}/`)
    expect(home.headers.get('content-type')).toMatch(/^text\/plain; ?charset=utf-8$/i)
    expect(await home.text()).toBe('hello node')
    const r = await fetch(`${base}/echo`, { method: 'POST', body: JSON.stringify({ msg: 'yo' }), headers: { 'content-type': 'application/json' } })
    expect(await r.json()).toEqual({ msg: 'yo' })
  })

  test('multiple set-cookie headers survive', async () => {
    const r = await fetch(`${base}/cookies`)
    expect(r.headers.getSetCookie()).toEqual(['a=1', 'b=2'])
  })

  test('client disconnect aborts the stream', async () => {
    const ac = new AbortController()
    const r = await fetch(`${base}/slow`, { signal: ac.signal })
    const reader = r.body!.getReader()
    await reader.read()
    ac.abort()
    await new Promise((res) => setTimeout(res, 100))
    expect(aborted).toBe(true)
  })

  test('agent endpoint works end-to-end with the client helper', async () => {
    const deltas: string[] = []
    const result = await chat(`${base}/chat`, { messages: [{ role: 'user', content: 'hey' }], onText: (d) => deltas.push(d) })
    expect(result.text).toBe('Hi from the agent')
    expect(deltas.join('')).toBe('Hi from the agent')
    expect(result.messages.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Hi from the agent' }] })
  })
})
