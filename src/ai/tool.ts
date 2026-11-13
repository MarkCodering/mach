import { formatPath } from '../http-exception.js'
import { type InferOutput, type JSONSchema, type StandardSchemaV1, toJSONSchema } from '../schema/standard.js'
import type { ToolSpec } from './types.js'

export interface ToolContext {
  /** Aborted when the request/agent run is cancelled. */
  signal: AbortSignal
  /** The id of this tool call. */
  toolCallId: string
  /** Arbitrary per-run context passed to `agent.stream({ context })` (user id, db handle, ...). */
  context: unknown
}

export interface ToolDefinition<S extends StandardSchemaV1, R> {
  name: string
  description: string
  /** Input schema: Mach `s`, Zod 4.2+, Valibot, ArkType, or any Standard Schema with JSON Schema support. */
  input: S
  /** Override the JSON Schema sent to models (needed only for schema libraries without JSON Schema export). */
  jsonSchema?: JSONSchema
  run: (input: InferOutput<S>, ctx: ToolContext) => R | Promise<R>
}

export interface ToolResult {
  output: unknown
  isError: boolean
}

export interface Tool<S extends StandardSchemaV1 = StandardSchemaV1, R = unknown> {
  readonly name: string
  readonly description: string
  readonly input: S
  readonly spec: ToolSpec
  /** Call the tool directly (validated, typed). Throws on invalid input. */
  run(input: InferOutput<S>, ctx?: Partial<ToolContext>): Promise<R>
  /** Validate raw model output and run. Never throws: errors become `{ isError: true }` results for the model. */
  execute(rawInput: unknown, ctx: ToolContext): Promise<ToolResult>
}

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * Define a tool once; use it in agents, expose it over MCP, or call it from routes.
 *
 * ```ts
 * const weather = tool({
 *   name: 'get_weather',
 *   description: 'Current weather for a city',
 *   input: s.object({ city: s.string() }),
 *   run: async ({ city }) => ({ city, tempC: 21 }),
 * })
 * ```
 */
export function tool<S extends StandardSchemaV1, R>(def: ToolDefinition<S, R>): Tool<S, Awaited<R>> {
  if (!NAME_RE.test(def.name)) {
    throw new TypeError(`Tool name "${def.name}" is invalid. Use 1-64 letters, digits, "_" or "-".`)
  }
  const inputSchema = def.jsonSchema ?? toJSONSchema(def.input)
  if (!inputSchema) {
    throw new TypeError(
      `Tool "${def.name}": cannot derive a JSON Schema from its input schema. ` +
        'Use Mach `s`, Zod >= 4.2, or pass `jsonSchema` explicitly.',
    )
  }
  const spec: ToolSpec = { name: def.name, description: def.description, inputSchema }

  const validateInput = async (raw: unknown) => {
    let result = def.input['~standard'].validate(raw)
    if (result instanceof Promise) result = await result
    return result as StandardSchemaV1.Result<InferOutput<S>>
  }

  const t: Tool<S, Awaited<R>> = {
    name: def.name,
    description: def.description,
    input: def.input,
    spec,
    async run(input, ctx = {}): Promise<Awaited<R>> {
      const result = await validateInput(input)
      if (result.issues) throw new TypeError(`Invalid input for tool "${def.name}": ${describeIssues(result.issues)}`)
      const out = await def.run(result.value, {
        signal: ctx.signal ?? new AbortController().signal,
        toolCallId: ctx.toolCallId ?? 'direct',
        context: ctx.context,
      })
      return out as Awaited<R>
    },
    async execute(rawInput, ctx) {
      try {
        const result = await validateInput(rawInput)
        if (result.issues) {
          return { output: `Invalid input: ${describeIssues(result.issues)}`, isError: true }
        }
        const output = await def.run(result.value, ctx)
        return { output: output === undefined ? null : output, isError: false }
      } catch (err) {
        if (ctx.signal.aborted) throw err
        // Report the message to the model so it can recover, but not the stack.
        const message = err instanceof Error ? err.message : String(err)
        return { output: `Error: ${message}`, isError: true }
      }
    },
  }
  return t
}

function describeIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>): string {
  return issues.map((i) => (i.path?.length ? `${formatPath(i.path)}: ${i.message}` : i.message)).join('; ')
}

/** Serialise a tool output for a model: strings as-is, everything else as JSON. */
export function serializeToolOutput(output: unknown): string {
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output) ?? 'null'
  } catch {
    return String(output)
  }
}
