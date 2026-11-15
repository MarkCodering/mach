import { describe, expect, test } from 'bun:test'
import { agent } from '../src/ai/index.ts'
import { mockModel } from '../src/ai/providers/mock.ts'
import { Mach, s } from '../src/index.ts'
import { mcpServer } from '../src/mcp/server.ts'
import { openapi } from '../src/openapi.ts'

const Todo = s.object({ id: s.string(), title: s.string(), done: s.boolean() })

function buildApp() {
  const app = new Mach()
  app.get('/todos', { query: s.object({ limit: s.coerce.integer({ max: 100 }).optional().describe('Max items'), q: s.string() }), response: s.array(Todo), docs: { summary: 'List todos', tags: ['todos'] } }, () => [])
  app.post('/todos', { body: s.object({ title: s.string() }), response: Todo, docs: { tags: ['todos'], responses: { '201': { description: 'Created', schema: Todo } } } }, () => null)
  app.get('/todos/:id', { params: s.object({ id: s.string({ format: 'uuid' }) }) }, () => null)
  app.get('/docs/:page?', () => 'docs')
  app.get('/files/*', () => 'file')
  app.get('/internal', { docs: { hidden: true } }, () => 'secret')
  app.get('/users/:id', () => 'u')
  app.delete('/users/:id', () => 'deleted')
  app.agent('/chat', agent({ model: mockModel() }))
  app.mcp('/mcp', mcpServer({ name: 'x', version: '1', tools: [] }))
  app.route('/v1', new Mach().get('/health', { docs: { summary: 'Health' } }, () => 'ok'))
  return app
}

describe('openapi()', () => {
  const doc = openapi(buildApp(), { info: { title: 'Todo API', version: '1.0.0' }, servers: [{ url: 'https://api.example' }] })

  test('top level', () => {
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.info).toEqual({ title: 'Todo API', version: '1.0.0' })
    expect(doc.servers).toEqual([{ url: 'https://api.example' }])
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/chat',
      '/docs',
      '/docs/{page}',
      '/files/{wildcard}',
      '/todos',
      '/todos/{id}',
      '/users/{id}',
      '/v1/health',
    ])
  })

  test('query parameters, response schema, summary and tags', () => {
    const op = doc.paths['/todos']!.get as any
    expect(op.summary).toBe('List todos')
    expect(op.tags).toEqual(['todos'])
    expect(op.operationId).toBe('getTodos')
    expect(op.parameters).toEqual([
      { name: 'limit', in: 'query', required: false, description: 'Max items', schema: { type: 'integer', maximum: 100 } },
      { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
    ])
    expect(op.responses['200'].content['application/json'].schema).toEqual({ type: 'array', items: Todo.toJSONSchema() })
    expect(op.responses['400'].description).toBe('Invalid request')
  })

  test('request body and custom responses', () => {
    const op = doc.paths['/todos']!.post as any
    expect(op.requestBody).toEqual({
      required: true,
      content: { 'application/json': { schema: s.object({ title: s.string() }).toJSONSchema() } },
    })
    expect(op.responses['201']).toEqual({ description: 'Created', content: { 'application/json': { schema: Todo.toJSONSchema() } } })
    expect(op.responses['200']).toBeUndefined()
  })

  test('path params use schema types; operationIds are unique and readable', () => {
    const op = doc.paths['/todos/{id}']!.get as any
    expect(op.parameters).toEqual([{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }])
    expect(op.operationId).toBe('getTodosById')
    expect((doc.paths['/users/{id}']!.delete as any).operationId).toBe('deleteUsersById')
    expect((doc.paths['/files/{wildcard}']!.get as any).parameters[0]).toEqual({ name: 'wildcard', in: 'path', required: true, schema: { type: 'string' } })
  })

  test('agent endpoint is documented as SSE; MCP and hidden routes are excluded', () => {
    const chat = doc.paths['/chat']!.post as any
    expect(chat.tags).toEqual(['ai'])
    expect(Object.keys(chat.responses['200'].content)).toEqual(['text/event-stream'])
    expect(doc.paths['/mcp']).toBeUndefined()
    expect(doc.paths['/internal']).toBeUndefined()
    expect((doc.paths['/v1/health']!.get as any).summary).toBe('Health')
  })

  test('serves as a route', async () => {
    const app = buildApp()
    app.get('/openapi.json', { docs: { hidden: true } }, () => openapi(app, { info: { title: 't', version: '1' } }))
    const r = await app.request('/openapi.json')
    expect((await r.json()).openapi).toBe('3.1.0')
  })
})
