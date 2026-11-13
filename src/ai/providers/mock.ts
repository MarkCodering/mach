/**
 * A deterministic, scriptable model for tests, demos and offline development. No API key, no network.
 *
 * ```ts
 * const model = mockModel([
 *   { toolCalls: [{ name: 'get_weather', input: { city: 'Paris' } }] },
 *   (req) => `It is ${lastToolOutput(req)} in Paris.`,
 * ])
 * ```
 */
import { textOf } from '../model.js'
import type { FinishReason, Message, Model, ModelEvent, ModelRequest, Usage } from '../types.js'

export interface MockTurnSpec {
  text?: string
  reasoning?: string
  toolCalls?: { name: string; input: unknown; id?: string }[]
  finishReason?: FinishReason
  usage?: Usage
}

export type MockTurn = string | MockTurnSpec | ModelEvent[] | ((request: ModelRequest) => MockTurn | Promise<MockTurn>)

export interface MockModelOptions {
  /** Delay between streamed chunks, in ms (default 0). */
  delayMs?: number
  /** Split text into chunks of roughly this many characters (default: per word). */
  chunkSize?: number
  modelId?: string
}

export interface MockModel extends Model {
  /** Every request the model received, for assertions. */
  readonly calls: ModelRequest[]
}

export function mockModel(turns: MockTurn[] | ((request: ModelRequest, index: number) => MockTurn) = [], options: MockModelOptions = {}): MockModel {
  const calls: ModelRequest[] = []
  const { delayMs = 0, chunkSize } = options

  return {
    provider: 'mock',
    modelId: options.modelId ?? 'mock-1',
    calls,
    async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
      const index = calls.length
      calls.push(structuredClone({ ...request, signal: undefined }))
      let turn: MockTurn = typeof turns === 'function' ? turns(request, index) : (turns[index] ?? defaultTurn)
      while (typeof turn === 'function') turn = await turn(request)

      const sleep = async () => {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
        request.signal?.throwIfAborted()
      }

      if (Array.isArray(turn)) {
        for (const ev of turn) {
          await sleep()
          yield ev
        }
        return
      }

      const spec: MockTurnSpec = typeof turn === 'string' ? { text: turn } : turn
      request.signal?.throwIfAborted()
      if (spec.reasoning) {
        for (const chunk of chunks(spec.reasoning, chunkSize)) {
          await sleep()
          yield { type: 'reasoning-delta', text: chunk }
        }
        yield { type: 'reasoning', text: spec.reasoning, signature: 'mock-signature' }
      }
      if (spec.text) {
        for (const chunk of chunks(spec.text, chunkSize)) {
          await sleep()
          yield { type: 'text-delta', text: chunk }
        }
      }
      let n = 0
      for (const tc of spec.toolCalls ?? []) {
        await sleep()
        const id = tc.id ?? `call_${index}_${n++}`
        yield { type: 'tool-call-delta', id, name: tc.name, inputDelta: JSON.stringify(tc.input) }
        yield { type: 'tool-call', id, name: tc.name, input: tc.input }
      }
      const outTokens = Math.ceil(((spec.text?.length ?? 0) + (spec.reasoning?.length ?? 0)) / 4)
      yield {
        type: 'usage',
        usage: spec.usage ?? { inputTokens: estimateTokens(request.messages, request.system), outputTokens: outTokens },
      }
      yield { type: 'finish', reason: spec.finishReason ?? (spec.toolCalls?.length ? 'tool-calls' : 'stop') }
    },
  }
}

const defaultTurn: MockTurn = (req) => {
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')
  return `You said: ${lastUser ? textOf(lastUser.content) : ''}`
}

function* chunks(text: string, size?: number): Generator<string> {
  if (size && size > 0) {
    for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size)
    return
  }
  const re = /\S+\s*|\s+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) yield m[0]
}

function estimateTokens(messages: Message[], system?: string): number {
  let chars = system?.length ?? 0
  for (const m of messages) chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length
  return Math.ceil(chars / 4)
}

/** Helper for scripted turns: the output of the most recent tool result in the request. */
export function lastToolOutput(request: ModelRequest): unknown {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const m = request.messages[i]!
    if (m.role === 'tool') return m.content.at(-1)?.output
  }
  return undefined
}
