import { pushIterable, SSEComment, sseStream, type SSEStreamOptions, type SSEWriter } from './stream/sse.js'

// ─── Type helpers ────────────────────────────────────────────────────────────

export interface Env {
  /** Per-request variables set by middleware via `c.set()` and read via `c.get()` / `c.var`. */
  Variables?: Record<string, unknown>
  /** Platform bindings (Cloudflare Workers env, etc.) passed as the 2nd argument to `fetch`. */
  Bindings?: unknown
}

export interface Input {
  body?: unknown
  query?: unknown
  params?: unknown
  headers?: unknown
}

type Simplify<T> = { [K in keyof T]: T[K] } & {}

type ParamEntry<S extends string> = S extends `${infer N}?` ? { [K in N]?: string } : { [K in S]: string }

type ExtractParams<P extends string> = P extends `${string}:${infer Rest}`
  ? Rest extends `${infer Name}/${infer Tail}`
    ? ParamEntry<Name> & ExtractParams<`/${Tail}`>
    : ParamEntry<Rest>
  : P extends `${string}*`
    ? { '*': string }
    : {}

/** `'/users/:id/files/*'` → `{ id: string; '*': string }` */
export type ParamsOf<P extends string> = string extends P ? Record<string, string> : Simplify<ExtractParams<P>>

type Vars<E extends Env> = E['Variables'] extends Record<string, unknown> ? E['Variables'] : Record<string, unknown>

/**
 * Anything a handler may return. Mach converts it: Response → as-is, string → text,
 * object/array/number/boolean → JSON, null → 204, ReadableStream → body,
 * AsyncIterable → Server-Sent Events.
 */
export type HandlerResult = unknown

export type Next = () => Promise<void>

export type Handler<E extends Env = any, P extends string = any, I extends Input = any> = (
  c: Context<E, P, I>,
  next: Next,
) => HandlerResult | Promise<HandlerResult>

export type Middleware<E extends Env = any> = (
  c: Context<E, any, any>,
  next: Next,
) => Response | void | undefined | Promise<Response | void | undefined>

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException?(): void
}

const JSON_TYPE = 'application/json'
const TEXT_TYPE = 'text/plain; charset=utf-8'
const HTML_TYPE = 'text/html; charset=utf-8'
const encoder = /* @__PURE__ */ new TextEncoder()
const EMPTY_INPUT = Object.freeze({})

// ─── Context ─────────────────────────────────────────────────────────────────

export class Context<E extends Env = any, P extends string = any, I extends Input = any> {
  /** The raw Web Standard Request. (Writable so middleware such as bodyLimit can replace it.) */
  req: Request
  /** Route params, typed from the path pattern. */
  readonly params: ParamsOf<P>
  /** Platform bindings (e.g. Workers `env`). */
  readonly env: E['Bindings']
  readonly executionCtx: ExecutionContext | undefined
  /** Validated input from route schemas: `c.input.body`, `c.input.query`, ... */
  input: I
  /** The response. Set after the handler runs; middleware can read/modify it after `await next()`. */
  res: Response | undefined

  // Plain fields (not #private) keep per-request construction cheap on the hot path.
  private _status: number
  private _headers: Headers | undefined
  private _vars: Record<string, unknown> | undefined
  private _url: URL | undefined
  private _query: Record<string, string> | undefined

  constructor(req: Request, params: Record<string, string>, env?: unknown, executionCtx?: ExecutionContext) {
    this.req = req
    this.params = params as ParamsOf<P>
    this.env = env as E['Bindings']
    this.executionCtx = executionCtx
    this.input = EMPTY_INPUT as I
    this.res = undefined
    this._status = 200
    this._headers = undefined
    this._vars = undefined
    this._url = undefined
    this._query = undefined
  }

  /** Parsed URL (lazily created). */
  get url(): URL {
    return (this._url ??= new URL(this.req.url))
  }

  /** A single query parameter, or all query parameters as an object. */
  query(): Record<string, string>
  query(name: string): string | undefined
  query(name?: string): string | undefined | Record<string, string> {
    if (name !== undefined) return this.url.searchParams.get(name) ?? undefined
    return (this._query ??= Object.fromEntries(this.url.searchParams))
  }

  // ── variables ──
  set<K extends keyof Vars<E> & string>(key: K, value: Vars<E>[K]): void {
    ;(this._vars ??= {})[key] = value
  }
  get<K extends keyof Vars<E> & string>(key: K): Vars<E>[K] {
    return this._vars?.[key] as Vars<E>[K]
  }
  get var(): Readonly<Vars<E>> {
    return (this._vars ??= {}) as Vars<E>
  }

  // ── response building ──
  /** Set the status for responses built by `c.json()`/`c.text()`/returned values. */
  status(code: number): this {
    this._status = code
    return this
  }
  /** Set a response header. Pass `undefined` to remove it. */
  header(name: string, value: string | undefined, options?: { append?: boolean }): this {
    if (this.res) {
      // After the handler: modify the response directly (middleware use case).
      try {
        if (value === undefined) this.res.headers.delete(name)
        else if (options?.append) this.res.headers.append(name, value)
        else this.res.headers.set(name, value)
        return this
      } catch {
        this.res = new Response(this.res.body, this.res)
        return this.header(name, value, options)
      }
    }
    const h = (this._headers ??= new Headers())
    if (value === undefined) h.delete(name)
    else if (options?.append) h.append(name, value)
    else h.set(name, value)
    return this
  }

  private _init(contentType: string | undefined, status?: number, headers?: HeadersInit): ResponseInit {
    const st = status ?? this._status
    if (!this._headers && !headers) {
      return contentType ? { status: st, headers: { 'content-type': contentType } } : { status: st }
    }
    const h = new Headers(this._headers)
    if (contentType && !h.has('content-type')) h.set('content-type', contentType)
    if (headers) new Headers(headers).forEach((v, k) => h.set(k, v))
    return { status: st, headers: h }
  }

  json(data: unknown, status?: number, headers?: HeadersInit): Response {
    return new Response(JSON.stringify(data), this._init(JSON_TYPE, status, headers))
  }
  text(text: string, status?: number, headers?: HeadersInit): Response {
    // Fast path: `new Response(string)` is sent as text/plain;charset=UTF-8 on every runtime.
    // (Bun fills the header lazily, so in-process middleware may see it as null.) ~300ns/req cheaper.
    if (status === undefined && headers === undefined && this._status === 200 && this._headers === undefined) {
      return new Response(text)
    }
    return new Response(text, this._init(TEXT_TYPE, status, headers))
  }
  html(html: string, status?: number, headers?: HeadersInit): Response {
    return new Response(html, this._init(HTML_TYPE, status, headers))
  }
  body(body: BodyInit | null, status?: number, headers?: HeadersInit): Response {
    return new Response(body, this._init(undefined, status, headers))
  }
  redirect(location: string, status: 301 | 302 | 303 | 307 | 308 = 302): Response {
    return new Response(null, this._init(undefined, status, { location }))
  }
  notFound(): Response {
    return this.json({ error: 'Not Found' }, 404)
  }

  /**
   * Stream raw text/bytes.
   * ```ts
   * return c.stream(async (s) => { await s.write('hello '); await s.write('world') })
   * ```
   */
  stream(
    fn: (stream: StreamWriter) => Promise<void> | void,
    options: { contentType?: string; onError?: (err: unknown) => void } = {},
  ): Response {
    const signal = this.req.signal
    const iterable = pushIterable<string | Uint8Array>(async (push, sig) => {
      const writer: StreamWriter = {
        write: (chunk) => push(chunk),
        get signal() {
          return sig
        },
      }
      await fn(writer)
    }, signal)
    const iterator = iterable[Symbol.asyncIterator]()
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await iterator.next()
          if (done) controller.close()
          else controller.enqueue(typeof value === 'string' ? encoder.encode(value) : value)
        } catch (err) {
          options.onError ? options.onError(err) : console.error('[mach] stream error:', err)
          controller.close()
        }
      },
      cancel() {
        return iterator.return?.().then(() => undefined)
      },
    })
    return new Response(body, this._init(options.contentType ?? TEXT_TYPE))
  }

  /**
   * Stream Server-Sent Events from an async iterable (LLM stream, agent run, generator)
   * or from a callback with a writer.
   *
   * ```ts
   * return c.sse(agent.stream({ messages }))
   * return c.sse(async (s) => { await s.write({ type: 'tick', n: 1 }) })
   * ```
   */
  sse(source: AsyncIterable<unknown> | ((stream: SSEWriter) => Promise<void> | void), options: SSEStreamOptions = {}): Response {
    const signal = options.signal ?? this.req.signal
    const iterable =
      typeof source === 'function'
        ? pushIterable<unknown>(async (push, sig) => {
            const writer: SSEWriter = {
              write: (item) => push(item),
              comment: (text) => push(new SSEComment(text)),
              get signal() {
                return sig
              },
            }
            await source(writer)
          }, signal)
        : source
    const body = sseStream(iterable, { ...options, signal })
    return new Response(body, this._init('text/event-stream; charset=utf-8', undefined, SSE_HEADERS))
  }
}

const SSE_HEADERS = { 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' }

export interface StreamWriter {
  write(chunk: string | Uint8Array): Promise<void>
  readonly signal: AbortSignal
}
