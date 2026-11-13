/**
 * Validation for chat payloads arriving over HTTP. Clients send conversation history;
 * we validate its shape strictly and, by default, refuse client-supplied `system` messages
 * so a browser cannot override your system prompt.
 */
import { s } from '../schema/index.js'
import type { Message } from './types.js'

const text = s.object({ type: s.literal('text'), text: s.string() })
const image = s.object({
  type: s.literal('image'),
  data: s.string().optional(),
  url: s.string({ format: 'uri' }).optional(),
  mediaType: s.string().optional(),
})
const reasoning = s.object({
  type: s.literal('reasoning'),
  text: s.string(),
  signature: s.string().optional(),
  redacted: s.string().optional(),
})
const toolCall = s.object({ type: s.literal('tool-call'), id: s.string({ max: 256 }), name: s.string({ max: 128 }), input: s.unknown() })
const providerPart = s.object({ type: s.literal('provider'), provider: s.string({ max: 64 }), data: s.unknown() })
const toolResult = s.object({
  type: s.literal('tool-result'),
  id: s.string({ max: 256 }),
  name: s.string({ max: 128 }),
  output: s.unknown(),
  isError: s.boolean().optional(),
})

const userMessage = s.object({ role: s.literal('user'), content: s.union([s.string(), s.array(s.union([text, image]))]) })
const assistantMessage = s.object({
  role: s.literal('assistant'),
  content: s.union([s.string(), s.array(s.union([text, reasoning, toolCall, providerPart]))]),
})
const toolMessage = s.object({ role: s.literal('tool'), content: s.array(toolResult) })
const systemMessage = s.object({ role: s.literal('system'), content: s.string() })

export interface ChatInputOptions {
  /** Maximum number of messages accepted (default 200). */
  maxMessages?: number
  /** Accept `system` role messages from the client (default false: they are rejected). */
  allowSystem?: boolean
}

export interface ChatInput {
  messages: Message[]
}

export class ChatInputError extends Error {
  constructor(message: string, readonly issues: { message: string; path: string }[] = []) {
    super(message)
    this.name = 'ChatInputError'
  }
}

/**
 * Accepts `{ messages: Message[] }` or `{ prompt: string }`.
 */
export function parseChatInput(body: unknown, options: ChatInputOptions = {}): ChatInput {
  const { maxMessages = 200, allowSystem = false } = options
  if (typeof body !== 'object' || body === null) throw new ChatInputError('Body must be a JSON object')
  const b = body as { messages?: unknown; prompt?: unknown }
  if (typeof b.prompt === 'string' && b.messages === undefined) {
    return { messages: [{ role: 'user', content: b.prompt }] }
  }
  if (!Array.isArray(b.messages)) throw new ChatInputError('Expected `messages` array or `prompt` string')
  if (b.messages.length === 0) throw new ChatInputError('`messages` must not be empty')
  if (b.messages.length > maxMessages) throw new ChatInputError(`Too many messages (max ${maxMessages})`)

  const schema = allowSystem
    ? s.union([userMessage, assistantMessage, toolMessage, systemMessage])
    : s.union([userMessage, assistantMessage, toolMessage])
  const messages: Message[] = []
  for (let i = 0; i < b.messages.length; i++) {
    const m = b.messages[i] as { role?: unknown }
    if (!allowSystem && m && typeof m === 'object' && m.role === 'system') {
      throw new ChatInputError(`messages[${i}]: system messages are not accepted from clients`)
    }
    const r = schema.safeParse(m)
    if (r.issues) {
      throw new ChatInputError(`messages[${i}] is not a valid message`, [{ message: 'Invalid message shape', path: `messages[${i}]` }])
    }
    messages.push(r.value as Message)
  }
  return { messages }
}
