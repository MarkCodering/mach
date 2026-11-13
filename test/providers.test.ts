import { describe, expect, test } from 'bun:test'
import { agent, generate, ModelError, tool, type Message, type ModelEvent } from '../src/ai/index.ts'
import { anthropic, buildRequestBody, toAnthropicMessages } from '../src/ai/providers/anthropic.ts'
import { openai, toOpenAIMessages } from '../src/ai/providers/openai.ts'
import { s } from '../src/index.ts'

function sse(events: [string | null, unknown][]): string {
  return events.map(([event, data]) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`).join('')
}

/** A fake fetch that records requests and replays canned SSE bodies, split into small chunks. */
function fakeFetch(bodies: (string | { status: number; body: string; headers?: Record<string, string> })[]) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
    requests.push({ url: String(url), headers, body: JSON.parse(String(init?.body)) })
    const next = bodies.shift()
    if (next === undefined) throw new Error('no more fake responses')
    if (typeof next !== 'string') return new Response(next.body, { status: next.status, headers: next.headers })
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < next.length; i += 7) c.enqueue(enc.encode(next.slice(i, i + 7)))
        c.close()
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  return { fn, requests }
}

async function events(it: AsyncIterable<ModelEvent>) {
  const out: ModelEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

const ANTHROPIC_TOOL_TURN = sse([
  ['message_start', { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 10 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Need weather.' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['ping', { type: 'ping' }],
  ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Let me check.' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ' "Paris"}' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 2 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } }],
  ['message_stop', { type: 'message_stop' }],
])

const ANTHROPIC_TEXT_TURN = sse([
  ['message_start', { type: 'message_start', message: { usage: { input_tokens: 80, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'It is 18C.' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } }],
  ['message_stop', { type: 'message_stop' }],
])

const weather = tool({
  name: 'get_weather',
  description: 'Weather',
  input: s.object({ city: s.string() }),
  run: ({ city }) => ({ city, tempC: 18 }),
})

describe('anthropic provider', () => {
  test('parses thinking, text, tool use, usage and stop reason', async () => {
    const { fn, requests } = fakeFetch([ANTHROPIC_TOOL_TURN])
    const model = anthropic('claude-opus-5-5', { apiKey: 'k', fetch: fn })
    const out = await events(model.stream({ messages: [{ role: 'user', content: 'Weather in Paris?' }], tools: [weather.spec] }))
    expect(out.filter((e) => e.type !== 'tool-call-delta')).toEqual([
      { type: 'reasoning-delta', text: 'Need weather.' },
      { type: 'reasoning', text: 'Need weather.', signature: 'sig123' },
      { type: 'text-delta', text: 'Let me check.' },
      { type: 'tool-call', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
      { type: 'usage', usage: { inputTokens: 50, outputTokens: 40, cacheReadTokens: 10 } },
      { type: 'finish', reason: 'tool-calls', rawReason: 'tool_use' },
    ])
    const req = requests[0]!
    expect(req.url).toBe('https://api.anthropic.com/v1/messages')
    expect(req.headers['x-api-key']).toBe('k')
    expect(req.headers['anthropic-version']).toBe('2026-10-21')
    expect(req.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01')
    expect(req.body).toMatchObject({
      model: 'claude-opus-5-5',
      stream: true,
      max_tokens: 64000,
      fallbacks: 'default',
      tools: [{ name: 'get_weather', description: 'Weather', input_schema: weather.spec.inputSchema, eager_input_streaming: true }],
    })
    expect(req.body.temperature).toBeUndefined()
  })

  test('full agent loop replays thinking blocks and tool results correctly', async () => {
    const { fn, requests } = fakeFetch([ANTHROPIC_TOOL_TURN, ANTHROPIC_TEXT_TURN])
    const a = agent({ model: anthropic('claude-opus-5-5', { apiKey: 'k', fetch: fn }), system: 'Be brief.', tools: [weather] })
    const result = await a.run('Weather in Paris?')
    expect(result.text).toBe('It is 18C.')
    expect(result.usage).toEqual({ inputTokens: 130, outputTokens: 46, cacheReadTokens: 10 })
    const second = requests[1]!.body
    expect(second.system).toBe('Be brief.')
    expect(second.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Weather in Paris?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Need weather.', signature: 'sig123' },
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"city":"Paris","tempC":18}' }] },
    ])
  })

  test('mid-stream fallback: drops tool calls before the boundary and replays per echo rules', async () => {
    const body = sse([
      ['message_start', { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'old' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_old', name: 'get_weather', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":"A"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } } }],
      ['content_block_stop', { type: 'content_block_stop', index: 2 }],
      ['content_block_start', { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'Hello' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 3 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }],
      ['message_stop', { type: 'message_stop' }],
    ])
    const { fn } = fakeFetch([body])
    const r = await generate(anthropic('claude-opus-5-5', { apiKey: 'k', fetch: fn }), 'hi')
    expect(r.toolCalls).toEqual([])
    expect(r.finishReason).toBe('stop')
    // On replay, thinking before the fallback block is omitted and the fallback block stays in place.
    const { messages } = toAnthropicMessages([{ role: 'user', content: 'hi' }, r.message])
    expect(messages[1]!.content).toEqual([
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } },
      { type: 'text', text: 'Hello' },
    ])
  })

  test('message mapping: system merge, images, consecutive roles, unsigned reasoning dropped', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'extra rules' },
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: 'AAAA', mediaType: 'image/jpeg' }] },
      { role: 'user', content: 'and this' },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'from another provider' }, { type: 'text', text: 'ok' }] },
    ]
    const { system, messages } = toAnthropicMessages(msgs, 'base')
    expect(system).toBe('base\n\nextra rules')
    expect(messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
          { type: 'text', text: 'and this' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ])
  })

  test('options: no fallbacks for other models, providerOptions merge, toolChoice none', () => {
    const body = buildRequestBody('claude-haiku-4-5', { eagerToolInput: false }, {
      messages: [{ role: 'user', content: 'x' }],
      tools: [weather.spec],
      toolChoice: 'none',
      maxTokens: 100,
      providerOptions: { output_config: { effort: 'low' } },
    })
    expect(body.fallbacks).toBeUndefined()
    expect(body.max_tokens).toBe(100)
    expect(body.tool_choice).toEqual({ type: 'none' })
    expect(body.tools[0].eager_input_streaming).toBeUndefined()
    expect(body.output_config).toEqual({ effort: 'low' })
  })

  test('HTTP errors: retries 529 then surfaces 400 messages; missing key is explicit', async () => {
    const { fn, requests } = fakeFetch([
      { status: 529, body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', headers: { 'retry-after': '0' } },
      ANTHROPIC_TEXT_TURN,
    ])
    const r = await generate(anthropic('claude-opus-5-5', { apiKey: 'k', fetch: fn }), 'x')
    expect(r.text).toBe('It is 18C.')
    expect(requests.length).toBe(2)

    const bad = fakeFetch([{ status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens too large"}}' }])
    const err = await generate(anthropic('claude-opus-5-5', { apiKey: 'k', fetch: bad.fn }), 'x').catch((e) => e)
    expect(err).toBeInstanceOf(ModelError)
    expect(err.message).toBe('[anthropic] HTTP 400: max_tokens too large')
    expect(err.status).toBe(400)
    expect(err.retryable).toBe(false)

    const prevKey = process.env.ANTHROPIC_API_KEY
    const prevTok = process.env.ANTHROPIC_AUTH_TOKEN
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN
    try {
      await expect(generate(anthropic(), 'x')).rejects.toThrow(/ANTHROPIC_API_KEY/)
    } finally {
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey
      if (prevTok !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = prevTok
    }
  })

  test('stream error events and truncated streams throw', async () => {
    const errBody = sse([['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]])
    await expect(generate(anthropic('m', { apiKey: 'k', fetch: fakeFetch([errBody]).fn }), 'x')).rejects.toThrow('Overloaded')
    const cut = sse([['message_start', { type: 'message_start', message: {} }]])
    await expect(generate(anthropic('m', { apiKey: 'k', fetch: fakeFetch([cut]).fn }), 'x')).rejects.toThrow(/before message_stop/)
  })

  test('invalid tool JSON becomes an inputError, not a crash', async () => {
    const body = sse([
      ['message_start', { type: 'message_start', message: {} }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'get_weather' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city": "Par' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
      ['message_stop', { type: 'message_stop' }],
    ])
    const out = await events(anthropic('m', { apiKey: 'k', fetch: fakeFetch([body]).fn }).stream({ messages: [] }))
    const call = out.find((e) => e.type === 'tool-call') as Extract<ModelEvent, { type: 'tool-call' }>
    expect(call.input).toBeUndefined()
    expect(call.inputError).toMatch(/not valid JSON/)
  })
})

describe('openai-compatible provider', () => {
  const chunk = (delta: unknown, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] })

  test('parses text, reasoning, streamed tool calls and usage', async () => {
    const body = sse([
      [null, chunk({ role: 'assistant', reasoning_content: 'hmm' })],
      [null, chunk({ content: 'Checking' })],
      [null, chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '' } }] })],
      [null, chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] })],
      [null, chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] })],
      [null, chunk({}, 'tool_calls')],
      [null, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } }],
      [null, '[DONE]'],
    ])
    const { fn, requests } = fakeFetch([body])
    const model = openai('gpt-test', { apiKey: 'sk', fetch: fn })
    const out = await events(model.stream({ messages: [{ role: 'user', content: 'hi' }], tools: [weather.spec], maxTokens: 50 }))
    expect(out.filter((e) => e.type !== 'tool-call-delta')).toEqual([
      { type: 'reasoning-delta', text: 'hmm' },
      { type: 'text-delta', text: 'Checking' },
      { type: 'tool-call', id: 'call_a', name: 'get_weather', input: { city: 'Paris' } },
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 7 } },
      { type: 'finish', reason: 'tool-calls', rawReason: 'tool_calls' },
    ])
    expect(requests[0]!.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(requests[0]!.headers.authorization).toBe('Bearer sk')
    expect(requests[0]!.body).toMatchObject({
      model: 'gpt-test',
      stream: true,
      max_tokens: 50,
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: weather.spec.inputSchema } }],
    })
  })

  test('works with local servers (no key) and maps history', async () => {
    const body = sse([[null, chunk({ content: 'hi' }, 'stop')], [null, '[DONE]']])
    const { fn, requests } = fakeFetch([body])
    const local = openai('llama3.2', { baseURL: 'http://localhost:11434/v1/', fetch: fn, name: 'ollama' })
    expect(local.provider).toBe('ollama')
    const r = await generate(local, 'hello')
    expect(r.text).toBe('hi')
    expect(requests[0]!.url).toBe('http://localhost:11434/v1/chat/completions')
    expect(requests[0]!.headers.authorization).toBeUndefined()

    expect(
      toOpenAIMessages(
        [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: [{ type: 'reasoning', text: 'x', signature: 's' }, { type: 'text', text: 'a' }, { type: 'tool-call', id: '1', name: 't', input: { a: 1 } }] },
          { role: 'tool', content: [{ type: 'tool-result', id: '1', name: 't', output: { ok: true } }] },
        ],
        'sys',
      ),
    ).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', tool_calls: [{ id: '1', type: 'function', function: { name: 't', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: '1', content: '{"ok":true}' },
    ])
  })
})
