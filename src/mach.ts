import { Context, type Env, type ExecutionContext, type Handler, type HandlerResult, type Input, type Middleware, type Next } from './context.js'
import { HTTPException, ValidationError } from './http-exception.js'
import { compilePattern, getPath, normalizePath, Router } from './router.js'
import type { InferOutput, StandardSchemaV1 } from './schema/standard.js'

// ─── Route options (validation) ──────────────────────────────────────────────

export interface RouteSchemas {
  /** Validates the parsed JSON / form body. */
  body?: StandardSchemaV1
  /** Validates `Object.fromEntries(url.searchParams)`. */
  query?: StandardSchemaV1
  /** Validates the route params. */
  params?: StandardSchemaV1
  /** Validates request headers (lower-cased names). */
  headers?: StandardSchemaV1
}

export interface RouteOptions<E extends Env = any> extends RouteSchemas {
  /** Route-level middleware, run after global middleware and validation. */
  middleware?: Middleware<E>[]
  /** Free-form metadata, e.g. for docs generation. */
  meta?: Record<string, unknown>
}

type InputOf<O> = { [K in keyof O & keyof RouteSchemas]: InferOutput<O[K]> }

type AnyHandler = (c: Context, next: Next) => HandlerResult | Promise<HandlerResult>

interface RouteEntry {
  method: string
  path: string
  handlers: AnyHandler[]
  /** Chain incl. global middleware, cached when all middleware is global. */
  chain: AnyHandler[] | undefined
  meta: Record<string, unknown> | undefined
}

interface MiddlewareEntry {
  pattern: string
  match: (path: string) => boolean
  global: boolean
  fn: AnyHandler
}

export type ErrorHandler<E extends Env = any> = (err: unknown, c: Context<E>) => Response | Promise<Response>
export type NotFoundHandler<E extends Env = any> = (c: Context<E>) => Response | Promise<Response>

/** Anything that can serve requests at a path: agents, MCP servers, sub-apps. */
export interface Mountable {
  handle(c: Context): HandlerResult | Promise<HandlerResult>
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const

interface MethodFn<E extends Env, Self> {
  <P extends string>(path: P, ...handlers: Handler<E, P, {}>[]): Self
  <P extends string, O extends RouteOptions<E>>(path: P, options: O, ...handlers: Handler<E, P, InputOf<O>>[]): Self
}

// ─── App ─────────────────────────────────────────────────────────────────────

/**
 * ```ts
 * const app = new Mach()
 * app.get('/hello/:name', (c) => `Hello ${c.params.name}`)
 * export default app // Bun, Deno, Cloudflare Workers
 * ```
 */
export class Mach<E extends Env = {}> {
  private _router = new Router<RouteEntry>()
  private _routes: RouteEntry[] = []
  private _middleware: MiddlewareEntry[] = []
  private _hasScopedMiddleware = false
  private _onError: ErrorHandler<E> = defaultErrorHandler
  private _notFound: NotFoundHandler<E> = (c) => c.notFound()
  private _strictMethods = true

  declare get: MethodFn<E, this>
  declare post: MethodFn<E, this>
  declare put: MethodFn<E, this>
  declare patch: MethodFn<E, this>
  declare delete: MethodFn<E, this>
  declare options: MethodFn<E, this>
  declare head: MethodFn<E, this>
  declare all: MethodFn<E, this>

  constructor(options: { strictMethods?: boolean } = {}) {
    if (options.strictMethods === false) this._strictMethods = false
    for (const m of [...METHODS, 'ALL'] as const) {
      ;(this as any)[m.toLowerCase()] = (path: string, ...rest: unknown[]) => this.on(m, path, ...(rest as any))
    }
  }

  /** Register a route for one or more methods. */
  on<P extends string>(method: string | string[], path: P, ...handlers: Handler<E, P, {}>[]): this
  on<P extends string, O extends RouteOptions<E>>(
    method: string | string[],
    path: P,
    options: O,
    ...handlers: Handler<E, P, InputOf<O>>[]
  ): this
  on(method: string | string[], path: string, ...rest: unknown[]): this {
    let options: RouteOptions | undefined
    if (rest.length > 0 && typeof rest[0] !== 'function') options = rest.shift() as RouteOptions
    const handlers = rest as AnyHandler[]
    if (handlers.length === 0) throw new TypeError(`No handler given for route ${String(method)} ${path}`)
    for (const h of handlers) {
      if (typeof h !== 'function') throw new TypeError(`Handler for ${String(method)} ${path} must be a function`)
    }

    const chain: AnyHandler[] = []
    if (options) {
      const v = buildValidator(options)
      if (v) chain.push(v)
      if (options.middleware) chain.push(...(options.middleware as AnyHandler[]))
    }
    chain.push(...handlers)

    for (const m of Array.isArray(method) ? method : [method]) {
      const entry: RouteEntry = {
        method: m.toUpperCase(),
        path: normalizePath(path),
        handlers: chain,
        chain: undefined,
        meta: options?.meta,
      }
      this._router.add(entry.method, entry.path, entry)
      this._routes.push(entry)
    }
    return this
  }

  /**
   * Add middleware. Runs for every request (including 404s and CORS preflights)
   * whose path matches, in registration order, before route handlers.
   *
   * ```ts
   * app.use(logger())
   * app.use('/api/*', auth)
   * ```
   */
  use(...middleware: Middleware<any>[]): this
  use(path: string, ...middleware: Middleware<any>[]): this
  use(...args: unknown[]): this {
    const pattern = typeof args[0] === 'string' ? (args.shift() as string) : '*'
    const global = pattern === '*' || pattern === '/*'
    if (!global) this._hasScopedMiddleware = true
    for (const fn of args) {
      if (typeof fn !== 'function') throw new TypeError('Middleware must be a function')
      this._middleware.push({ pattern, match: compilePattern(pattern), global, fn: fn as AnyHandler })
    }
    for (const r of this._routes) r.chain = undefined
    return this
  }

  /**
   * Mount a sub-app under a prefix. Its routes and middleware are copied at mount time;
   * the sub-app's middleware only runs for the sub-app's routes.
   */
  route(prefix: string, app: Mach<any>): this {
    const base = normalizePath(prefix)
    const join = (p: string) => normalizePath(base === '/' ? p : p === '/' ? base : base + p)
    const mws = app._middleware.map((m) => ({ match: m.global ? always : compilePattern(join(m.pattern)), fn: m.fn }))
    for (const r of app._routes) {
      const handlers = mws.length ? [scopedMiddleware(mws), ...r.handlers] : r.handlers
      const entry: RouteEntry = { method: r.method, path: join(r.path), handlers, chain: undefined, meta: r.meta }
      this._router.add(entry.method, entry.path, entry)
      this._routes.push(entry)
    }
    return this
  }

  /** Expose an agent (or anything with `handle(c)`) as a streaming POST endpoint. */
  agent(path: string, agent: Mountable): this {
    return this.on('POST', path, (c) => agent.handle(c))
  }

  /** Expose an MCP server (from `machjs/mcp`) at a path (Streamable HTTP transport). */
  mcp(path: string, server: Mountable): this {
    return this.on(['GET', 'POST', 'DELETE'], path, (c) => server.handle(c))
  }

  onError(handler: ErrorHandler<E>): this {
    this._onError = handler
    return this
  }

  notFound(handler: NotFoundHandler<E>): this {
    this._notFound = handler
    return this
  }

  /** All registered routes (for introspection, docs, tests). */
  get routes(): ReadonlyArray<{ method: string; path: string; meta: Record<string, unknown> | undefined }> {
    return this._routes.map(({ method, path, meta }) => ({ method, path, meta }))
  }

  /** The Web Standard entry point: `export default app` or `Bun.serve({ fetch: app.fetch })`. */
  fetch = (req: Request, env?: unknown, executionCtx?: ExecutionContext): Response | Promise<Response> => {
    const method = req.method
    const path = getPath(req.url)
    let match = this._router.match(method, path) ?? this._router.match('ALL', path)
    let isHead = false
    if (!match && method === 'HEAD') {
      match = this._router.match('GET', path)
      isHead = match !== null
    }

    const c = new Context(req, match ? match.params : {}, env, executionCtx)

    if (match) {
      const route = match.value
      let chain = route.chain
      if (!chain) {
        if (this._middleware.length === 0) chain = route.handlers
        else {
          const mw = this._middleware.filter((m) => m.global || m.match(path)).map((m) => m.fn)
          chain = mw.length ? [...mw, ...route.handlers] : route.handlers
        }
        if (!this._hasScopedMiddleware) route.chain = chain
      }
      const out = this._dispatch(c, chain)
      if (isHead) return out instanceof Promise ? out.then(stripBody) : stripBody(out)
      return out
    }

    // No route: still run matching middleware (CORS preflight, logging, auth).
    const notFound: AnyHandler = (ctx) => {
      if (this._strictMethods) {
        const allowed = this._router.allowed(path)
        if (allowed.length > 0 && !allowed.includes('ALL')) {
          return ctx.json({ error: 'Method Not Allowed' }, 405, { allow: allowed.join(', ') })
        }
      }
      return this._notFound(ctx as Context<E>)
    }
    const mw = this._middleware.length ? this._middleware.filter((m) => m.global || m.match(path)).map((m) => m.fn) : []
    return this._dispatch(c, mw.length ? [...mw, notFound] : [notFound])
  }

  /**
   * Make a request against the app without a server. Great for tests.
   * ```ts
   * const res = await app.request('/hello')
   * const res = await app.request('/chat', { method: 'POST', body: JSON.stringify({...}) })
   * ```
   */
  request(input: string | URL | Request, init?: RequestInit & { json?: unknown }, env?: unknown): Promise<Response> {
    let req: Request
    if (input instanceof Request) req = init ? new Request(input, init) : input
    else {
      const url = typeof input === 'string' && !/^https?:\/\//.test(input) ? new URL(input, 'http://localhost') : new URL(input)
      if (init?.json !== undefined) {
        const { json, ...rest } = init
        const headers = new Headers(rest.headers)
        if (!headers.has('content-type')) headers.set('content-type', 'application/json')
        req = new Request(url, { method: 'POST', ...rest, headers, body: JSON.stringify(json) })
      } else req = new Request(url, init)
    }
    return Promise.resolve(this.fetch(req, env))
  }

  private _dispatch(c: Context, chain: AnyHandler[]): Response | Promise<Response> {
    // Fast path: a single sync handler returning a value.
    if (chain.length === 1) {
      try {
        const r = chain[0]!(c, noopNext)
        if (r instanceof Promise) {
          return r.then(
            (v) => this._finalize(c, v),
            (err) => this._handleError(err, c),
          )
        }
        return this._finalize(c, r)
      } catch (err) {
        return this._handleError(err, c)
      }
    }
    return compose(c, chain, (err) => this._handleError(err, c)).then(
      () => this._finalize(c, undefined),
      (err) => this._handleError(err, c),
    )
  }

  private _finalize(c: Context, value: HandlerResult): Response {
    if (value !== undefined) return toResponse(c, value)
    if (c.res) return c.res
    const route = `${c.req.method} ${getPath(c.req.url)}`
    console.error(`[mach] Handler for ${route} returned nothing. Return a Response, string, object, or async iterable.`)
    return c.json({ error: 'Internal Server Error' }, 500)
  }

  private _handleError(err: unknown, c: Context): Response | Promise<Response> {
    try {
      return this._onError(err, c as Context<E>)
    } catch (inner) {
      console.error('[mach] onError handler threw:', inner)
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    }
  }
}

// ─── Internals ───────────────────────────────────────────────────────────────

const noopNext: Next = () => Promise.resolve()
const always = () => true

/**
 * Koa-style composition. Errors are turned into responses at the point they are
 * thrown, so outer middleware (CORS, logging, timing) still sees and decorates them.
 */
function compose(c: Context, chain: AnyHandler[], onError: (err: unknown) => Response | Promise<Response>): Promise<void> {
  let index = -1
  const fail = (err: unknown): Promise<void> =>
    Promise.resolve(onError(err)).then((res) => {
      c.res = res
    })
  const dispatch = (i: number): Promise<void> => {
    if (i <= index) return Promise.reject(new Error('next() called multiple times'))
    index = i
    const fn = chain[i]
    if (!fn) return Promise.resolve()
    let called = false
    const next = () => {
      called = true
      return dispatch(i + 1)
    }
    // A middleware that returns nothing without calling next() passes through (guard style).
    const settle = (v: HandlerResult): Promise<void> | void => {
      if (v !== undefined) c.res = toResponse(c, v)
      else if (!called && i < chain.length - 1) return dispatch(i + 1)
    }
    let r: HandlerResult | Promise<HandlerResult>
    try {
      r = fn(c, next)
    } catch (err) {
      return fail(err)
    }
    if (r instanceof Promise) return r.then(settle, fail)
    try {
      return Promise.resolve(settle(r))
    } catch (err) {
      return fail(err)
    }
  }
  return dispatch(0)
}

function scopedMiddleware(entries: { match: (p: string) => boolean; fn: AnyHandler }[]): AnyHandler {
  return (c, next) => {
    const path = getPath(c.req.url)
    const fns = entries.filter((e) => e.match(path)).map((e) => e.fn)
    if (fns.length === 0) return next()
    let i = -1
    const run = (k: number): Promise<void> => {
      if (k <= i) return Promise.reject(new Error('next() called multiple times'))
      i = k
      if (k === fns.length) return next()
      return Promise.resolve(fns[k]!(c, () => run(k + 1))).then((v) => {
        if (v !== undefined) c.res = toResponse(c, v)
      })
    }
    return run(0)
  }
}

function isAsyncIterable(v: object): v is AsyncIterable<unknown> {
  return typeof (v as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
}

/** Convert a handler's return value into a Response. */
export function toResponse(c: Context, value: HandlerResult): Response {
  if (value instanceof Response) return value
  switch (typeof value) {
    case 'string':
      return c.text(value)
    case 'number':
    case 'boolean':
      return c.json(value)
    case 'object':
      if (value === null) return c.body(null, 204)
      if (value instanceof ReadableStream) return c.body(value)
      if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
        return c.body(value as BodyInit, undefined, { 'content-type': 'application/octet-stream' })
      }
      if (isAsyncIterable(value)) return c.sse(value)
      return c.json(value)
    default:
      return c.json(value ?? null)
  }
}

function stripBody(res: Response): Response {
  return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers })
}

function buildValidator(options: RouteSchemas): AnyHandler | undefined {
  const { body, query, params, headers } = options
  if (!body && !query && !params && !headers) return undefined
  return async (c, next) => {
    const input: Record<string, unknown> = {}
    if (params) input.params = await check('params', params, c.params)
    if (query) input.query = await check('query', query, c.query())
    if (headers) {
      const h: Record<string, string> = {}
      c.req.headers.forEach((v, k) => (h[k] = v))
      input.headers = await check('headers', headers, h)
    }
    if (body) input.body = await check('body', body, await readBody(c.req))
    c.input = input
    await next()
  }
}

async function check(target: string, schema: StandardSchemaV1, value: unknown): Promise<unknown> {
  let result = schema['~standard'].validate(value)
  if (result instanceof Promise) result = await result
  if (result.issues) throw new ValidationError(target, result.issues)
  return result.value
}

async function readBody(req: Request): Promise<unknown> {
  const type = req.headers.get('content-type') ?? ''
  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    const form = await req.formData()
    const out: Record<string, unknown> = {}
    form.forEach((v, k) => {
      const prev = out[k]
      out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v]
    })
    return out
  }
  const text = await req.text()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new HTTPException(400, 'Malformed JSON body')
  }
}

function defaultErrorHandler(err: unknown, c: Context): Response {
  if (err instanceof HTTPException) return err.getResponse()
  console.error(`[mach] Unhandled error in ${c.req.method} ${getPath(c.req.url)}:`, err)
  return c.json({ error: 'Internal Server Error' }, 500)
}

export type { Handler, Middleware, Next, Env, Input }
