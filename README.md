# Mach

**The fast, lightweight, AI-native web framework.** Built on Web Standards, with zero dependencies. Streaming, tools, agents and MCP are part of the framework, not bolted on.

```ts
import { Mach } from 'machjs'
import { agent, tool } from 'machjs/ai'
import { anthropic } from 'machjs/ai/anthropic'
import { mcpServer } from 'machjs/mcp'
import { s } from 'machjs'

const weather = tool({
  name: 'get_weather',
  description: 'Current weather for a city',
  input: s.object({ city: s.string() }),
  run: async ({ city }) => ({ city, tempC: 21 }),
})

const app = new Mach()
  .agent('/chat', agent({ model: anthropic('claude-opus-5-5'), tools: [weather] })) // streaming SSE agent
  .mcp('/mcp', mcpServer({ name: 'weather', version: '1.0.0', tools: [weather] })) // same tool, over MCP

export default app // Bun, Deno, Cloudflare Workers. Node: serve(app) from 'machjs/node'
```

## Why Mach

- **Fast.** A RegExp-compiled router and a near-allocation-free hot path. In-process it runs 1.1–2× faster than Hono on Bun and Node ([benchmarks](#benchmarks)).
- **Light.** Zero runtime dependencies. A minimal app bundles to **~6.3 KB gzipped**. An app using the agent, tools, the Anthropic adapter and MCP comes to ~15.5 KB.
- **Web Standards.** `Request` in, `Response` out. Runs on Bun, Node, Deno, Cloudflare Workers, Vercel and other edge runtimes. No `eval`.
- **AI-native.**
  - First-class SSE with backpressure and client-disconnect aborts.
  - Provider-neutral models: Claude, any OpenAI-compatible server, or a scripted mock.
  - Typed tools and a parallel tool-calling agent loop with token budgets and usage hooks.
  - Schema-validated structured output (`generateObject`).
  - One tool definition serves the agent, your routes and MCP clients, and `mcpClient()` brings remote MCP tools in.
  - `useChat` for React, plus a framework-agnostic chat store.
- **Developer friendly.**
  - Return anything (string, object, stream, async generator).
  - Params are typed from the path, and inputs are validated and typed from schemas.
  - Those same schemas generate an OpenAPI 3.1 document.
  - `app.request()` for tests and clear error messages.
  - A mock model so everything runs offline with no API key.
- **Secure by default.**
  - Clients cannot inject `system` prompts.
  - The MCP endpoint checks `Origin` (DNS-rebinding protection).
  - Internal errors are never leaked.
  - `bodyLimit()` also enforces limits on chunked bodies.

## Install

```bash
bun add machjs      # or: npm i machjs / pnpm add machjs / deno add npm:machjs
```

## Quickstart

```ts
import { Mach, s } from 'machjs'

const app = new Mach()

app.get('/', () => 'Hello Mach')                                // string → text/plain
app.get('/users/:id', (c) => ({ id: c.params.id }))             // object → JSON, params typed
app.post('/todos', { body: s.object({ title: s.string() }) },   // validated + typed
  (c) => c.json({ created: c.input.body.title }, 201))
app.get('/ticks', async function* () {                          // async generator → SSE
  for (let i = 0; i < 3; i++) yield { type: 'tick', i }
})

export default app
```

Run it with `bun run index.ts`, `deno serve index.ts`, or deploy it to Workers as-is.

## Core

### Routing

```ts
app.get('/users/:id', handler)           // c.params.id: string
app.get('/docs/:page?', handler)         // optional trailing param
app.get('/static/*', handler)            // c.params['*']
app.on(['PUT', 'PATCH'], '/items/:id', handler)
app.all('/proxy/*', handler)
app.route('/api/v1', subApp)             // mount a sub-app (its middleware stays scoped to it)
```

Precedence is static segment, then `:param`, then `*`, compared left to right. Unknown paths get a 404. A path that exists under a different method gets a 405 with an `Allow` header. `HEAD` falls back to `GET`.

### Return values

| Handler returns | Response |
| --- | --- |
| `Response` | as-is |
| `string` | `text/plain` |
| object, array, number, boolean | JSON |
| `null` | `204 No Content` |
| `ReadableStream` / `Uint8Array` | streamed / binary body |
| `AsyncIterable` (e.g. an async generator, an agent run) | **Server-Sent Events** |

Helpers: `c.json()`, `c.text()`, `c.html()`, `c.body()`, `c.redirect()`, `c.status()`, `c.header()`, `c.stream()` and `c.sse()`.

### Validation

Route options validate `body`, `query`, `params` and `headers` using any [Standard Schema](https://standardschema.dev) library (Zod, Valibot, ArkType) or Mach's built-in `s`. Results are fully typed on `c.input`:

```ts
app.post('/items/:id', {
  params: s.object({ id: s.coerce.integer() }),
  query:  s.object({ dryRun: s.coerce.boolean().optional() }),
  body:   s.object({ name: s.string({ min: 1 }), tags: s.array(s.string()).default([]) }),
}, (c) => c.input.body.tags)   // string[]
```

Invalid input returns a `400` with `{ error, target, issues: [{ message, path }] }`.

`s` covers `string`, `number`, `integer`, `boolean`, `literal`, `enum`, `array`, `object`, `record`, `union`, `unknown`, `coerce.*` and the modifiers `.optional()`, `.nullable()`, `.default()` and `.describe()`. It also emits JSON Schema, which is what LLM tools need.

### Middleware

Middleware runs in registration order before handlers, including on 404s and CORS preflights, so it always gets a chance to act.

```ts
import { cors, logger, requestId, timing, bodyLimit } from 'machjs/middleware'

app.use(logger(), requestId(), cors({ origin: ['https://app.example'] }), bodyLimit(1_000_000))
app.use('/admin/*', async (c, next) => {
  if (!c.req.headers.get('authorization')) return c.json({ error: 'Unauthorized' }, 401)
  await next()
  c.header('x-admin', '1')  // modify the response after the handler
})
```

**Rate limiting** works per key, with an optional per-request cost so expensive AI endpoints can count for more:

```ts
import { rateLimit } from 'machjs/middleware'

app.use('/chat', rateLimit({
  limit: 60, windowMs: 60_000,
  key: (c) => c.req.headers.get('x-api-key'),            // you choose the identity; IP headers are spoofable
  cost: (c) => (c.req.method === 'POST' ? 5 : 1),
  // store: a Redis/KV implementation of RateLimitStore when running several instances
}))
```

It sends `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` on every response, and a `429` with `Retry-After` when a key is over its limit.

Returning nothing without calling `next()` simply passes through, so guard-style middleware is a one-liner. Thrown errors become responses where they are thrown, so outer middleware such as CORS still decorates error responses. Typed per-request state comes from `new Mach<{ Variables: { user: User } }>()` together with `c.set()`, `c.get()` and `c.var`.

### Errors

```ts
throw new HTTPException(403, 'Forbidden')   // → 403 {"error":"Forbidden"}
app.onError((err, c) => c.json({ error: 'Something broke' }, 500))
app.notFound((c) => c.text('Nope', 404))
```

Unknown errors are logged and returned as a generic 500. Stack traces and messages are never sent to clients.

### Testing

```ts
const res = await app.request('/todos', { json: { title: 'x' } })   // POST with a JSON body
expect(res.status).toBe(201)
```

### OpenAPI

Route schemas double as API documentation. `openapi()` builds an OpenAPI 3.1 document from them, including path, query and header parameters, request bodies, responses and validation errors:

```ts
import { openapi } from 'machjs/openapi'

app.get('/todos/:id', {
  params: s.object({ id: s.string({ format: 'uuid' }) }),
  response: Todo,                                         // documents the 200 JSON body
  docs: { summary: 'Get a todo', tags: ['todos'] },       // also: description, operationId, deprecated, hidden, responses
}, handler)

app.get('/openapi.json', { docs: { hidden: true } }, () => openapi(app, { info: { title: 'Todo API', version: '1.0.0' } }))
```

Agent endpoints are documented as `text/event-stream`, and MCP endpoints are left out.

## AI

### Models

Every provider implements one tiny interface, `stream(request) → AsyncIterable<ModelEvent>`, so you can swap models without touching the rest of the app.

```ts
import { anthropic } from 'machjs/ai/anthropic'
import { openai } from 'machjs/ai/openai'
import { mockModel } from 'machjs/ai/mock'

anthropic('claude-opus-5-5')                                    // ANTHROPIC_API_KEY
openai('gpt-4.1')                                               // OPENAI_API_KEY
openai('llama3.2', { baseURL: 'http://localhost:11434/v1' })    // Ollama, vLLM, LM Studio, Groq, OpenRouter...
mockModel(['Hello!'])                                           // offline, deterministic, for tests and demos
```

All adapters use raw `fetch` with zero SDKs. They retry 408/409/429/5xx with backoff (honouring `retry-after`) and raise `ModelError`, which carries `status` and a `retryable` flag. Provider-specific options go through `providerOptions`, for example `{ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } }` for Claude.

The Anthropic adapter targets API version `2026-10-21`:
- It streams thinking, text and tool use, and replays signed thinking blocks unchanged during tool loops.
- It sets `eager_input_streaming` on tools.
- On models that support it, it enables server-side refusal **fallbacks** (`fallbacks: "default"`) and applies the fallback echo rules. Pass `fallbacks: false` to opt out.

```ts
import { generate } from 'machjs/ai'
const { text, usage } = await generate(anthropic(), 'Summarize Web Standards in one line')
```

### Structured output

`generateObject()` returns a typed object validated against your schema:

```ts
import { generateObject } from 'machjs/ai'

const { object } = await generateObject(anthropic(), {
  schema: s.object({ name: s.string(), email: s.string({ format: 'email' }).nullable() }),
  prompt: 'Extract the contact: "Met Ada Lovelace (ada@example.com) yesterday"',
})
object.email // string | null
```

It uses each provider's native structured output: Claude's `output_config.format`, with the schema adapted to what Claude supports, and OpenAI's `response_format`. Constraints the provider can't enforce, such as length limits, are still checked client-side. If the output doesn't parse or validate, it retries once (configurable with `maxRetries`) with the errors fed back to the model. Refusals and truncated output throw `ObjectGenerationError`.

### Tools

```ts
const search = tool({
  name: 'search_docs',
  description: 'Search the documentation',
  input: s.object({ query: s.string().describe('What to look for'), limit: s.integer({ max: 20 }).default(5) }),
  run: async ({ query, limit }, { signal, context }) => db.search(query, { limit, signal }),
})

await search.run({ query: 'routing' })    // call it directly, typed
search.spec                               // { name, description, inputSchema }  (JSON Schema)
```

Inputs are validated before `run`. Validation failures and thrown errors go back to the model as error results, so it can recover, and they never crash the request.

### Agents

```ts
const assistant = agent({
  model: anthropic('claude-opus-5-5'),
  system: 'You are a concise assistant.',          // or (context) => string
  tools: [search, weather],
  maxSteps: 10,
  beforeToolCall: (call, ctx) => call.name !== 'delete_everything',   // approvals and policy
  maxTotalTokens: 200_000,                                            // per-run token budget
  onStepFinish: (step, ctx) => meter(ctx.user, step.usage),           // usage accounting
  onFinish: (result, ctx) => saveConversation(ctx.user, result.messages),
  http: { context: (c) => ({ user: c.get('user') }) },                // per-request context for tools
})

app.agent('/chat', assistant)                            // POST { messages } or { prompt } → SSE
const result = await assistant.run('Weather in Paris?')  // or run it in-process
for await (const ev of assistant.stream(messages)) { /* events */ }
```

The loop calls the model and runs requested tools **in parallel**, streaming their results as they finish. It feeds the results back and repeats until the model answers.

- It stops at `maxSteps`, at the `maxTotalTokens` budget (`finishReason: 'budget'`), on truncation and on refusals. It never runs tool calls from a truncated turn.
- Aborts, including client disconnects, cancel the model call and the tools.
- Incoming history is repaired before the model sees it. Tool calls that never got a result, for example because the user pressed Stop mid-tool, are dropped so providers accept the conversation.

**SSE wire protocol.** Each event is sent as `event: <type>` followed by `data: <json>`:

| Event | Payload |
| --- | --- |
| `step-start` | `{ step }` |
| `text-delta` / `reasoning-delta` | `{ text }` |
| `tool-call-delta` | `{ id, name, inputDelta }` (live argument streaming) |
| `tool-call` | `{ id, name, input }` |
| `tool-result` | `{ id, name, output, isError, durationMs }` |
| `message` | `{ message }`, an assistant or tool message to persist for the next turn |
| `step-finish` | `{ step, finishReason, usage }` |
| `finish` | `{ text, finishReason, usage, steps }` |
| `error` | `{ message }` (generic, with no internals) |

### Client and UI

```ts
import { chat, streamChat } from 'machjs/client'

const { text, messages } = await chat('/chat', { messages, onText: (d) => render(d) })
for await (const ev of streamChat('/chat', { messages })) { /* typed AgentEvent */ }
```

`useChat` (React) keeps the conversation, the streaming draft and live tool status for you:

```tsx
import { useChat } from 'machjs/react'

function Chat() {
  const { messages, draft, tools, status, send, stop } = useChat({ api: '/chat' })
  return (
    <>
      {messages.map((m, i) => <Message key={i} message={m} />)}
      {draft && <p>{draft}</p>}
      {tools.filter((t) => t.status === 'running').map((t) => <Spinner key={t.id} label={t.name} />)}
      {status === 'streaming' ? <button onClick={stop}>Stop</button> : <Composer onSend={send} />}
    </>
  )
}
```

The hook is a thin wrapper over `createChat()` from `machjs/client`. That is a framework-agnostic store (`getState`, `subscribe`, `send`, `stop`, `setMessages`) with immutable snapshots, so it also plugs into Vue, Svelte, Solid or plain JS. React is an optional peer dependency.

### MCP

`mcpServer()` exposes tools to any MCP client (Claude, IDEs, other agents) over the Streamable HTTP transport. It supports protocol versions `2025-11-25`, `2025-06-18` and `2025-03-26`, handling `initialize`, `ping`, `tools/list` and `tools/call` and returning `structuredContent`. It is stateless, and it validates `Origin` against `allowedOrigins`.

```ts
app.mcp('/mcp', mcpServer({ name: 'docs', version: '1.0.0', tools: [search], context: (c) => ({ user: c.get('user') }) }))
```

`mcpClient()` goes the other way: it turns any remote MCP server's tools into Mach tools for your agents. It handles the initialize handshake, session IDs, JSON or SSE responses, and pagination:

```ts
import { mcpClient } from 'machjs/mcp'

const github = mcpClient({ url: 'https://example.com/mcp', headers: { authorization: `Bearer ${token}` } })
const assistant = agent({ model, tools: [...(await github.tools({ prefix: 'gh_' })), weather] })
```

Remote tool names are sanitised to what LLM providers accept (`[A-Za-z0-9_-]{1,64}`), and remote errors come back to the model as error results.

## Runtimes

```ts
export default app                                    // Bun, Deno (deno serve), Cloudflare Workers
Bun.serve({ port: 3000, fetch: app.fetch })           // Bun, explicit
Deno.serve(app.fetch)                                 // Deno
import { serve } from 'machjs/node'; serve(app)       // Node.js ≥ 20 (streams, backpressure, disconnect aborts)
```

Platform bindings arrive as `c.env`, and the Workers `ExecutionContext` as `c.executionCtx`.

## Benchmarks

These measure framework overhead in-process: `app.fetch(Request) → Response`, with no sockets, over a 21-route REST and AI route table. The machine was a 4-vCPU Intel Xeon @ 2.1 GHz, measured with [mitata](https://github.com/evanwashere/mitata) against Hono 4.13.18 (default preset) and find-my-way 9.10.0.

| Benchmark | Bun 1.4.4 | Node 22.23 |
| --- | --- | --- |
| 8 requests, text response | **1.13×** faster than Hono | **1.11×** faster than Hono |
| 8 requests + 1 middleware | **1.98×** faster than Hono | **1.69×** faster than Hono |
| JSON response with a param | **1.68×** faster than Hono | **1.04×** faster than Hono |

Router lookup only (Bun):

| Lookup | Mach | Hono RegExpRouter | find-my-way |
| --- | --- | --- | --- |
| static | 5.3 ns | 4.8 ns | 55 ns |
| one param | 95 ns | 100 ns | 130 ns |
| two params | 123 ns | 109 ns | 159 ns |

Caveats, honestly stated:
- These are micro-benchmarks, and real apps are dominated by I/O and, for AI apps, by model latency.
- Hono's RegExpRouter is still slightly ahead on raw lookups in the full mix.
- Results vary by machine, runtime version and run (for example, JSON on Bun has measured 1.7–2.0×).

Reproduce them with `bun run bench`, and `bun run bench:node` for Node.

## Development

```bash
bun install
bun test              # 122 tests: core, schema, SSE, middleware, agent, structured output, providers, MCP server/client, OpenAPI, UI store, Node adapter, types
bun run typecheck     # strict TypeScript, including type-level tests
bun run build         # ESM + .d.ts into dist/
bun run example:chat  # chat UI + agent + MCP at http://localhost:3000 (mock model unless ANTHROPIC_API_KEY is set)
bun run bench
```

## Roadmap

- Typed RPC client (route types → client)
- `streamObject()` with partial-JSON streaming; embeddings
- More providers (Gemini, Bedrock, Vertex)
- Vue/Svelte bindings for `createChat`
- MCP resources, prompts, and server-initiated streams

## License

MIT © Mark Chen
