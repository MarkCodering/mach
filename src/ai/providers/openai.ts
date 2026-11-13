/**
 * OpenAI Chat Completions–compatible models (OpenAI, Azure OpenAI, Ollama, vLLM, LM Studio,
 * Groq, Together, OpenRouter, DeepSeek, ...). Raw `fetch`, zero dependencies.
 *
 * ```ts
 * import { openai } from 'machjs/ai/openai'
 * const local = openai('llama3.2', { baseURL: 'http://localhost:11434/v1', apiKey: 'ollama' })
 * ```
 */
import { parseSSE } from '../../stream/sse.js'
import { serializeToolOutput } from '../tool.js'
import { type FinishReason, type Message, type Model, type ModelEvent, ModelError, type ModelRequest, type Usage } from '../types.js'
import { env, parseJSONSafe, postStream, type ProviderHTTPOptions } from './shared.js'

export interface OpenAIOptions extends ProviderHTTPOptions {
  /** Defaults to `OPENAI_API_KEY`. Local servers usually accept any value. */
  apiKey?: string
  /** Defaults to `OPENAI_BASE_URL` or https://api.openai.com/v1 */
  baseURL?: string
  /** Name used in errors and `model.provider` (default "openai"). */
  name?: string
  /** Send `max_completion_tokens` instead of `max_tokens` (newer OpenAI models). Default false. */
  useMaxCompletionTokens?: boolean
}

export function openai(modelId: string, options: OpenAIOptions = {}): Model {
  const name = options.name ?? 'openai'
  return {
    provider: name,
    modelId,
    async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
      const apiKey = options.apiKey ?? env('OPENAI_API_KEY')
      const baseURL = (options.baseURL ?? env('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
      if (!apiKey && baseURL.includes('api.openai.com')) {
        throw new ModelError(name, 'Missing API key. Set OPENAI_API_KEY or pass { apiKey } to openai().')
      }
      const headers: Record<string, string> = {}
      if (apiKey) headers.authorization = `Bearer ${apiKey}`
      const body = buildOpenAIBody(modelId, options, request)
      const stream = await postStream(name, `${baseURL}/chat/completions`, headers, body, { ...options, signal: request.signal })
      yield* parseOpenAIStream(stream, name, request.signal)
    },
  }
}

/** @internal exported for tests */
export function buildOpenAIBody(modelId: string, options: OpenAIOptions, request: ModelRequest): Record<string, any> {
  const body: Record<string, any> = {
    model: modelId,
    stream: true,
    stream_options: { include_usage: true },
    messages: toOpenAIMessages(request.messages, request.system),
  }
  if (request.maxTokens !== undefined) body[options.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = request.maxTokens
  if (request.tools?.length) {
    body.tools = request.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }))
    if (request.toolChoice) body.tool_choice = request.toolChoice
  }
  if (request.providerOptions) Object.assign(body, request.providerOptions)
  return body
}

/** @internal exported for tests */
export function toOpenAIMessages(input: Message[], system?: string): Record<string, any>[] {
  const out: Record<string, any>[] = []
  if (system) out.push({ role: 'system', content: system })
  for (const m of input) {
    switch (m.role) {
      case 'system':
        out.push({ role: 'system', content: m.content })
        break
      case 'user':
        if (typeof m.content === 'string') out.push({ role: 'user', content: m.content })
        else {
          out.push({
            role: 'user',
            content: m.content.map((p) =>
              p.type === 'text'
                ? { type: 'text', text: p.text }
                : { type: 'image_url', image_url: { url: p.url ?? `data:${p.mediaType ?? 'image/png'};base64,${p.data}` } },
            ),
          })
        }
        break
      case 'assistant': {
        if (typeof m.content === 'string') {
          out.push({ role: 'assistant', content: m.content })
          break
        }
        let text = ''
        const toolCalls: Record<string, any>[] = []
        for (const p of m.content) {
          if (p.type === 'text') text += p.text
          else if (p.type === 'tool-call') {
            toolCalls.push({ id: p.id, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) } })
          }
        }
        out.push({ role: 'assistant', content: text || null, ...(toolCalls.length && { tool_calls: toolCalls }) })
        break
      }
      case 'tool':
        for (const r of m.content) out.push({ role: 'tool', tool_call_id: r.id, content: serializeToolOutput(r.output) })
        break
    }
  }
  return out
}

/** @internal exported for tests */
export async function* parseOpenAIStream(body: ReadableStream<Uint8Array>, name = 'openai', signal?: AbortSignal): AsyncGenerator<ModelEvent> {
  const calls = new Map<number, { id: string; name: string; args: string }>()
  let finish: string | undefined
  let usage: Usage | undefined

  for await (const ev of parseSSE(body, signal)) {
    if (ev.data === '[DONE]') break
    let chunk: any
    try {
      chunk = JSON.parse(ev.data)
    } catch {
      continue
    }
    if (chunk.error) throw new ModelError(name, chunk.error.message ?? 'Stream error', { body: chunk })
    if (chunk.usage) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        ...(chunk.usage.prompt_tokens_details?.cached_tokens && { cacheReadTokens: chunk.usage.prompt_tokens_details.cached_tokens }),
      }
    }
    const choice = chunk.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}
    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (typeof reasoning === 'string' && reasoning) yield { type: 'reasoning-delta', text: reasoning }
    if (typeof delta.content === 'string' && delta.content) yield { type: 'text-delta', text: delta.content }
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0
      let call = calls.get(idx)
      if (!call) calls.set(idx, (call = { id: tc.id ?? `call_${idx}`, name: '', args: '' }))
      if (tc.id) call.id = tc.id
      if (tc.function?.name) call.name += tc.function.name
      if (tc.function?.arguments) {
        call.args += tc.function.arguments
        yield { type: 'tool-call-delta', id: call.id, name: call.name, inputDelta: tc.function.arguments }
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason
  }

  for (const call of [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)) {
    const parsed = parseJSONSafe(call.args)
    yield parsed.ok
      ? { type: 'tool-call', id: call.id, name: call.name, input: parsed.value }
      : { type: 'tool-call', id: call.id, name: call.name, input: undefined, inputError: parsed.error }
  }
  if (usage) yield { type: 'usage', usage }
  yield { type: 'finish', reason: mapFinish(finish, calls.size > 0), ...(finish !== undefined && { rawReason: finish }) }
}

function mapFinish(reason: string | undefined, hasCalls: boolean): FinishReason {
  switch (reason) {
    case 'stop':
      // Some servers report "stop" even when they emitted tool calls.
      return hasCalls ? 'tool-calls' : 'stop'
    case 'tool_calls':
    case 'function_call':
      return 'tool-calls'
    case 'length':
      return 'length'
    case 'content_filter':
      return 'refusal'
    default:
      return hasCalls ? 'tool-calls' : 'other'
  }
}
