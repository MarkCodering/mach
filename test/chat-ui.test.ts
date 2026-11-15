import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { agent, repairToolHistory, tool, type Message } from '../src/ai/index.ts'
import { mockModel } from '../src/ai/providers/mock.ts'
import { type ChatState, createChat } from '../src/client.ts'
import { Mach, s } from '../src/index.ts'
import { useChat } from '../src/react.ts'

const weather = tool({
  name: 'get_weather',
  description: 'Weather',
  input: s.object({ city: s.string() }),
  run: ({ city }) => ({ city, tempC: 20 }),
})

function appFetch(app: Mach): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(app.fetch(new Request(new URL(String(url), 'http://localhost'), init)))) as typeof fetch
}

describe('createChat store', () => {
  test('streams a run into immutable snapshots', async () => {
    const model = mockModel([{ text: 'Checking. ', toolCalls: [{ name: 'get_weather', input: { city: 'Rome' } }] }, 'Sunny, 20C.'])
    const app = new Mach().agent('/chat', agent({ model, tools: [weather] }))
    const snapshots: ChatState[] = []
    let finished = ''
    const chat = createChat({ api: '/chat', fetch: appFetch(app), onFinish: (ev) => (finished = ev.text) })
    chat.subscribe(() => snapshots.push(chat.getState()))

    await chat.send('Weather in Rome?')
    const end = chat.getState()
    expect(end.status).toBe('idle')
    expect(end.draft).toBe('')
    expect(end.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(end.tools).toEqual([{ id: 'call_0_0', name: 'get_weather', input: { city: 'Rome' }, status: 'done', output: { city: 'Rome', tempC: 20 } }])
    expect(finished).toBe('Sunny, 20C.')

    // Snapshots are distinct objects (required by useSyncExternalStore) and show streaming progress.
    expect(new Set(snapshots).size).toBe(snapshots.length)
    expect(snapshots[0]!.status).toBe('streaming')
    expect(snapshots.some((st) => st.draft === 'Checking. ')).toBe(true)
    expect(snapshots.some((st) => st.tools[0]?.status === 'running')).toBe(true)

    // The next turn sends the whole conversation back.
    await chat.send('And tomorrow?')
    expect(model.calls.at(-1)!.messages.length).toBe(5)
  })

  test('errors surface in state and onError', async () => {
    const app = new Mach().post('/chat', (c) => c.json({ error: 'nope' }, 401))
    let seen: Error | undefined
    const chat = createChat({ api: '/chat', fetch: appFetch(app), onError: (e) => (seen = e) })
    await chat.send('hi')
    expect(chat.getState().status).toBe('error')
    expect(chat.getState().error?.message).toContain('401')
    expect(seen).toBeDefined()
  })

  test('stop() aborts and returns to idle; setMessages resets', async () => {
    const app = new Mach().agent('/chat', agent({ model: mockModel(['a b c d e f g h i j k l m n o p'], { delayMs: 10 }) }))
    const chat = createChat({ api: '/chat', fetch: appFetch(app) })
    const run = chat.send('go')
    await new Promise((r) => setTimeout(r, 35))
    chat.stop()
    await run
    expect(chat.getState().status).toBe('idle')
    chat.setMessages([])
    expect(chat.getState().messages).toEqual([])
  })
})

describe('repairToolHistory', () => {
  test('drops unanswered tool calls and orphan results', () => {
    const history: Message[] = [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: [{ type: 'text', text: 'Let me check' }, { type: 'tool-call', id: 'a', name: 't', input: {} }, { type: 'tool-call', id: 'b', name: 't', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', id: 'a', name: 't', output: 1 }, { type: 'tool-result', id: 'zzz', name: 't', output: 2 }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 't', input: {} }] },
    ]
    expect(repairToolHistory(history)).toEqual([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: [{ type: 'text', text: 'Let me check' }, { type: 'tool-call', id: 'a', name: 't', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', id: 'a', name: 't', output: 1 }] },
    ])
    const valid: Message[] = [{ role: 'user', content: 'hi' }]
    expect(repairToolHistory(valid)).toBe(valid)
  })

  test('the agent repairs history from clients before calling the model', async () => {
    const model = mockModel(['ok'])
    await agent({ model }).run([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'a', name: 't', input: {} }] },
      { role: 'user', content: 'never mind' },
    ])
    expect(model.calls[0]!.messages).toEqual([
      { role: 'user', content: 'x' },
      { role: 'user', content: 'never mind' },
    ])
  })
})

describe('useChat (React)', () => {
  test('renders initial state on the server', () => {
    function Chat() {
      const { messages, status } = useChat({ api: '/chat', initialMessages: [{ role: 'user', content: 'Hello from history' }] })
      return createElement('div', { 'data-status': status }, messages.map((m, i) => createElement('p', { key: i }, String(m.content))))
    }
    const html = renderToString(createElement(Chat))
    expect(html).toContain('Hello from history')
    expect(html).toContain('data-status="idle"')
  })
})
