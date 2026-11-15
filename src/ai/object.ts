import { formatPath } from '../http-exception.js'
import { type InferOutput, type JSONSchema, type StandardSchemaV1, toJSONSchema } from '../schema/standard.js'
import { addUsage, MessageAccumulator, toMessages } from './model.js'
import type { FinishReason, Message, Model, ModelRequest, Usage } from './types.js'

export interface GenerateObjectOptions<S extends StandardSchemaV1> {
  /** Schema for the result: Mach `s`, Zod ≥ 4.2, Valibot, ArkType... */
  schema: S
  /** Override the JSON Schema sent to the model (for schema libraries without JSON Schema export). */
  jsonSchema?: JSONSchema
  /** Name for the schema (some providers require one). */
  name?: string
  prompt?: string
  messages?: Message[]
  system?: string
  maxTokens?: number
  providerOptions?: Record<string, unknown>
  signal?: AbortSignal
  /** Extra attempts when the output is not valid JSON or fails validation (default 1). */
  maxRetries?: number
}

export interface GenerateObjectResult<T> {
  object: T
  usage: Usage
  finishReason: FinishReason
  /** Model calls made (1 + retries used). */
  attempts: number
  /** The raw text of the accepted response. */
  text: string
}

/** Thrown when the model's output cannot be turned into a valid object. */
export class ObjectGenerationError extends Error {
  constructor(
    message: string,
    readonly text: string,
    readonly finishReason: FinishReason,
    readonly issues: { message: string; path: string }[] = [],
  ) {
    super(message)
    this.name = 'ObjectGenerationError'
  }
}

/**
 * Generate a typed, validated object. Uses the provider's native structured output where
 * available, then validates with your schema and retries once with the errors if needed.
 *
 * ```ts
 * const { object } = await generateObject(model, {
 *   schema: s.object({ title: s.string(), tags: s.array(s.string()) }),
 *   prompt: 'Suggest a blog post about Web Standards',
 * })
 * object.tags // string[]
 * ```
 */
export async function generateObject<S extends StandardSchemaV1>(
  model: Model,
  options: GenerateObjectOptions<S>,
): Promise<GenerateObjectResult<InferOutput<S>>> {
  const jsonSchema = options.jsonSchema ?? toJSONSchema(options.schema)
  if (!jsonSchema) {
    throw new TypeError('generateObject: cannot derive a JSON Schema from `schema`. Pass `jsonSchema` explicitly.')
  }
  if (!options.prompt && !options.messages?.length) throw new TypeError('generateObject: pass `prompt` or `messages`')

  const instruction =
    'Respond with a single JSON value that matches this JSON Schema. Output only the JSON, with no prose and no code fences.\n' +
    JSON.stringify(jsonSchema)
  const messages: Message[] = [...(options.messages ?? []), ...(options.prompt ? toMessages(options.prompt) : [])]
  const maxRetries = options.maxRetries ?? 1
  let usage: Usage = { inputTokens: 0, outputTokens: 0 }

  for (let attempt = 1; ; attempt++) {
    const request: ModelRequest = {
      messages,
      system: options.system ? `${options.system}\n\n${instruction}` : instruction,
      responseFormat: { type: 'json', schema: jsonSchema, ...(options.name && { name: options.name }) },
    }
    if (options.maxTokens !== undefined) request.maxTokens = options.maxTokens
    if (options.providerOptions) request.providerOptions = options.providerOptions
    if (options.signal) request.signal = options.signal

    const acc = new MessageAccumulator()
    for await (const ev of model.stream(request)) acc.push(ev)
    usage = addUsage(usage, acc.usage)
    const text = acc.text

    if (acc.finishReason === 'refusal') throw new ObjectGenerationError('The model declined to answer', text, 'refusal')
    if (acc.finishReason === 'length') {
      throw new ObjectGenerationError('Output was truncated (max tokens reached); increase maxTokens', text, 'length')
    }

    let problem: string
    let issues: { message: string; path: string }[] = []
    const parsed = extractJSON(text)
    if (parsed.ok) {
      let result = options.schema['~standard'].validate(parsed.value)
      if (result instanceof Promise) result = await result
      if (!result.issues) {
        return { object: result.value as InferOutput<S>, usage, finishReason: acc.finishReason, attempts: attempt, text }
      }
      issues = result.issues.map((i) => ({ message: i.message, path: formatPath(i.path) }))
      problem = `It did not match the schema: ${issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ')}`
    } else {
      problem = 'It was not valid JSON.'
    }

    if (attempt > maxRetries) {
      throw new ObjectGenerationError(`Model output is not a valid object. ${problem}`, text, acc.finishReason, issues)
    }
    messages.push({ role: 'assistant', content: text || '(empty response)' })
    messages.push({ role: 'user', content: `Your previous response was invalid. ${problem} Reply again with corrected JSON only.` })
  }
}

/** Parse JSON from model text, tolerating code fences and surrounding prose. */
export function extractJSON(text: string): { ok: true; value: unknown } | { ok: false } {
  const candidates: string[] = [text.trim()]
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence) candidates.push(fence[1]!.trim())
  const firstObj = text.indexOf('{')
  const firstArr = text.indexOf('[')
  const start = firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr)
  if (start !== -1) {
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
    if (end > start) candidates.push(text.slice(start, end + 1))
  }
  for (const c of candidates) {
    if (!c) continue
    try {
      return { ok: true, value: JSON.parse(c) }
    } catch {
      /* try next */
    }
  }
  return { ok: false }
}
