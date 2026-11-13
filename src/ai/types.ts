/**
 * Provider-neutral message and event types. Every provider adapter maps to and from these.
 */
import type { JSONSchema } from '../schema/standard.js'

export interface TextPart {
  type: 'text'
  text: string
}

export interface ImagePart {
  type: 'image'
  /** Base64 data (no `data:` prefix) or a URL. */
  data?: string
  url?: string
  mediaType?: string
}

/**
 * Model reasoning. Keep these in the history you send back: some providers (Anthropic) require
 * thinking blocks to be replayed unchanged, signature included, during tool loops.
 */
export interface ReasoningPart {
  type: 'reasoning'
  text: string
  /** Provider signature that must be echoed back verbatim. */
  signature?: string
  /** Opaque redacted reasoning payload. */
  redacted?: string
}

export interface ToolCallPart {
  type: 'tool-call'
  id: string
  name: string
  input: unknown
}

export interface ToolResultPart {
  type: 'tool-result'
  id: string
  name: string
  output: unknown
  isError?: boolean
}

/**
 * An opaque provider-specific block that must be echoed back to the same provider in place
 * (e.g. Anthropic's `fallback` boundary block). Other providers ignore it.
 */
export interface ProviderPart {
  type: 'provider'
  provider: string
  data: unknown
}

export type UserPart = TextPart | ImagePart
export type AssistantPart = TextPart | ReasoningPart | ToolCallPart | ProviderPart

export interface SystemMessage {
  role: 'system'
  content: string
}
export interface UserMessage {
  role: 'user'
  content: string | UserPart[]
}
export interface AssistantMessage {
  role: 'assistant'
  content: string | AssistantPart[]
}
export interface ToolMessage {
  role: 'tool'
  content: ToolResultPart[]
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage

/** What a model sees about a tool. */
export interface ToolSpec {
  name: string
  description: string
  inputSchema: JSONSchema
}

export interface ModelRequest {
  messages: Message[]
  /** System prompt. Merged with any `system` role messages. */
  system?: string
  tools?: ToolSpec[]
  /** `auto` (default when tools are given) or `none`. */
  toolChoice?: 'auto' | 'none'
  maxTokens?: number
  signal?: AbortSignal
  /**
   * Provider-specific request fields, shallow-merged into the request body
   * (e.g. `{ thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' } }`).
   */
  providerOptions?: Record<string, unknown>
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export type FinishReason = 'stop' | 'tool-calls' | 'length' | 'refusal' | 'other'

export type ModelEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  /** A completed reasoning block (with signature) to keep in history. */
  | { type: 'reasoning'; text: string; signature?: string; redacted?: string }
  /** Partial tool-call arguments as they stream (for live UIs). */
  | { type: 'tool-call-delta'; id: string; name: string; inputDelta: string }
  /** A complete tool call. `inputError` is set when the model produced unparseable arguments. */
  | { type: 'tool-call'; id: string; name: string; input: unknown; inputError?: string }
  /** An opaque provider block to keep in history (see `ProviderPart`). */
  | { type: 'provider-part'; provider: string; data: unknown }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason: FinishReason; rawReason?: string }

/**
 * A language model. Implement `stream()` to add any provider:
 * yield events, finish with exactly one `finish` event.
 */
export interface Model {
  readonly provider: string
  readonly modelId: string
  stream(request: ModelRequest): AsyncIterable<ModelEvent>
}

export class ModelError extends Error {
  readonly status: number | undefined
  readonly provider: string
  readonly body: unknown
  constructor(provider: string, message: string, options: { status?: number; body?: unknown; cause?: unknown } = {}) {
    super(`[${provider}] ${message}`, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ModelError'
    this.provider = provider
    this.status = options.status
    this.body = options.body
  }
  /** 408/409/429/5xx and network errors are worth retrying. */
  get retryable(): boolean {
    const s = this.status
    return s === undefined || s === 408 || s === 409 || s === 429 || s >= 500
  }
}
