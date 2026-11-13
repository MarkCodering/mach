/**
 * Expose Mach tools to any MCP client (Claude Desktop/Code, IDEs, other agents) over the
 * MCP Streamable HTTP transport. Stateless: every POST carries a JSON-RPC message.
 *
 * ```ts
 * import { mcpServer } from 'machjs/mcp'
 * app.mcp('/mcp', mcpServer({ name: 'weather', version: '1.0.0', tools: [weather] }))
 * ```
 */
import type { Context } from '../context.js'
import type { Tool } from '../ai/tool.js'
import { serializeToolOutput } from '../ai/tool.js'

export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const
export const LATEST_MCP_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0]

export interface MCPServerOptions<Ctx = unknown> {
  name: string
  version: string
  /** Shown to clients as guidance on how to use this server. */
  instructions?: string
  tools: Tool<any, any>[]
  /**
   * Allowed browser origins. Requests with an `Origin` header that is neither listed nor
   * same-origin are rejected (DNS-rebinding protection, required by the MCP spec).
   * Use `'*'` to allow any origin.
   */
  allowedOrigins?: string[] | '*'
  /** Derive a per-request context passed to tools (e.g. the authenticated user). */
  context?: (c: Context) => Ctx | Promise<Ctx>
  /** Max JSON-RPC messages in a batch (default 32). */
  maxBatch?: number
}

type JSONRPCId = string | number | null

interface JSONRPCRequest {
  jsonrpc: '2.0'
  id?: JSONRPCId
  method: string
  params?: Record<string, unknown>
}

const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const

export interface MCPServer {
  readonly name: string
  readonly tools: Tool<any, any>[]
  handle(c: Context): Promise<Response>
  /** Handle a single JSON-RPC message (transport-independent; useful for stdio or tests). */
  dispatch(message: unknown, context?: unknown, signal?: AbortSignal): Promise<Record<string, unknown> | null>
}

export function mcpServer<Ctx = unknown>(options: MCPServerOptions<Ctx>): MCPServer {
  const tools = new Map<string, Tool<any, any>>()
  for (const t of options.tools) {
    if (tools.has(t.name)) throw new TypeError(`Duplicate tool name "${t.name}"`)
    tools.set(t.name, t)
  }
  const maxBatch = options.maxBatch ?? 32

  const result = (id: JSONRPCId, value: unknown) => ({ jsonrpc: '2.0', id, result: value })
  const error = (id: JSONRPCId, code: number, message: string, data?: unknown) => ({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined && { data }) },
  })

  async function dispatch(message: unknown, context?: unknown, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    if (!isRequest(message)) return error(null, ERR.invalidRequest, 'Invalid JSON-RPC message')
    const { id, method, params = {} } = message
    const isNotification = id === undefined
    if (isNotification) return null // notifications/initialized, notifications/cancelled, ...

    switch (method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined
        const protocolVersion =
          requested && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : LATEST_MCP_PROTOCOL_VERSION
        return result(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: options.name, version: options.version },
          ...(options.instructions && { instructions: options.instructions }),
        })
      }
      case 'ping':
        return result(id, {})
      case 'tools/list':
        return result(id, {
          tools: [...tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: { type: 'object', ...t.spec.inputSchema },
          })),
        })
      case 'tools/call': {
        const name = params.name
        if (typeof name !== 'string') return error(id, ERR.invalidParams, 'Missing tool name')
        const t = tools.get(name)
        if (!t) return error(id, ERR.invalidParams, `Unknown tool: ${name}`)
        const r = await t.execute(params.arguments ?? {}, {
          signal: signal ?? new AbortController().signal,
          toolCallId: String(id),
          context,
        })
        const structured = r.output !== null && typeof r.output === 'object' && !Array.isArray(r.output)
        return result(id, {
          content: [{ type: 'text', text: serializeToolOutput(r.output) }],
          ...(structured && !r.isError && { structuredContent: r.output }),
          isError: r.isError,
        })
      }
      default:
        return error(id, ERR.methodNotFound, `Method not found: ${method}`)
    }
  }

  async function handle(c: Context): Promise<Response> {
    const origin = c.req.headers.get('origin')
    if (origin && !originAllowed(origin, c.req.url, options.allowedOrigins)) {
      return c.json(error(null, ERR.invalidRequest, 'Origin not allowed'), 403)
    }
    if (c.req.method === 'GET') {
      // No server-initiated stream: this server is stateless.
      return c.body(null, 405, { allow: 'POST' })
    }
    if (c.req.method === 'DELETE') return c.body(null, 405, { allow: 'POST' })

    let payload: unknown
    try {
      payload = await c.req.json()
    } catch {
      return c.json(error(null, ERR.parse, 'Parse error'), 400)
    }
    const context = options.context ? await options.context(c) : undefined
    const signal = c.req.signal

    if (Array.isArray(payload)) {
      if (payload.length === 0 || payload.length > maxBatch) {
        return c.json(error(null, ERR.invalidRequest, `Batch must contain 1-${maxBatch} messages`), 400)
      }
      const responses = (await Promise.all(payload.map((m) => safeDispatch(m, context, signal)))).filter(Boolean)
      return responses.length ? c.json(responses) : c.body(null, 202)
    }
    const response = await safeDispatch(payload, context, signal)
    return response ? c.json(response) : c.body(null, 202)
  }

  async function safeDispatch(m: unknown, context: unknown, signal: AbortSignal) {
    try {
      return await dispatch(m, context, signal)
    } catch (err) {
      console.error('[mach] MCP handler error:', err)
      const id = isRequest(m) ? (m.id ?? null) : null
      return error(id, ERR.internal, 'Internal error')
    }
  }

  return { name: options.name, tools: options.tools, handle, dispatch }
}

function isRequest(m: unknown): m is JSONRPCRequest {
  return (
    typeof m === 'object' &&
    m !== null &&
    (m as JSONRPCRequest).jsonrpc === '2.0' &&
    typeof (m as JSONRPCRequest).method === 'string' &&
    ((m as JSONRPCRequest).params === undefined || typeof (m as JSONRPCRequest).params === 'object')
  )
}

function originAllowed(origin: string, requestUrl: string, allowed: MCPServerOptions['allowedOrigins']): boolean {
  if (allowed === '*') return true
  if (allowed?.includes(origin)) return true
  try {
    return new URL(origin).host === new URL(requestUrl).host
  } catch {
    return false
  }
}
