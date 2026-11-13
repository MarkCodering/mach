import type { Context, Middleware } from '../context.js'
import { getPath } from '../router.js'

// ─── CORS ────────────────────────────────────────────────────────────────────

export interface CorsOptions {
  /** `'*'` (default), a single origin, a list, or a function returning the allowed origin (or null). */
  origin?: string | string[] | ((origin: string, c: Context) => string | null | undefined)
  methods?: string[]
  allowHeaders?: string[]
  exposeHeaders?: string[]
  credentials?: boolean
  maxAge?: number
}

export function cors(options: CorsOptions = {}): Middleware {
  const {
    origin = '*',
    methods = ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH'],
    allowHeaders,
    exposeHeaders,
    credentials = false,
    maxAge,
  } = options
  if (credentials && origin === '*') {
    throw new Error('cors(): `credentials: true` cannot be combined with origin "*". Pass explicit origins.')
  }
  const resolve = (reqOrigin: string, c: Context): string | null => {
    if (typeof origin === 'function') return origin(reqOrigin, c) ?? null
    if (origin === '*') return '*'
    if (typeof origin === 'string') return origin
    return origin.includes(reqOrigin) ? reqOrigin : null
  }

  return async (c, next) => {
    const reqOrigin = c.req.headers.get('origin') ?? ''
    const allowed = resolve(reqOrigin, c)

    const decorate = (h: Headers) => {
      if (!allowed) return
      h.set('access-control-allow-origin', allowed)
      if (allowed !== '*') h.append('vary', 'Origin')
      if (credentials) h.set('access-control-allow-credentials', 'true')
      if (exposeHeaders?.length) h.set('access-control-expose-headers', exposeHeaders.join(', '))
    }

    if (c.req.method === 'OPTIONS' && c.req.headers.has('access-control-request-method')) {
      const h = new Headers()
      decorate(h)
      if (allowed) {
        h.set('access-control-allow-methods', methods.join(', '))
        const reqHeaders = allowHeaders?.join(', ') ?? c.req.headers.get('access-control-request-headers')
        if (reqHeaders) {
          h.set('access-control-allow-headers', reqHeaders)
          if (!allowHeaders) h.append('vary', 'Access-Control-Request-Headers')
        }
        if (maxAge !== undefined) h.set('access-control-max-age', String(maxAge))
      }
      return new Response(null, { status: 204, headers: h })
    }

    await next()
    if (c.res && allowed) {
      try {
        decorate(c.res.headers)
      } catch {
        c.res = new Response(c.res.body, c.res)
        decorate(c.res.headers)
      }
    }
  }
}

// ─── Logger ──────────────────────────────────────────────────────────────────

export interface LoggerOptions {
  /** Custom sink. Defaults to console.log. */
  log?: (line: string, info: { method: string; path: string; status: number; ms: number }) => void
}

/** `--> GET /users 200 1.2ms` */
export function logger(options: LoggerOptions = {}): Middleware {
  const log = options.log ?? ((line: string) => console.log(line))
  return async (c, next) => {
    const start = performance.now()
    const method = c.req.method
    const path = getPath(c.req.url)
    await next()
    const ms = performance.now() - start
    const status = c.res?.status ?? 0
    log(`${method} ${path} ${status} ${ms.toFixed(1)}ms`, { method, path, status, ms })
  }
}

// ─── Request ID ──────────────────────────────────────────────────────────────

export interface RequestIdOptions {
  header?: string
  /** Trust an incoming request id header (default true). */
  trustIncoming?: boolean
  generate?: () => string
}

/** Sets `c.get('requestId')` and echoes it in the response header. */
export function requestId(options: RequestIdOptions = {}): Middleware<{ Variables: { requestId: string } }> {
  const header = options.header ?? 'x-request-id'
  const trust = options.trustIncoming ?? true
  const generate = options.generate ?? (() => crypto.randomUUID())
  return async (c, next) => {
    const incoming = trust ? c.req.headers.get(header) : null
    const id = incoming && /^[\w.:-]{1,128}$/.test(incoming) ? incoming : generate()
    c.set('requestId', id)
    await next()
    c.header(header, id)
  }
}

// ─── Timing ──────────────────────────────────────────────────────────────────

/** Adds a `Server-Timing: total;dur=…` header. For streams this measures time-to-first-byte. */
export function timing(): Middleware {
  return async (c, next) => {
    const start = performance.now()
    await next()
    c.header('server-timing', `total;dur=${(performance.now() - start).toFixed(2)}`, { append: true })
  }
}

// ─── Body limit ──────────────────────────────────────────────────────────────

/**
 * Reject request bodies larger than `maxBytes` with 413. Checks Content-Length up front and
 * counts bytes for chunked bodies. Protects LLM endpoints from oversized prompts.
 */
export function bodyLimit(maxBytes: number): Middleware {
  const tooLarge = (c: Context) => c.json({ error: 'Payload Too Large' }, 413)
  return async (c, next) => {
    const len = c.req.headers.get('content-length')
    if (len !== null) {
      if (Number(len) > maxBytes) return tooLarge(c)
      return next()
    }
    if (!c.req.body || c.req.method === 'GET' || c.req.method === 'HEAD') return next()
    const reader = c.req.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => {})
        return tooLarge(c)
      }
      chunks.push(value)
    }
    const buf = new Uint8Array(size)
    let off = 0
    for (const ch of chunks) {
      buf.set(ch, off)
      off += ch.byteLength
    }
    c.req = new Request(c.req.url, {
      method: c.req.method,
      headers: c.req.headers,
      body: buf,
      signal: c.req.signal,
    })
    return next()
  }
}

// ─── Rate limit ──────────────────────────────────────────────────────────────

export interface RateLimitStore {
  /**
   * Add `cost` to `key`'s counter in the current fixed window and return the new total and
   * when the window resets (epoch ms). Implement this over Redis, Workers KV, Durable Objects...
   */
  hit(key: string, cost: number, windowMs: number): { count: number; resetAt: number } | Promise<{ count: number; resetAt: number }>
}

/** In-process fixed-window store. Fine for a single instance; use a shared store when scaling out. */
export function memoryStore(options: { now?: () => number } = {}): RateLimitStore & { size(): number } {
  const now = options.now ?? Date.now
  const windows = new Map<string, { count: number; resetAt: number }>()
  let hits = 0
  return {
    hit(key, cost, windowMs) {
      const t = now()
      // Sweep expired windows now and then so memory stays bounded by active keys.
      if (++hits % 1000 === 0) for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k)
      let w = windows.get(key)
      if (!w || w.resetAt <= t) windows.set(key, (w = { count: 0, resetAt: t + windowMs }))
      w.count += cost
      return { count: w.count, resetAt: w.resetAt }
    },
    size: () => windows.size,
  }
}

export interface RateLimitOptions {
  /** Allowed cost per window (requests, by default). */
  limit: number
  windowMs: number
  /**
   * Who is being limited: an API key, user id, or a client IP you trust. Return null/undefined to
   * skip limiting for this request. (There is no default: IP headers are spoofable unless your
   * proxy sets them, so choose deliberately, e.g. `c => c.req.headers.get('cf-connecting-ip')` on Cloudflare.)
   */
  key: (c: Context) => string | null | undefined | Promise<string | null | undefined>
  /** Weight of this request (default 1). E.g. charge more for expensive AI endpoints. */
  cost?: (c: Context) => number | Promise<number>
  store?: RateLimitStore
  /** Send `RateLimit-*` headers on every response (default true). */
  headers?: boolean
  /** Key prefix so several limiters can share one store. */
  prefix?: string
  now?: () => number
}

/**
 * Fixed-window rate limiting with standard `RateLimit-Limit/Remaining/Reset` headers and a
 * 429 + `Retry-After` when exceeded.
 *
 * ```ts
 * app.use('/chat', rateLimit({ limit: 20, windowMs: 60_000, key: (c) => c.req.headers.get('x-api-key') }))
 * ```
 */
export function rateLimit(options: RateLimitOptions): Middleware {
  const { limit, windowMs, key, cost, headers = true, prefix = 'rl:' } = options
  if (!(limit > 0) || !(windowMs > 0)) throw new RangeError('rateLimit(): limit and windowMs must be > 0')
  const now = options.now ?? Date.now
  const store = options.store ?? memoryStore({ now })

  return async (c, next) => {
    const id = await key(c)
    if (id === null || id === undefined || id === '') return next()
    const weight = cost ? await cost(c) : 1
    const { count, resetAt } = await store.hit(prefix + id, weight, windowMs)
    const remaining = Math.max(0, limit - count)
    const resetSec = Math.max(0, Math.ceil((resetAt - now()) / 1000))

    const set = (h: (name: string, value: string) => void) => {
      if (!headers) return
      h('ratelimit-limit', String(limit))
      h('ratelimit-remaining', String(remaining))
      h('ratelimit-reset', String(resetSec))
    }

    if (count > limit) {
      const res = c.json({ error: 'Too Many Requests' }, 429, { 'retry-after': String(resetSec) })
      set((n, v) => res.headers.set(n, v))
      return res
    }
    await next()
    set((n, v) => c.header(n, v))
  }
}
