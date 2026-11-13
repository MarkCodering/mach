/**
 * Anthropic Claude via the Messages API (raw `fetch`, zero dependencies).
 *
 * ```ts
 * import { anthropic } from 'machjs/ai/anthropic'
 * const model = anthropic('claude-opus-5-5') // reads ANTHROPIC_API_KEY
 * ```
 */
import { parseSSE } from '../../stream/sse.js'
import { serializeToolOutput } from '../tool.js'
import {
  type AssistantPart,
  type FinishReason,
  type Message,
  type Model,
  type ModelEvent,
  ModelError,
  type ModelRequest,
  type Usage,
} from '../types.js'
import { env, parseJSONSafe, postStream, type ProviderHTTPOptions } from './shared.js'

export const ANTHROPIC_API_VERSION = '2026-10-21'
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5'
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

/** Models that support server-side refusal fallbacks with `fallbacks: "default"`. */
const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])

export interface AnthropicOptions extends ProviderHTTPOptions {
  /** Defaults to `ANTHROPIC_API_KEY`. */
  apiKey?: string
  /** OAuth / gateway bearer token instead of an API key. Defaults to `ANTHROPIC_AUTH_TOKEN`. */
  authToken?: string
  /** Defaults to `ANTHROPIC_BASE_URL` or https://api.anthropic.com */
  baseURL?: string
  /** Default `max_tokens` (default 64000; streaming makes large values safe). */
  maxTokens?: number
  /**
   * Server-side refusal fallbacks. Defaults to `'default'` on models that support it
   * (routes a declined request to an appropriate fallback model inside the same call).
   * Pass `false` to disable, or an explicit list of fallback models.
   */
  fallbacks?: 'default' | { model: string }[] | false
  /** Stream tool arguments as they are generated (`eager_input_streaming`). Default true. */
  eagerToolInput?: boolean
  /** Extra `anthropic-beta` flags. */
  betas?: string[]
}

export function anthropic(modelId: string = DEFAULT_ANTHROPIC_MODEL, options: AnthropicOptions = {}): Model {
  return {
    provider: 'anthropic',
    modelId,
    stream: (request) => streamAnthropic(modelId, options, request),
  }
}

async function* streamAnthropic(modelId: string, options: AnthropicOptions, request: ModelRequest): AsyncGenerator<ModelEvent> {
  const apiKey = options.apiKey ?? env('ANTHROPIC_API_KEY')
  const authToken = options.authToken ?? env('ANTHROPIC_AUTH_TOKEN')
  if (!apiKey && !authToken) {
    throw new ModelError('anthropic', 'Missing API key. Set ANTHROPIC_API_KEY or pass { apiKey } to anthropic().')
  }
  const baseURL = (options.baseURL ?? env('ANTHROPIC_BASE_URL') ?? 'https://api.anthropic.com').replace(/\/+$/, '')

  const headers: Record<string, string> = { 'anthropic-version': ANTHROPIC_API_VERSION }
  if (apiKey) headers['x-api-key'] = apiKey
  else headers.authorization = `Bearer ${authToken}`

  const body = buildRequestBody(modelId, options, request)
  const betas = [...(options.betas ?? [])]
  if (body.fallbacks !== undefined) betas.push(FALLBACK_BETA)
  if (betas.length) headers['anthropic-beta'] = [...new Set(betas)].join(',')

  const stream = await postStream('anthropic', `${baseURL}/v1/messages`, headers, body, {
    ...options,
    signal: request.signal,
  })
  yield* parseAnthropicStream(stream, request.signal)
}

/** @internal exported for tests */
export function buildRequestBody(modelId: string, options: AnthropicOptions, request: ModelRequest): Record<string, any> {
  const { system, messages } = toAnthropicMessages(request.messages, request.system)
  const body: Record<string, any> = {
    model: modelId,
    max_tokens: request.maxTokens ?? options.maxTokens ?? 64000,
    stream: true,
    messages,
  }
  if (system) body.system = system
  if (request.tools?.length) {
    const eager = options.eagerToolInput ?? true
    body.tools = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
      ...(eager && { eager_input_streaming: true }),
    }))
    // Forced tool choice (`any`/`tool`) is rejected by current models; only auto/none are exposed.
    if (request.toolChoice === 'none') body.tool_choice = { type: 'none' }
  }
  const fallbacks = options.fallbacks ?? (FALLBACK_MODELS.has(modelId) ? 'default' : false)
  if (fallbacks) body.fallbacks = fallbacks
  if (request.providerOptions) Object.assign(body, request.providerOptions)
  if (request.responseFormat) {
    // Merge so a caller's output_config (e.g. effort) is kept alongside the format.
    body.output_config = {
      ...(body.output_config as object | undefined),
      format: { type: 'json_schema', schema: toClaudeSchema(request.responseFormat.schema) },
    }
  }
  return body
}

const UNSUPPORTED_KEYWORDS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'pattern',
  'default',
  '$schema',
])

/**
 * Adapt a JSON Schema to Claude structured outputs: drop keywords it does not support
 * (they are still enforced client-side by `generateObject`), require
 * `additionalProperties: false` on objects, and express nullable types with `anyOf`.
 * @internal exported for tests
 */
export function toClaudeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toClaudeSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toClaudeSchema(v)]))
    } else if (key === 'additionalProperties' && value !== false) {
      throw new TypeError(
        'Claude structured outputs require `additionalProperties: false`; record/map schemas are not supported. ' +
          'Use an array of { key, value } objects instead.',
      )
    } else {
      out[key] = toClaudeSchema(value)
    }
  }
  if (out.type === 'object' && out.additionalProperties === undefined) out.additionalProperties = false
  if (Array.isArray(out.type)) {
    const { type, ...rest } = out
    return { anyOf: (type as string[]).map((t) => (t === 'null' ? { type: 'null' } : { ...rest, type: t })) }
  }
  return out
}

type Block = Record<string, unknown>

/** @internal exported for tests */
export function toAnthropicMessages(input: Message[], systemPrompt?: string): { system: string | undefined; messages: { role: 'user' | 'assistant'; content: Block[] }[] } {
  const systemParts: string[] = systemPrompt ? [systemPrompt] : []
  const out: { role: 'user' | 'assistant'; content: Block[] }[] = []
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    if (blocks.length === 0) return
    const last = out.at(-1)
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }

  for (const m of input) {
    switch (m.role) {
      case 'system':
        systemParts.push(m.content)
        break
      case 'user':
        if (typeof m.content === 'string') push('user', m.content ? [{ type: 'text', text: m.content }] : [])
        else {
          push(
            'user',
            m.content.flatMap((p): Block[] => {
              if (p.type === 'text') return p.text ? [{ type: 'text', text: p.text }] : []
              if (p.url) return [{ type: 'image', source: { type: 'url', url: p.url } }]
              if (p.data) return [{ type: 'image', source: { type: 'base64', media_type: p.mediaType ?? 'image/png', data: p.data } }]
              return []
            }),
          )
        }
        break
      case 'assistant':
        if (typeof m.content === 'string') push('assistant', m.content ? [{ type: 'text', text: m.content }] : [])
        else push('assistant', assistantBlocks(m.content))
        break
      case 'tool':
        push(
          'user',
          m.content.map((r) => ({
            type: 'tool_result',
            tool_use_id: r.id,
            content: serializeToolOutput(r.output),
            ...(r.isError && { is_error: true }),
          })),
        )
        break
    }
  }
  return { system: systemParts.length ? systemParts.join('\n\n') : undefined, messages: out }
}

function assistantBlocks(parts: AssistantPart[]): Block[] {
  // After a mid-stream fallback, thinking and tool_use blocks before the last `fallback`
  // block must be omitted, while the fallback block stays exactly in place.
  let boundary = -1
  parts.forEach((p, i) => {
    if (p.type === 'provider' && p.provider === 'anthropic' && (p.data as Block)?.type === 'fallback') boundary = i
  })
  const blocks: Block[] = []
  parts.forEach((p, i) => {
    const beforeBoundary = i < boundary
    switch (p.type) {
      case 'text':
        if (p.text) blocks.push({ type: 'text', text: p.text })
        break
      case 'reasoning':
        if (beforeBoundary) break
        if (p.redacted !== undefined) blocks.push({ type: 'redacted_thinking', data: p.redacted })
        else if (p.signature !== undefined) blocks.push({ type: 'thinking', thinking: p.text, signature: p.signature })
        // Unsigned reasoning (from another provider) cannot be replayed to Claude: drop it.
        break
      case 'tool-call':
        if (beforeBoundary) break
        blocks.push({ type: 'tool_use', id: p.id, name: p.name, input: p.input ?? {} })
        break
      case 'provider':
        if (p.provider === 'anthropic' && p.data && typeof p.data === 'object') blocks.push(p.data as Block)
        break
    }
  })
  return blocks
}

interface OpenBlock {
  type: string
  id?: string
  name?: string
  json: string
  text: string
  signature?: string
  data?: string
  raw?: Block
}

/** @internal exported for tests */
export async function* parseAnthropicStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<ModelEvent> {
  const blocks = new Map<number, OpenBlock>()
  const usage: Usage = { inputTokens: 0, outputTokens: 0 }
  let stopReason: string | undefined
  let stopped = false
  // Tool calls are held until the end: a mid-stream fallback invalidates earlier ones.
  const toolCalls: { index: number; event: ModelEvent }[] = []
  let lastFallbackIndex = -1

  for await (const ev of parseSSE(body, signal)) {
    if (ev.event === 'ping') continue
    let data: any
    try {
      data = JSON.parse(ev.data)
    } catch {
      continue
    }
    switch (data.type) {
      case 'message_start': {
        const u = data.message?.usage
        if (u) {
          usage.inputTokens = u.input_tokens ?? 0
          usage.outputTokens = u.output_tokens ?? 0
          if (u.cache_read_input_tokens) usage.cacheReadTokens = u.cache_read_input_tokens
          if (u.cache_creation_input_tokens) usage.cacheWriteTokens = u.cache_creation_input_tokens
        }
        break
      }
      case 'content_block_start': {
        const cb = data.content_block ?? {}
        const block: OpenBlock = { type: cb.type, json: '', text: '' }
        if (cb.type === 'tool_use') {
          block.id = cb.id
          block.name = cb.name
        } else if (cb.type === 'text' && cb.text) {
          yield { type: 'text-delta', text: cb.text }
        } else if (cb.type === 'thinking') {
          block.text = cb.thinking ?? ''
          if (cb.signature) block.signature = cb.signature
        } else if (cb.type === 'redacted_thinking') {
          block.data = cb.data
        } else if (cb.type !== 'text') {
          block.raw = cb
        }
        blocks.set(data.index, block)
        break
      }
      case 'content_block_delta': {
        const block = blocks.get(data.index)
        const d = data.delta ?? {}
        if (d.type === 'text_delta') yield { type: 'text-delta', text: d.text }
        else if (d.type === 'thinking_delta') {
          if (block) block.text += d.thinking
          if (d.thinking) yield { type: 'reasoning-delta', text: d.thinking }
        } else if (d.type === 'signature_delta') {
          if (block) block.signature = (block.signature ?? '') + d.signature
        } else if (d.type === 'input_json_delta' && block) {
          block.json += d.partial_json
          if (d.partial_json) yield { type: 'tool-call-delta', id: block.id!, name: block.name!, inputDelta: d.partial_json }
        }
        break
      }
      case 'content_block_stop': {
        const block = blocks.get(data.index)
        if (!block) break
        if (block.type === 'thinking') {
          yield { type: 'reasoning', text: block.text, ...(block.signature !== undefined && { signature: block.signature }) }
        } else if (block.type === 'redacted_thinking') {
          yield { type: 'reasoning', text: '', redacted: block.data ?? '' }
        } else if (block.type === 'tool_use') {
          const parsed = parseJSONSafe(block.json)
          toolCalls.push({
            index: data.index,
            event: parsed.ok
              ? { type: 'tool-call', id: block.id!, name: block.name!, input: parsed.value }
              : { type: 'tool-call', id: block.id!, name: block.name!, input: undefined, inputError: parsed.error },
          })
        } else if (block.raw) {
          if (block.raw.type === 'fallback') lastFallbackIndex = data.index
          // Server tool blocks, fallback markers, etc.: keep them for faithful replay.
          yield { type: 'provider-part', provider: 'anthropic', data: block.raw }
        }
        break
      }
      case 'message_delta':
        if (data.delta?.stop_reason) stopReason = data.delta.stop_reason
        if (data.usage?.output_tokens !== undefined) usage.outputTokens = data.usage.output_tokens
        if (data.usage?.input_tokens !== undefined && data.usage.input_tokens > usage.inputTokens) {
          usage.inputTokens = data.usage.input_tokens
        }
        break
      case 'message_stop':
        stopped = true
        break
      case 'error':
        throw new ModelError('anthropic', data.error?.message ?? 'Stream error', { body: data })
    }
  }

  if (!stopped) throw new ModelError('anthropic', 'Stream ended before message_stop')
  for (const tc of toolCalls) if (tc.index > lastFallbackIndex) yield tc.event
  yield { type: 'usage', usage }
  yield { type: 'finish', reason: mapStopReason(stopReason), ...(stopReason !== undefined && { rawReason: stopReason }) }
}

function mapStopReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'tool_use':
      return 'tool-calls'
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length'
    case 'refusal':
      return 'refusal'
    default:
      return 'other'
  }
}
