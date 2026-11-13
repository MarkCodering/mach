import { describe, expect, test } from 'bun:test'
import { tool } from '../src/ai/index.ts'
import { Mach, s } from '../src/index.ts'
import { mcpServer } from '../src/mcp/server.ts'

const add = tool({
  name: 'add',
  description: 'Add two numbers',
  input: s.object({ a: s.number(), b: s.number() }),
  run: ({ a, b }) => ({ sum: a + b }),
})
const greet = tool({
  name: 'greet',
  description: 'Greet the caller',
  input: s.object({}),
  run: (_i, ctx) => `hello ${(ctx.context as { user: string }).user}`,
})

function makeApp(opts: Partial<Parameters<typeof mcpServer>[0]> = {}) {
  return new Mach().mcp(
    '/mcp',
    mcpServer({
      name: 'test-server',
      version: '1.2.3',
      instructions: 'Use add for arithmetic.',
      tools: [add, greet],
      context: (c) => ({ user: c.req.headers.get('x-user') ?? 'anon' }),
      ...opts,
    }),
  )
}

const rpc = (app: Mach, body: unknown, headers: Record<string, string> = {}) =>
  app.request('/mcp', { json: body, headers: { accept: 'application/json, text/event-stream', ...headers } })

describe('MCP server', () => {
  test('initialize negotiates protocol versions', async () => {
    const app = makeApp()
    let r = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } })
    expect(await r.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'test-server', version: '1.2.3' },
        instructions: 'Use add for arithmetic.',
      },
    })
    r = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
    expect((await r.json()).result.protocolVersion).toBe('2025-11-25')
  })

  test('notifications get 202 with no body', async () => {
    const r = await rpc(makeApp(), { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(r.status).toBe(202)
    expect(await r.text()).toBe('')
  })

  test('tools/list and tools/call', async () => {
    const app = makeApp()
    const list = await (await rpc(app, { jsonrpc: '2.0', id: 'a', method: 'tools/list' })).json()
    expect(list.result.tools).toEqual([
      { name: 'add', description: 'Add two numbers', inputSchema: add.spec.inputSchema },
      { name: 'greet', description: 'Greet the caller', inputSchema: greet.spec.inputSchema },
    ])

    const call = await (await rpc(app, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'add', arguments: { a: 2, b: 3 } } })).json()
    expect(call.result).toEqual({ content: [{ type: 'text', text: '{"sum":5}' }], structuredContent: { sum: 5 }, isError: false })

    const ctx = await (await rpc(app, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'greet' } }, { 'x-user': 'ada' })).json()
    expect(ctx.result.content[0].text).toBe('hello ada')

    const invalid = await (await rpc(app, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'add', arguments: { a: 'x' } } })).json()
    expect(invalid.result.isError).toBe(true)
    expect(invalid.result.content[0].text).toContain('Invalid input')

    const unknown = await (await rpc(app, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } })).json()
    expect(unknown.error.code).toBe(-32602)
  })

  test('errors: unknown method, parse error, invalid request, batches', async () => {
    const app = makeApp()
    expect((await (await rpc(app, { jsonrpc: '2.0', id: 1, method: 'resources/list' })).json()).error.code).toBe(-32601)
    expect((await (await rpc(app, { id: 1, method: 'x' })).json()).error.code).toBe(-32600)
    const parse = await app.request('/mcp', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } })
    expect(parse.status).toBe(400)
    expect((await parse.json()).error.code).toBe(-32700)
    const batch = await (await rpc(app, [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }])).json()
    expect(batch).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }])
  })

  test('origin validation (DNS rebinding protection) and GET', async () => {
    const app = makeApp()
    const evil = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' })
    expect(evil.status).toBe(403)
    const same = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'http://localhost' })
    expect(same.status).toBe(200)
    const allowed = makeApp({ allowedOrigins: ['https://ok.example'] })
    expect((await rpc(allowed, { jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://ok.example' })).status).toBe(200)
    expect((await app.request('/mcp')).status).toBe(405)
  })
})
