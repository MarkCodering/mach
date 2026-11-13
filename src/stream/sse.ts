/**
 * Server-Sent Events: a writer that turns async iterables into SSE byte streams,
 * and a spec-compliant parser that LLM provider adapters and clients reuse.
 */

const encoder = /* @__PURE__ */ new TextEncoder()

export interface SSEFields {
  data: unknown
  event?: string
  id?: string
  retry?: number
}

/** An explicit SSE message. Yield one from a stream to control `event`/`id`/`retry` exactly. */
export class SSEMessage implements SSEFields {
  readonly data: unknown
  readonly event: string | undefined
  readonly id: string | undefined
  readonly retry: number | undefined
  constructor(fields: SSEFields) {
    this.data = fields.data
    this.event = fields.event
    this.id = fields.id
    this.retry = fields.retry
  }
}

/** An SSE comment line (`: text`). Ignored by clients; useful for keep-alives and debugging. */
export class SSEComment {
  constructor(readonly text: string) {}
}

export const sse = {
  message: (fields: SSEFields): SSEMessage => new SSEMessage(fields),
}

/** Serialize one SSE frame. Strings are sent raw; anything else is JSON encoded. */
export function formatSSE(fields: SSEFields): string {
  let out = ''
  if (fields.event !== undefined) out += `event: ${stripNewlines(fields.event)}\n`
  if (fields.id !== undefined) out += `id: ${stripNewlines(fields.id)}\n`
  if (fields.retry !== undefined) out += `retry: ${Math.floor(fields.retry)}\n`
  const data = typeof fields.data === 'string' ? fields.data : JSON.stringify(fields.data ?? null)
  // Each line of data gets its own "data:" field (spec). Normalise CRLF/CR.
  let start = 0
  for (let i = 0; i <= data.length; i++) {
    const c = i < data.length ? data.charCodeAt(i) : -1
    if (c === -1 || c === 10 || c === 13) {
      out += `data: ${data.slice(start, i)}\n`
      if (c === 13 && data.charCodeAt(i + 1) === 10) i++
      start = i + 1
    }
  }
  return `${out}\n`
}

function stripNewlines(s: string): string {
  return s.replace(/[\r\n]/g, '')
}

/**
 * Convert any yielded value into an SSE frame:
 * - `SSEMessage` → as specified
 * - string → `data: <string>`
 * - object with a string `type` → `event: <type>`, `data: <json>` (this is how agent events are sent)
 * - anything else → `data: <json>`
 */
export function toSSEFrame(item: unknown): string {
  if (item instanceof SSEMessage) return formatSSE(item)
  if (item instanceof SSEComment) return `: ${stripNewlines(item.text)}\n\n`
  if (typeof item === 'string') return formatSSE({ data: item })
  if (item !== null && typeof item === 'object' && typeof (item as { type?: unknown }).type === 'string') {
    return formatSSE({ event: (item as { type: string }).type, data: item })
  }
  return formatSSE({ data: item })
}

export interface SSEStreamOptions {
  /** Send a `: ping` comment every N ms to keep proxies from closing idle connections. Default 15000. 0 disables. */
  heartbeat?: number
  /** Aborts iteration (e.g. the request's signal for client disconnects). */
  signal?: AbortSignal
  /** Called when the source throws. Return a value to emit as a final frame (default: `event: error`). */
  onError?: (err: unknown) => unknown
}

/**
 * Turn an async iterable into an SSE byte stream. Pull-based, so a slow client
 * applies backpressure all the way to the producer (e.g. the LLM stream).
 */
export function sseStream(source: AsyncIterable<unknown>, options: SSEStreamOptions = {}): ReadableStream<Uint8Array> {
  const { heartbeat = 15000, signal, onError } = options
  let iterator: AsyncIterator<unknown> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let closed = false

  const cleanup = () => {
    closed = true
    if (timer) clearInterval(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  const onAbort = () => {
    cleanup()
    void iterator?.return?.()
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      iterator = source[Symbol.asyncIterator]()
      if (signal) {
        if (signal.aborted) {
          onAbort()
          controller.close()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      if (heartbeat > 0) {
        timer = setInterval(() => {
          if (closed) return
          try {
            controller.enqueue(encoder.encode(': ping\n\n'))
          } catch {
            cleanup()
          }
        }, heartbeat)
        // Do not keep the process alive just for heartbeats.
        ;(timer as { unref?: () => void }).unref?.()
      }
    },
    async pull(controller) {
      if (closed) return
      try {
        const { value, done } = await iterator!.next()
        if (closed) return
        if (done) {
          cleanup()
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(toSSEFrame(value)))
      } catch (err) {
        if (closed) return
        cleanup()
        const frame = onError ? onError(err) : defaultErrorFrame(err)
        if (frame !== undefined) controller.enqueue(encoder.encode(toSSEFrame(frame)))
        controller.close()
      }
    },
    cancel() {
      cleanup()
      return iterator?.return?.().then(() => undefined)
    },
  })
}

function defaultErrorFrame(err: unknown): unknown {
  if (isAbortError(err)) return undefined
  // Never leak internals (stack traces, upstream bodies) to clients by default.
  console.error('[mach] stream error:', err)
  return new SSEMessage({ event: 'error', data: { type: 'error', message: 'Stream failed' } })
}

export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && ((err as { name?: string }).name === 'AbortError' || (err as { name?: string }).name === 'TimeoutError')
  )
}

/** A push-style writer for imperative streaming (`c.sse(async (s) => { await s.write(...) })`). */
export interface SSEWriter {
  write(item: unknown): Promise<void>
  /** Write an SSE comment line (ignored by clients). */
  comment(text: string): Promise<void>
  /** Aborted when the client disconnects. The stream ends when your callback returns. */
  readonly signal: AbortSignal
}

/** Bridge a push-style callback into an async iterable with bounded buffering. */
export function pushIterable<T>(
  run: (push: (item: T) => Promise<void>, signal: AbortSignal) => Promise<void> | void,
  parentSignal?: AbortSignal,
  highWaterMark = 16,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const ac = new AbortController()
      const forward = () => ac.abort(parentSignal?.reason)
      if (parentSignal) {
        if (parentSignal.aborted) ac.abort(parentSignal.reason)
        else parentSignal.addEventListener('abort', forward, { once: true })
      }
      const buffer: T[] = []
      let done = false
      let error: unknown
      let wake: (() => void) | null = null
      let drained: (() => void) | null = null

      const notify = () => {
        const w = wake
        wake = null
        w?.()
      }
      const push = async (item: T) => {
        if (done || ac.signal.aborted) throw new DOMException('Stream closed', 'AbortError')
        buffer.push(item)
        notify()
        if (buffer.length >= highWaterMark) await new Promise<void>((r) => (drained = r))
      }
      Promise.resolve()
        .then(() => run(push, ac.signal))
        .then(
          () => {
            done = true
            notify()
          },
          (err) => {
            error = err
            done = true
            notify()
          },
        )

      return {
        async next(): Promise<IteratorResult<T>> {
          while (true) {
            if (buffer.length > 0) {
              const value = buffer.shift()!
              if (drained && buffer.length < highWaterMark) {
                const d = drained
                drained = null
                d()
              }
              return { value, done: false }
            }
            if (done) {
              parentSignal?.removeEventListener('abort', forward)
              if (error !== undefined) {
                const e = error
                error = undefined
                throw e
              }
              return { value: undefined as never, done: true }
            }
            await new Promise<void>((r) => (wake = r))
          }
        },
        async return(): Promise<IteratorResult<T>> {
          done = true
          ac.abort()
          parentSignal?.removeEventListener('abort', forward)
          const d = drained
          drained = null
          d?.()
          return { value: undefined as never, done: true }
        },
      }
    },
  }
}

export interface ParsedSSE {
  event: string
  data: string
  id: string | undefined
}

/**
 * Parse an SSE byte stream (WHATWG spec) into events. Handles CRLF/CR/LF,
 * multi-line data, comments, and chunk boundaries anywhere.
 */
export async function* parseSSE(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<ParsedSSE> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  let event = ''
  let id: string | undefined
  let lastId: string | undefined

  let finished = false
  const onAbort = () => void reader.cancel().catch(() => {})
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) buffer += decoder.decode()
      else buffer += decoder.decode(value, { stream: true })

      let pos = 0
      while (true) {
        let nl = -1
        let skip = 1
        for (let i = pos; i < buffer.length; i++) {
          const c = buffer.charCodeAt(i)
          if (c === 10) {
            nl = i
            break
          }
          if (c === 13) {
            // CR at end of buffer may be followed by LF in the next chunk.
            if (i + 1 >= buffer.length && !done) break
            nl = i
            if (buffer.charCodeAt(i + 1) === 10) skip = 2
            break
          }
        }
        if (nl === -1) break
        const line = buffer.slice(pos, nl)
        pos = nl + skip

        if (line === '') {
          if (data.length > 0) {
            lastId = id ?? lastId
            yield { event: event || 'message', data: data.join('\n'), id: lastId }
          }
          data = []
          event = ''
          id = undefined
          continue
        }
        if (line.charCodeAt(0) === 58 /* : */) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        let val = colon === -1 ? '' : line.slice(colon + 1)
        if (val.charCodeAt(0) === 32) val = val.slice(1)
        if (field === 'data') data.push(val)
        else if (field === 'event') event = val
        else if (field === 'id') id = val
      }
      buffer = buffer.slice(pos)
      if (done) {
        finished = true
        // Lenient EOF: some servers omit the final newline. Treat leftovers as a last line.
        if (buffer !== '' && buffer.charCodeAt(0) !== 58) {
          const colon = buffer.indexOf(':')
          const field = colon === -1 ? buffer : buffer.slice(0, colon)
          let val = colon === -1 ? '' : buffer.slice(colon + 1)
          if (val.charCodeAt(0) === 32) val = val.slice(1)
          if (field === 'data') data.push(val)
          else if (field === 'event') event = val
          else if (field === 'id') id = val
        }
        if (data.length > 0) yield { event: event || 'message', data: data.join('\n'), id: id ?? lastId }
        return
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    // Consumer stopped early: cancel the underlying body so the connection is released.
    if (!finished) await reader.cancel().catch(() => {})
    else reader.releaseLock()
  }
}
