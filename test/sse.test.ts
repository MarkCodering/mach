import { describe, expect, test } from 'bun:test'
import { formatSSE, parseSSE, pushIterable, SSEMessage, sseStream } from '../src/stream/sse.ts'

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch))
      c.close()
    },
  })
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

describe('formatSSE', () => {
  test('fields and multi-line data', () => {
    expect(formatSSE({ data: 'a\nb\r\nc', event: 'x', id: '1', retry: 1000 })).toBe(
      'event: x\nid: 1\nretry: 1000\ndata: a\ndata: b\ndata: c\n\n',
    )
    expect(formatSSE({ data: { a: 1 } })).toBe('data: {"a":1}\n\n')
    expect(formatSSE({ data: 'x', event: 'evil\ninjected' })).toBe('event: evilinjected\ndata: x\n\n')
  })
})

describe('parseSSE', () => {
  test('parses events across arbitrary chunk boundaries', async () => {
    const events = await collect(
      parseSSE(streamOf('event: a\nda', 'ta: 1\n', '\n: comment\ndata: x\ndata: y\r', '\n\r\ndata:no-space\n\n', 'id: 9\ndata: last')),
    )
    expect(events).toEqual([
      { event: 'a', data: '1', id: undefined },
      { event: 'message', data: 'x\ny', id: undefined },
      { event: 'message', data: 'no-space', id: undefined },
      { event: 'message', data: 'last', id: '9' },
    ])
  })

  test('round-trips sseStream output', async () => {
    async function* src() {
      yield { type: 'delta', text: 'multi\nline' }
      yield new SSEMessage({ event: 'custom', data: 'raw', id: '7' })
    }
    const events = await collect(parseSSE(sseStream(src(), { heartbeat: 0 })))
    expect(events).toEqual([
      { event: 'delta', data: '{"type":"delta","text":"multi\\nline"}', id: undefined },
      { event: 'custom', data: 'raw', id: '7' },
    ])
  })

  test('cancels the source when the consumer stops early', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new TextEncoder().encode('data: x\n\n'))
      },
      cancel() {
        cancelled = true
      },
    })
    for await (const _ of parseSSE(body)) break
    expect(cancelled).toBe(true)
  })
})

describe('sseStream', () => {
  test('emits an error frame and closes when the source throws', async () => {
    async function* bad() {
      yield 'ok'
      throw new Error('internal detail')
    }
    const orig = console.error
    console.error = () => {}
    try {
      const text = await new Response(sseStream(bad(), { heartbeat: 0 })).text()
      expect(text).toBe('data: ok\n\nevent: error\ndata: {"type":"error","message":"Stream failed"}\n\n')
      expect(text).not.toContain('internal detail')
    } finally {
      console.error = orig
    }
  })

  test('stops the source on abort', async () => {
    let finalized = false
    async function* infinite() {
      try {
        while (true) {
          yield 'tick'
          await new Promise((r) => setTimeout(r, 1))
        }
      } finally {
        finalized = true
      }
    }
    const ac = new AbortController()
    const reader = sseStream(infinite(), { heartbeat: 0, signal: ac.signal }).getReader()
    await reader.read()
    ac.abort()
    await new Promise((r) => setTimeout(r, 10))
    expect(finalized).toBe(true)
  })

  test('backpressure: pulls lazily', async () => {
    let produced = 0
    async function* counter() {
      while (true) yield ++produced
    }
    const reader = sseStream(counter(), { heartbeat: 0 }).getReader()
    await reader.read()
    await new Promise((r) => setTimeout(r, 5))
    expect(produced).toBeLessThan(5)
    await reader.cancel()
  })
})

describe('pushIterable', () => {
  test('bridges push callbacks with errors propagated', async () => {
    const it = pushIterable<number>(async (push) => {
      await push(1)
      await push(2)
      throw new Error('done badly')
    })
    const got: number[] = []
    await expect(
      (async () => {
        for await (const x of it) got.push(x)
      })(),
    ).rejects.toThrow('done badly')
    expect(got).toEqual([1, 2])
  })
})
