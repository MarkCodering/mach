/**
 * Use tools from any remote MCP server (Streamable HTTP transport) in Mach agents.
 *
 * ```ts
 * import { mcpClient } from 'machjs/mcp'
 * const docs = mcpClient({ url: 'https://example.com/mcp', headers: { authorization: `Bearer ${token}` } })
 * const assistant = agent({ model, tools: [...(await docs.tools({ prefix: 'docs_' })), weather] })
 * ```
 */
import { type Tool, tool } from '../ai/tool.js'
import type { JSONSchema, StandardSchemaV1 } from '../schema/standard.js'
import { parseSSE } from '../stream/sse.js'
import { LATEST_MCP_PROTOCOL_VERSION } from './server.js'

export interface MCPClientOptions {
  url: string | URL
  /** Sent with every request (e.g. authorization). */
  headers?: Record<string, string>
  fetch?: typeof fetch
  clientInfo?: { name: string; version: string }
  protocolVersion?: string
}

export interface RemoteToolInfo {
  name: string
  title?: string
  description?: string
  inputSchema: JSONSchema
  annotations?: Record<string, unknown>
}

export interface CallToolResult {
  content: { type: string; text?: string; [key: string]: unknown }[]
  structuredContent?: unknown
  isError?: boolean
}

export interface ServerInfo {
  protocolVersion: string
  serverInfo: { name: string; version: string }
  capabilities: Record<string, unknown>
  instructions?: string
}

export class MCPError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message)
    this.name = 'MCPError'
  }
}

export interface MCPClient {
  /** Performs the initialize handshake (done automatically on first use). */
  connect(): Promise<ServerInfo>
  listTools(): Promise<RemoteToolInfo[]>
  callTool(name: string, args?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<CallToolResult>
  /**
   * The server's tools as Mach tools, ready for `agent({ tools })`. Names are sanitised to
   * `[A-Za-z0-9_-]{1,64}` (LLM provider rules) and can be prefixed to avoid collisions.
   */
  tools(options?: { prefix?: string; filter?: (t: RemoteToolInfo) => boolean }): Promise<Tool[]>
  /** Ends the session on the server, if it issued one. */
  close(): Promise<void>
}

export function mcpClient(options: MCPClientOptions): MCPClient {
  const doFetch = options.fetch ?? globalThis.fetch
  const url = String(options.url)
  let sessionId: string | undefined
  let protocolVersion: string | undefined
  let connecting: Promise<ServerInfo> | undefined
  let nextId = 1

  const baseHeaders = (): Record<string, string> => ({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(protocolVersion && { 'mcp-protocol-version': protocolVersion }),
    ...(sessionId && { 'mcp-session-id': sessionId }),
    ...options.headers,
  })

  async function send(message: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const res = await doFetch(url, { method: 'POST', headers: baseHeaders(), body: JSON.stringify(message), signal: signal ?? null })
    const sid = res.headers.get('mcp-session-id')
    if (sid) sessionId = sid
    if (!('id' in message)) {
      // Notification: 202 Accepted, no body.
      if (!res.ok) throw new MCPError(`Notification ${String(message.method)} failed with HTTP ${res.status}`)
      await res.body?.cancel()
      return undefined
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const parsed = safeParse(text) as { error?: { message?: string; code?: number } } | undefined
      throw new MCPError(parsed?.error?.message ?? `HTTP ${res.status} from MCP server`, parsed?.error?.code)
    }
    const type = res.headers.get('content-type') ?? ''
    let response: { id?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } } | undefined
    if (type.includes('text/event-stream') && res.body) {
      // The server may stream notifications/requests before the response to our id.
      for await (const ev of parseSSE(res.body, signal)) {
        const msg = safeParse(ev.data) as typeof response
        if (msg && msg.id === message.id && ('result' in msg || 'error' in msg)) {
          response = msg
          break
        }
      }
    } else {
      const body = safeParse(await res.text())
      response = (Array.isArray(body) ? body.find((m) => m?.id === message.id) : body) as typeof response
    }
    if (!response) throw new MCPError(`No response to ${String(message.method)}`)
    if (response.error) throw new MCPError(response.error.message, response.error.code, response.error.data)
    return response.result
  }

  const request = (method: string, params?: Record<string, unknown>, signal?: AbortSignal) =>
    send({ jsonrpc: '2.0', id: nextId++, method, ...(params && { params }) }, signal)

  function connect(): Promise<ServerInfo> {
    connecting ??= (async () => {
      const info = (await request('initialize', {
        protocolVersion: options.protocolVersion ?? LATEST_MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: options.clientInfo ?? { name: 'mach', version: '0.2.0' },
      })) as ServerInfo
      protocolVersion = info.protocolVersion
      await send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      return info
    })().catch((err) => {
      connecting = undefined
      throw err
    })
    return connecting
  }

  async function listTools(): Promise<RemoteToolInfo[]> {
    await connect()
    const out: RemoteToolInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const r = (await request('tools/list', cursor ? { cursor } : undefined)) as { tools: RemoteToolInfo[]; nextCursor?: string }
      out.push(...(r.tools ?? []))
      if (!r.nextCursor) break
      cursor = r.nextCursor
    }
    return out
  }

  async function callTool(name: string, args: Record<string, unknown> = {}, opts: { signal?: AbortSignal } = {}) {
    await connect()
    return (await request('tools/call', { name, arguments: args }, opts.signal)) as CallToolResult
  }

  async function tools(opts: { prefix?: string; filter?: (t: RemoteToolInfo) => boolean } = {}): Promise<Tool[]> {
    const remote = (await listTools()).filter(opts.filter ?? (() => true))
    const used = new Set<string>()
    return remote.map((info) => {
      const name = uniqueName(sanitizeName(`${opts.prefix ?? ''}${info.name}`), used)
      return tool({
        name,
        description: info.description ?? info.title ?? info.name,
        input: looseObject,
        jsonSchema: { type: 'object', ...info.inputSchema },
        run: async (input, ctx) => {
          const result = await callTool(info.name, input, { signal: ctx.signal })
          const text = contentToText(result.content)
          // The local tool wrapper adds its own "Error: " prefix; avoid doubling a remote one.
          if (result.isError) throw new Error(text.replace(/^Error:\s*/, '') || 'Remote tool failed')
          return result.structuredContent ?? text
        },
      })
    })
  }

  async function close(): Promise<void> {
    if (!sessionId) return
    await doFetch(url, { method: 'DELETE', headers: baseHeaders() }).then((r) => r.body?.cancel(), () => {})
    sessionId = undefined
    connecting = undefined
  }

  return { connect, listTools, callTool, tools, close }
}

/** Accepts any object; the remote server validates against its own schema. */
const looseObject: StandardSchemaV1<Record<string, unknown>> = {
  '~standard': {
    version: 1,
    vendor: 'mach',
    validate: (v) =>
      v !== null && typeof v === 'object' && !Array.isArray(v)
        ? { value: v as Record<string, unknown> }
        : { issues: [{ message: 'Expected an object' }] },
  },
}

function contentToText(content: CallToolResult['content'] = []): string {
  return content
    .map((c) => (c.type === 'text' ? (c.text ?? '') : c.type === 'resource_link' ? `[resource: ${String(c.uri)}]` : `[${c.type}]`))
    .join('\n')
}

function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'tool'
}

function uniqueName(name: string, used: Set<string>): string {
  let out = name
  for (let i = 2; used.has(out); i++) out = `${name.slice(0, 60)}_${i}`
  used.add(out)
  return out
}

function safeParse(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
