/**
 * Browser/edge/server client for Mach agent endpoints. Zero dependencies.
 *
 * ```ts
 * import { streamChat } from 'machjs/client'
 * for await (const ev of streamChat('/chat', { messages })) {
 *   if (ev.type === 'text-delta') render(ev.text)
 * }
 * ```
 */
import type { AgentEvent } from './ai/agent.js'
import type { Message } from './ai/types.js'
import { parseSSE } from './stream/sse.js'

export interface StreamChatOptions {
  messages: Message[]
  headers?: Record<string, string>
  signal?: AbortSignal
  fetch?: typeof fetch
}

export class ChatHTTPError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`Chat request failed with HTTP ${status}`)
    this.name = 'ChatHTTPError'
  }
}

/** POST messages to an agent endpoint and iterate its events. */
export async function* streamChat(url: string | URL, options: StreamChatOptions): AsyncGenerator<AgentEvent> {
  const doFetch = options.fetch ?? globalThis.fetch
  const res = await doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...options.headers },
    body: JSON.stringify({ messages: options.messages }),
    signal: options.signal ?? null,
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      /* keep text */
    }
    throw new ChatHTTPError(res.status, body)
  }
  yield* readAgentStream(res.body, options.signal)
}

/** Parse an SSE body produced by `app.agent()` into typed events. */
export async function* readAgentStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
  for await (const ev of parseSSE(body, signal)) {
    let data: unknown
    try {
      data = JSON.parse(ev.data)
    } catch {
      continue
    }
    if (ev.event === 'error') {
      throw new Error((data as { message?: string })?.message ?? 'Agent stream failed')
    }
    yield data as AgentEvent
  }
}

/**
 * Keep conversation state on the client: collects text and appends the messages
 * the server produced, ready for the next turn.
 */
export async function chat(url: string | URL, options: StreamChatOptions & { onText?: (delta: string) => void }) {
  const messages = [...options.messages]
  let text = ''
  for await (const ev of streamChat(url, options)) {
    if (ev.type === 'text-delta') {
      text += ev.text
      options.onText?.(ev.text)
    } else if (ev.type === 'message') messages.push(ev.message)
  }
  return { text, messages }
}

export type { AgentEvent, Message }
