import { describe, expect, test } from 'bun:test'
import { extractJSON, generateObject, ObjectGenerationError } from '../src/ai/index.ts'
import { buildRequestBody, toClaudeSchema } from '../src/ai/providers/anthropic.ts'
import { mockModel } from '../src/ai/providers/mock.ts'
import { buildOpenAIBody } from '../src/ai/providers/openai.ts'
import { s } from '../src/index.ts'

const Post = s.object({
  title: s.string({ min: 3 }),
  tags: s.array(s.string(), { max: 3 }),
  draft: s.boolean().default(true),
})

describe('generateObject', () => {
  test('returns a typed, validated object and sends the schema', async () => {
    const model = mockModel(['{"title":"Web Standards","tags":["web"]}'])
    const r = await generateObject(model, { schema: Post, prompt: 'Suggest a post', system: 'Be terse.' })
    expect(r.object).toEqual({ title: 'Web Standards', tags: ['web'], draft: true })
    const title: string = r.object.title
    expect(title).toBe('Web Standards')
    expect(r.attempts).toBe(1)
    const req = model.calls[0]!
    expect(req.responseFormat).toEqual({ type: 'json', schema: Post.toJSONSchema() })
    expect(req.system).toStartWith('Be terse.\n\nRespond with a single JSON value')
  })

  test('tolerates code fences and prose', async () => {
    const r = await generateObject(mockModel(['Sure!\n```json\n{"title":"Hello","tags":[]}\n```']), { schema: Post, prompt: 'x' })
    expect(r.object.title).toBe('Hello')
  })

  test('retries once with validation feedback', async () => {
    const model = mockModel(['{"title":"no","tags":[]}', '{"title":"Fixed title","tags":[]}'])
    const r = await generateObject(model, { schema: Post, prompt: 'x' })
    expect(r.attempts).toBe(2)
    expect(r.object.title).toBe('Fixed title')
    const retry = model.calls[1]!.messages
    expect(retry.at(-2)).toEqual({ role: 'assistant', content: '{"title":"no","tags":[]}' })
    expect(retry.at(-1)?.content).toContain('title: Must be at least 3 characters')
  })

  test('throws ObjectGenerationError after retries, on refusal and on truncation', async () => {
    const bad = generateObject(mockModel(['not json', 'still not json']), { schema: Post, prompt: 'x' })
    await expect(bad).rejects.toBeInstanceOf(ObjectGenerationError)
    await expect(generateObject(mockModel(['{}']), { schema: Post, prompt: 'x', maxRetries: 0 })).rejects.toThrow(/did not match/)
    await expect(generateObject(mockModel([{ text: '', finishReason: 'refusal' }]), { schema: Post, prompt: 'x' })).rejects.toThrow(
      /declined/,
    )
    await expect(generateObject(mockModel([{ text: '{"ti', finishReason: 'length' }]), { schema: Post, prompt: 'x' })).rejects.toThrow(
      /truncated/,
    )
  })

  test('requires a prompt and a JSON-Schema-capable schema', async () => {
    await expect(generateObject(mockModel(), { schema: Post })).rejects.toThrow(/prompt/)
    const opaque = { '~standard': { version: 1 as const, vendor: 'x', validate: (v: unknown) => ({ value: v }) } }
    await expect(generateObject(mockModel(), { schema: opaque, prompt: 'x' })).rejects.toThrow(/JSON Schema/)
  })
})

describe('provider structured output mapping', () => {
  const responseFormat = { type: 'json' as const, schema: Post.toJSONSchema(), name: 'post' }

  test('anthropic: output_config.format, merged with caller output_config', () => {
    const body = buildRequestBody('claude-opus-5-5', {}, {
      messages: [{ role: 'user', content: 'x' }],
      responseFormat,
      providerOptions: { output_config: { effort: 'low' } },
    })
    expect(body.output_config).toEqual({
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            draft: { type: 'boolean' },
          },
          required: ['title', 'tags'],
          additionalProperties: false,
        },
      },
    })
  })

  test('anthropic schema adaptation: nullable → anyOf, records rejected', () => {
    expect(toClaudeSchema(s.object({ a: s.string().nullable() }).toJSONSchema())).toEqual({
      type: 'object',
      properties: { a: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
      required: ['a'],
      additionalProperties: false,
    })
    expect(() => toClaudeSchema(s.record(s.number()).toJSONSchema())).toThrow(/record/)
  })

  test('openai: response_format json_schema', () => {
    const body = buildOpenAIBody('gpt-test', {}, { messages: [{ role: 'user', content: 'x' }], responseFormat })
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'post', schema: Post.toJSONSchema(), strict: false },
    })
  })
})

describe('extractJSON', () => {
  test('cases', () => {
    expect(extractJSON('[1,2]')).toEqual({ ok: true, value: [1, 2] })
    expect(extractJSON('Here: {"a":1} thanks')).toEqual({ ok: true, value: { a: 1 } })
    expect(extractJSON('nothing here')).toEqual({ ok: false })
  })
})
