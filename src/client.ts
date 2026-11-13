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

// ─── Chat store (framework-agnostic) ────────────────────────────────────────

export interface ActiveTool {
  id: string
  name: string
  input: unknown
  status: 'running' | 'done' | 'error'
  output?: unknown
}

export interface ChatState {
  /** The conversation: your messages plus everything the server produced. */
  messages: Message[]
  status: 'idle' | 'streaming' | 'error'
  error: Error | undefined
  /** Text of the assistant turn currently streaming (not yet in `messages`). */
  draft: string
  /** Reasoning of the assistant turn currently streaming. */
  draftReasoning: string
  /** Tool calls of the current run, with live status. */
  tools: ActiveTool[]
}

export interface ChatOptions {
  /** Agent endpoint, e.g. '/chat'. */
  api: string | URL
  initialMessages?: Message[]
  headers?: Record<string, string> | (() => Record<string, string>)
  fetch?: typeof fetch
  onEvent?: (event: AgentEvent) => void
  onFinish?: (event: Extract<AgentEvent, { type: 'finish' }>, messages: Message[]) => void
  onError?: (error: Error) => void
}

export interface ChatStore {
  getState(): ChatState
  /** Subscribe to state changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Send a user message and stream the reply. Resolves when the run ends. */
  send(content: string | import('./ai/types.js').UserPart[]): Promise<void>
  /** Abort the in-flight request. */
  stop(): void
  /** Replace the conversation (e.g. load from storage). Stops any run. */
  setMessages(messages: Message[]): void
}

/**
 * State container for chat UIs. Immutable snapshots + subscribe, so it plugs into React
 * (`useSyncExternalStore`, see `machjs/react`), Vue, Svelte, Solid or vanilla JS.
 */
export function createChat(options: ChatOptions): ChatStore {
  let state: ChatState = {
    messages: options.initialMessages ?? [],
    status: 'idle',
    error: undefined,
    draft: '',
    draftReasoning: '',
    tools: [],
  }
  const listeners = new Set<() => void>()
  let controller: AbortController | undefined

  const set = (patch: Partial<ChatState>) => {
    state = { ...state, ...patch }
    for (const l of listeners) l()
  }

  const apply = (ev: AgentEvent) => {
    switch (ev.type) {
      case 'text-delta':
        set({ draft: state.draft + ev.text })
        break
      case 'reasoning-delta':
        set({ draftReasoning: state.draftReasoning + ev.text })
        break
      case 'tool-call':
        set({ tools: [...state.tools, { id: ev.id, name: ev.name, input: ev.input, status: 'running' }] })
        break
      case 'tool-result':
        set({
          tools: state.tools.map((t) =>
            t.id === ev.id ? { ...t, status: ev.isError ? 'error' : 'done', output: ev.output } : t,
          ),
        })
        break
      case 'message':
        set({
          messages: [...state.messages, ev.message],
          ...(ev.message.role === 'assistant' && { draft: '', draftReasoning: '' }),
        })
        break
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async send(content) {
      controller?.abort()
      const ac = (controller = new AbortController())
      const messages: Message[] = [...state.messages, { role: 'user', content }]
      set({ messages, status: 'streaming', error: undefined, draft: '', draftReasoning: '', tools: [] })
      try {
        const headers = typeof options.headers === 'function' ? options.headers() : options.headers
        for await (const ev of streamChat(options.api, {
          messages,
          signal: ac.signal,
          ...(headers && { headers }),
          ...(options.fetch && { fetch: options.fetch }),
        })) {
          if (ac !== controller) return // superseded by a newer send()/setMessages()
          apply(ev)
          options.onEvent?.(ev)
          if (ev.type === 'finish') options.onFinish?.(ev, state.messages)
        }
        if (ac === controller) set({ status: 'idle', draft: '', draftReasoning: '' })
      } catch (err) {
        if (ac !== controller) return
        if (ac.signal.aborted) {
          set({ status: 'idle' })
          return
        }
        const error = err instanceof Error ? err : new Error(String(err))
        set({ status: 'error', error })
        options.onError?.(error)
      } finally {
        if (ac === controller) controller = undefined
      }
    },
    stop() {
      controller?.abort()
    },
    setMessages(messages) {
      controller?.abort()
      controller = undefined
      set({ messages, status: 'idle', error: undefined, draft: '', draftReasoning: '', tools: [] })
    },
  }
}
