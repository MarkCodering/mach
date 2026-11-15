import type { Context } from '../context.js'
import { HTTPException } from '../http-exception.js'
import type { RouteDocs } from '../mach.js'
import { ChatInputError, type ChatInputOptions, parseChatInput } from './http.js'
import { addUsage, MessageAccumulator, repairToolHistory, toMessages } from './model.js'
import type { Tool, ToolResult } from './tool.js'
import type {
  AssistantMessage,
  FinishReason,
  Message,
  Model,
  ModelRequest,
  ToolMessage,
  ToolResultPart,
  Usage,
} from './types.js'

/** `max-steps`: hit `maxSteps`. `budget`: hit `maxTotalTokens`. */
export type AgentFinishReason = FinishReason | 'max-steps' | 'budget'

/**
 * Events streamed by an agent run. Sent over SSE as `event: <type>` + `data: <json>`.
 */
export type AgentEvent =
  | { type: 'step-start'; step: number }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call-delta'; id: string; name: string; inputDelta: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; id: string; name: string; output: unknown; isError: boolean; durationMs: number }
  /** A message appended to the conversation. Persist these to continue the conversation later. */
  | { type: 'message'; message: AssistantMessage | ToolMessage }
  | { type: 'step-finish'; step: number; finishReason: FinishReason; usage: Usage }
  | { type: 'finish'; text: string; finishReason: AgentFinishReason; usage: Usage; steps: number }

export interface ToolCallInfo {
  id: string
  name: string
  input: unknown
}

export interface AgentOptions<Ctx = unknown> {
  model: Model
  /** System prompt, or a function of the run context. */
  system?: string | ((context: Ctx) => string | Promise<string>)
  tools?: Tool<any, any>[]
  /** Maximum model calls per run (default 10). */
  maxSteps?: number
  maxTokens?: number
  /** Provider-specific request fields (see `ModelRequest.providerOptions`). */
  providerOptions?: Record<string, unknown>
  /**
   * Gate tool execution (approvals, policy, rate limits). Return `false` or a string
   * (the reason) to deny; the model receives an error result instead.
   */
  beforeToolCall?: (call: ToolCallInfo, context: Ctx) => boolean | string | void | Promise<boolean | string | void>
  /**
   * Token budget for one run (input + output across all steps). When reached, the run
   * finishes with `finishReason: 'budget'` instead of calling the model again.
   */
  maxTotalTokens?: number
  /** Called after each step (usage accounting, logging, persistence). Awaited. */
  onStepFinish?: (step: StepInfo, context: Ctx) => void | Promise<void>
  /** Called once when the run finishes (not when it throws or is aborted). Awaited. */
  onFinish?: (result: AgentResult, context: Ctx) => void | Promise<void>
  /** HTTP options for `agent.handle(c)` / `app.agent(path, agent)`. */
  http?: ChatInputOptions & {
    /** Derive the run context from the request (e.g. the authenticated user). */
    context?: (c: Context) => Ctx | Promise<Ctx>
  }
}

export interface StepInfo {
  step: number
  finishReason: FinishReason
  /** Usage of this step's model call. */
  usage: Usage
  /** Cumulative usage of the run so far. */
  totalUsage: Usage
  /** Messages this step appended (assistant, and tool results if tools ran). */
  messages: Message[]
}

export interface AgentRunInput<Ctx = unknown> {
  messages: Message[]
  signal?: AbortSignal
  context?: Ctx
}

export interface AgentResult {
  text: string
  finishReason: AgentFinishReason
  usage: Usage
  steps: number
  /** Messages produced by this run (assistant + tool), in order. */
  messages: Message[]
}

/**
 * An LLM + tools loop: call the model, run requested tools in parallel, feed results back,
 * repeat until the model answers or `maxSteps` is reached.
 *
 * ```ts
 * const assistant = agent({ model: anthropic('claude-opus-5-5'), tools: [weather] })
 * app.agent('/chat', assistant)                 // streaming SSE endpoint
 * const { text } = await assistant.run('Weather in Paris?')
 * ```
 */
export function agent<Ctx = unknown>(options: AgentOptions<Ctx>): Agent<Ctx> {
  return new Agent(options)
}

export class Agent<Ctx = unknown> {
  readonly options: AgentOptions<Ctx>
  /** OpenAPI docs used by `app.agent()`. */
  readonly docs: RouteDocs = AGENT_DOCS
  readonly #tools: Map<string, Tool<any, any>>

  constructor(options: AgentOptions<Ctx>) {
    this.options = options
    this.#tools = new Map()
    for (const t of options.tools ?? []) {
      if (this.#tools.has(t.name)) throw new TypeError(`Duplicate tool name "${t.name}"`)
      this.#tools.set(t.name, t)
    }
  }

  get tools(): Tool<any, any>[] {
    return [...this.#tools.values()]
  }

  /** Run and stream events. */
  async *stream(input: string | Message[] | AgentRunInput<Ctx>): AsyncGenerator<AgentEvent, AgentResult> {
    const run: AgentRunInput<Ctx> =
      typeof input === 'string' || Array.isArray(input) ? { messages: toMessages(input) } : input
    const { model, maxSteps = 10, maxTokens, providerOptions, maxTotalTokens } = this.options
    if (!(maxSteps >= 1)) throw new RangeError('maxSteps must be >= 1')
    const context = run.context as Ctx

    // Internal controller so tools and the model stop when the run is abandoned.
    const ac = new AbortController()
    const onAbort = () => ac.abort(run.signal?.reason)
    if (run.signal?.aborted) ac.abort(run.signal.reason)
    else run.signal?.addEventListener('abort', onAbort, { once: true })
    const signal = ac.signal

    const system = typeof this.options.system === 'function' ? await this.options.system(context) : this.options.system
    const tools = this.tools.map((t) => t.spec)
    // Drop dangling tool calls (e.g. a run stopped mid-tool) so providers accept the history.
    const history: Message[] = [...repairToolHistory(run.messages)]
    const produced: Message[] = []
    let usage: Usage = { inputTokens: 0, outputTokens: 0 }
    let lastText = ''

    try {
      for (let step = 1; step <= maxSteps; step++) {
        signal.throwIfAborted()
        yield { type: 'step-start', step }

        const request: ModelRequest = { messages: history, signal }
        if (system !== undefined) request.system = system
        if (tools.length) request.tools = tools
        if (maxTokens !== undefined) request.maxTokens = maxTokens
        if (providerOptions) request.providerOptions = providerOptions

        const acc = new MessageAccumulator()
        for await (const ev of model.stream(request)) {
          acc.push(ev)
          switch (ev.type) {
            case 'text-delta':
            case 'reasoning-delta':
            case 'tool-call-delta':
              yield ev
              break
            case 'tool-call':
              yield { type: 'tool-call', id: ev.id, name: ev.name, input: ev.input }
              break
          }
        }
        usage = addUsage(usage, acc.usage)
        lastText = acc.text

        const runTools = acc.toolCalls.length > 0 && acc.finishReason === 'tool-calls'
        let assistant = acc.message
        if (!runTools && acc.toolCalls.length > 0 && Array.isArray(assistant.content)) {
          // Truncated/refused turn: drop unanswered tool calls so the history stays valid.
          assistant = { role: 'assistant', content: assistant.content.filter((p) => p.type !== 'tool-call') }
        }
        history.push(assistant)
        produced.push(assistant)
        yield { type: 'message', message: assistant }
        const stepMessages: Message[] = [assistant]

        if (runTools) {
          // Run all tool calls in parallel; stream results as they complete.
          const results: ToolResultPart[] = new Array(acc.toolCalls.length)
          const pending = new Map<number, Promise<{ i: number; result: ToolResult; durationMs: number }>>()
          acc.toolCalls.forEach((call, i) => {
            const started = performance.now()
            pending.set(
              i,
              this.#executeTool(call, context, signal).then((result) => ({ i, result, durationMs: performance.now() - started })),
            )
          })
          while (pending.size > 0) {
            const { i, result, durationMs } = await Promise.race(pending.values())
            pending.delete(i)
            const call = acc.toolCalls[i]!
            results[i] = { type: 'tool-result', id: call.id, name: call.name, output: result.output, isError: result.isError }
            yield {
              type: 'tool-result',
              id: call.id,
              name: call.name,
              output: result.output,
              isError: result.isError,
              durationMs: Math.round(durationMs),
            }
          }
          const toolMessage: ToolMessage = { role: 'tool', content: results }
          history.push(toolMessage)
          produced.push(toolMessage)
          stepMessages.push(toolMessage)
          yield { type: 'message', message: toolMessage }
        }

        yield { type: 'step-finish', step, finishReason: acc.finishReason, usage: acc.usage }
        await this.options.onStepFinish?.(
          { step, finishReason: acc.finishReason, usage: acc.usage, totalUsage: usage, messages: stepMessages },
          context,
        )

        let reason: AgentFinishReason | undefined
        if (!runTools) reason = acc.finishReason
        else if (maxTotalTokens !== undefined && usage.inputTokens + usage.outputTokens >= maxTotalTokens) reason = 'budget'
        else if (step === maxSteps) reason = 'max-steps'
        if (reason !== undefined) {
          const result: AgentResult = { text: lastText, finishReason: reason, usage, steps: step, messages: produced }
          await this.options.onFinish?.(result, context)
          yield { type: 'finish', text: lastText, finishReason: reason, usage, steps: step }
          return result
        }
      }
      throw new Error('unreachable: maxSteps must be >= 1')
    } finally {
      run.signal?.removeEventListener('abort', onAbort)
      if (!signal.aborted) ac.abort()
    }
  }

  /** Run to completion. */
  async run(input: string | Message[] | AgentRunInput<Ctx>): Promise<AgentResult> {
    const it = this.stream(input)
    while (true) {
      const r = await it.next()
      if (r.done) return r.value
    }
  }

  /** HTTP handler: JSON `{ messages }` in, SSE `AgentEvent`s out. Used by `app.agent(path, agent)`. */
  async handle(c: Context): Promise<Response> {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      throw new HTTPException(400, 'Malformed JSON body')
    }
    let messages: Message[]
    try {
      messages = parseChatInput(body, this.options.http).messages
    } catch (err) {
      if (err instanceof ChatInputError) throw new HTTPException(400, err.message, { details: { issues: err.issues } })
      throw err
    }
    const context = this.options.http?.context ? await this.options.http.context(c) : (undefined as Ctx)
    return c.sse(this.stream({ messages, signal: c.req.signal, context }))
  }

  async #executeTool(
    call: { id: string; name: string; input: unknown; inputError?: string },
    context: Ctx,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const t = this.#tools.get(call.name)
    if (!t) return { output: `Error: unknown tool "${call.name}"`, isError: true }
    if (call.inputError) return { output: `Error: ${call.inputError}`, isError: true }
    if (this.options.beforeToolCall) {
      const verdict = await this.options.beforeToolCall({ id: call.id, name: call.name, input: call.input }, context)
      if (verdict === false) return { output: 'Error: tool call was denied', isError: true }
      if (typeof verdict === 'string') return { output: `Error: tool call was denied: ${verdict}`, isError: true }
    }
    return t.execute(call.input, { signal, toolCallId: call.id, context })
  }
}

const AGENT_DOCS: RouteDocs = {
  summary: 'Chat with an agent',
  description: 'Send `{ messages }` (or `{ prompt }`). Streams agent events as Server-Sent Events: `event: <type>` + `data: <json>`.',
  tags: ['ai'],
  requestBody: {
    schema: {
      type: 'object',
      properties: {
        messages: { type: 'array', items: { type: 'object', properties: { role: { type: 'string', enum: ['user', 'assistant', 'tool'] } }, required: ['role'] } },
        prompt: { type: 'string' },
      },
    },
  },
  responses: { '200': { description: 'Stream of agent events', contentType: 'text/event-stream', schema: { type: 'string' } } },
}
