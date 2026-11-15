import { describe, expect, test } from 'bun:test'
import { agent, tool } from '../src/ai/index.ts'
import { lastToolOutput, mockModel } from '../src/ai/providers/mock.ts'
import { Mach, s } from '../src/index.ts'
import { MCPError, mcpClient, mcpServer } from '../src/mcp/index.ts'

const safeAdd = tool({
  name: 'add',
  description: 'Add two numbers',
  input: s.object({ a: s.number(), b: s.number() }),
  run: ({ a, b }) => ({ sum: a + b }),
})
const fail = tool({
  name: 'explode',
  description: 'Always fails',
  input: s.object({}),
  run: () => {
    throw new Error('kaboom')
  },
})

/** Route fetch calls straight into an in-process Mach app (no sockets). */
function appFetch(app: Mach): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(app.fetch(new Request(url, init)))) as typeof fetch
}

describe('mcpClient against mcpServer', () => {
  const server = new Mach().mcp('/mcp', mcpServer({ name: 'calc', version: '2.0.0', instructions: 'Math tools', tools: [safeAdd, fail] }))
  const client = mcpClient({ url: 'http://localhost/mcp', fetch: appFetch(server) })

  test('handshake, listTools, callTool', async () => {
    const info = await client.connect()
    expect(info.serverInfo).toEqual({ name: 'calc', version: '2.0.0' })
    expect(info.instructions).toBe('Math tools')
    const list = await client.listTools()
    expect(list.map((t) => t.name)).toEqual(['add', 'explode'])
    expect(await client.callTool('add', { a: 2, b: 3 })).toEqual({
      content: [{ type: 'text', text: '{"sum":5}' }],
      structuredContent: { sum: 5 },
      isError: false,
    })
    await expect(client.callTool('nope')).rejects.toBeInstanceOf(MCPError)
  })

  test('remote tools work inside an agent', async () => {
    const tools = await client.tools({ prefix: 'calc_' })
    expect(tools.map((t) => t.name)).toEqual(['calc_add', 'calc_explode'])
    expect(tools[0]!.spec.inputSchema).toMatchObject({ type: 'object', required: ['a', 'b'] })

    const model = mockModel([
      { toolCalls: [{ name: 'calc_add', input: { a: 40, b: 2 } }, { name: 'calc_explode', input: {} }] },
      (req) => `The answer is ${(lastToolOutput(req) as unknown as string) ?? ''}`,
    ])
    const result = await agent({ model, tools }).run('What is 40 + 2?')
    const toolMsg = result.messages[1] as { content: { output: unknown; isError?: boolean }[] }
    expect(toolMsg.content[0]).toMatchObject({ output: { sum: 42 }, isError: false })
    expect(toolMsg.content[1]).toMatchObject({ output: 'Error: kaboom', isError: true })
  })
})

describe('mcpClient protocol details', () => {
  test('SSE responses, session ids, notifications, pagination, name sanitising, close', async () => {
    const seen: { method: string; session: string | null; version: string | null }[] = []
    const sse = (frames: unknown[]) =>
      new Response(frames.map((f) => `event: message\ndata: ${JSON.stringify(f)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      })
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      if (init?.method === 'DELETE') {
        seen.push({ method: 'DELETE', session: headers.get('mcp-session-id'), version: null })
        return new Response(null, { status: 200 })
      }
      const msg = JSON.parse(String(init?.body))
      seen.push({ method: msg.method, session: headers.get('mcp-session-id'), version: headers.get('mcp-protocol-version') })
      switch (msg.method) {
        case 'initialize':
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } }),
            { headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-123' } },
          )
        case 'notifications/initialized':
          return new Response(null, { status: 202 })
        case 'tools/list':
          return msg.params?.cursor
            ? sse([{ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'repo.search', inputSchema: { type: 'object' } }] } }])
            : sse([
                { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hi' } },
                { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'repo.search', description: 'Search', inputSchema: { type: 'object' } }], nextCursor: 'p2' } },
              ])
        default:
          return sse([{ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } }])
      }
    }) as typeof fetch

    const client = mcpClient({ url: 'http://x/mcp', fetch: fakeFetch, headers: { authorization: 'Bearer t' } })
    const tools = await client.tools()
    expect(tools.map((t) => t.name)).toEqual(['repo_search', 'repo_search_2'])
    expect(seen.map((s) => s.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list'])
    expect(seen[0]).toEqual({ method: 'initialize', session: null, version: null })
    expect(seen[2]).toEqual({ method: 'tools/list', session: 'sess-123', version: '2025-06-18' })
    await expect(client.callTool('x')).rejects.toThrow('nope')
    await client.close()
    expect(seen.at(-1)).toEqual({ method: 'DELETE', session: 'sess-123', version: null })
  })

  test('failed connect can be retried', async () => {
    let calls = 0
    const flaky = (async (_u: string | URL | Request, init?: RequestInit) => {
      const msg = JSON.parse(String(init?.body))
      if (msg.method === 'initialize' && calls++ === 0) return new Response('down', { status: 503 })
      if (msg.method === 'initialize') {
        return Response.json({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'f', version: '1' } } })
      }
      return new Response(null, { status: 202 })
    }) as typeof fetch
    const client = mcpClient({ url: 'http://x/mcp', fetch: flaky })
    await expect(client.connect()).rejects.toThrow(/503/)
    expect((await client.connect()).serverInfo.name).toBe('f')
  })
})

