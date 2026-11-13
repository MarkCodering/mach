import type {
  AssistantMessage,
  AssistantPart,
  FinishReason,
  Message,
  Model,
  ModelRequest,
  ToolCallPart,
  Usage,
} from './types.js'

export interface GenerateResult {
  text: string
  reasoning: string
  toolCalls: ToolCallPart[]
  finishReason: FinishReason
  usage: Usage
  /** The assistant message to append to history (includes reasoning blocks for replay). */
  message: AssistantMessage
}

/**
 * Consume a model stream into a single result.
 * ```ts
 * const { text } = await generate(model, { messages: [{ role: 'user', content: 'Hi' }] })
 * ```
 */
export async function generate(model: Model, request: ModelRequest | string): Promise<GenerateResult> {
  const req: ModelRequest = typeof request === 'string' ? { messages: [{ role: 'user', content: request }] } : request
  const acc = new MessageAccumulator()
  for await (const event of model.stream(req)) acc.push(event)
  return acc.result()
}

/** Collects model events into an assistant message. Used by `generate()` and the agent loop. */
export class MessageAccumulator {
  parts: AssistantPart[] = []
  text = ''
  reasoning = ''
  toolCalls: (ToolCallPart & { inputError?: string })[] = []
  usage: Usage = { inputTokens: 0, outputTokens: 0 }
  finishReason: FinishReason = 'other'
  rawReason: string | undefined
  #pendingText = ''

  push(event: import('./types.js').ModelEvent): void {
    switch (event.type) {
      case 'text-delta':
        this.text += event.text
        this.#pendingText += event.text
        break
      case 'reasoning-delta':
        this.reasoning += event.text
        break
      case 'reasoning':
        this.#flushText()
        this.parts.push({
          type: 'reasoning',
          text: event.text,
          ...(event.signature !== undefined && { signature: event.signature }),
          ...(event.redacted !== undefined && { redacted: event.redacted }),
        })
        break
      case 'tool-call': {
        this.#flushText()
        const part: ToolCallPart = { type: 'tool-call', id: event.id, name: event.name, input: event.input }
        this.parts.push(part)
        this.toolCalls.push(event.inputError ? { ...part, inputError: event.inputError } : part)
        break
      }
      case 'provider-part':
        this.#flushText()
        this.parts.push({ type: 'provider', provider: event.provider, data: event.data })
        break
      case 'usage':
        this.usage = addUsage(this.usage, event.usage)
        break
      case 'finish':
        this.#flushText()
        this.finishReason = event.reason
        this.rawReason = event.rawReason
        break
    }
  }

  #flushText(): void {
    if (this.#pendingText) {
      this.parts.push({ type: 'text', text: this.#pendingText })
      this.#pendingText = ''
    }
  }

  get message(): AssistantMessage {
    this.#flushText()
    return { role: 'assistant', content: this.parts.slice() }
  }

  result(): GenerateResult {
    const message = this.message
    return {
      text: this.text,
      reasoning: this.reasoning,
      toolCalls: this.toolCalls.map(({ inputError: _e, ...tc }) => tc),
      finishReason: this.finishReason,
      usage: this.usage,
      message,
    }
  }
}

export function addUsage(a: Usage, b: Usage): Usage {
  const out: Usage = { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens }
  const cr = (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0)
  const cw = (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0)
  if (cr) out.cacheReadTokens = cr
  if (cw) out.cacheWriteTokens = cw
  return out
}

/** Normalise `string | Message[]` input. */
export function toMessages(input: string | Message[]): Message[] {
  return typeof input === 'string' ? [{ role: 'user', content: input }] : input
}

/** Plain text of a message's content. */
export function textOf(content: Message['content']): string {
  if (typeof content === 'string') return content
  let out = ''
  for (const p of content) if (p.type === 'text') out += p.text
  return out
}

/**
 * Make a conversation valid for providers: drop tool calls that never got a result (e.g. the
 * user stopped a run mid-tool) and tool results whose call is missing. Returns the input
 * array unchanged when nothing needs fixing.
 */
export function repairToolHistory(messages: Message[]): Message[] {
  let changed = false
  const out: Message[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role === 'assistant' && Array.isArray(m.content) && m.content.some((p) => p.type === 'tool-call')) {
      const next = messages[i + 1]
      const answered = new Set(next?.role === 'tool' ? next.content.map((r) => r.id) : [])
      const content = m.content.filter((p) => p.type !== 'tool-call' || answered.has(p.id))
      if (content.length !== m.content.length) changed = true
      if (content.length > 0) out.push(content.length === m.content.length ? m : { role: 'assistant', content })
      else changed = true
      continue
    }
    if (m.role === 'tool') {
      const prev = out.at(-1)
      const called = new Set(
        prev?.role === 'assistant' && Array.isArray(prev.content)
          ? prev.content.flatMap((p) => (p.type === 'tool-call' ? [p.id] : []))
          : [],
      )
      const content = m.content.filter((r) => called.has(r.id))
      if (content.length !== m.content.length) changed = true
      if (content.length > 0) out.push(content.length === m.content.length ? m : { role: 'tool', content })
      continue
    }
    out.push(m)
  }
  return changed ? out : messages
}
