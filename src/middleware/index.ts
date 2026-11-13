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
