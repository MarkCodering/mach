/**
 * Run a Mach app on Node.js' built-in HTTP server.
 *
 * ```ts
 * import { serve } from 'machjs/node'
 * serve(app, { port: 3000 })
 * ```
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

export interface FetchApp {
  fetch(req: Request, env?: unknown, ctx?: unknown): Response | Promise<Response>
}

export interface ServeOptions {
  port?: number
  hostname?: string
  /** Called once the server is listening. */
  onListen?: (info: { port: number; hostname: string; url: string }) => void
  /** Passed to `app.fetch` as the env/bindings argument. */
  env?: unknown
}

export function serve(app: FetchApp, options: ServeOptions = {}): Server {
  const handler = createHandler(app, options.env)
  const server = createServer(handler)
  const port = options.port ?? Number(process.env.PORT ?? 3000)
  const hostname = options.hostname ?? '0.0.0.0'
  server.listen(port, hostname, () => {
    const addr = server.address()
    const actualPort = typeof addr === 'object' && addr ? addr.port : port
    const shown = hostname === '0.0.0.0' ? 'localhost' : hostname
    const info = { port: actualPort, hostname, url: `http://${shown}:${actualPort}` }
    if (options.onListen) options.onListen(info)
    else console.log(`Mach listening on ${info.url}`)
  })
  return server
}

/** A `(req, res)` listener you can mount in an existing Node server or framework. */
export function createHandler(app: FetchApp, env?: unknown) {
  return async (incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> => {
    const ac = new AbortController()
    // Abort when the client goes away before we finish (stops LLM calls mid-stream).
    outgoing.once('close', () => {
      if (!outgoing.writableFinished) ac.abort()
    })

    let response: Response
    try {
      response = await app.fetch(toRequest(incoming, ac.signal), env)
    } catch (err) {
      console.error('[mach] unhandled error:', err)
      response = new Response('Internal Server Error', { status: 500 })
    }
    await writeResponse(response, outgoing, ac.signal)
  }
}

function toRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const proto = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http'
  const host = req.headers.host ?? 'localhost'
  const url = `${proto}://${host}${req.url ?? '/'}`
  const headers = new Headers()
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const k = req.rawHeaders[i]!
    if (k.startsWith(':')) continue // HTTP/2 pseudo headers
    headers.append(k, req.rawHeaders[i + 1]!)
  }
  const method = req.method ?? 'GET'
  const init: RequestInit & { duplex?: 'half' } = { method, headers, signal }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>
    init.duplex = 'half'
  }
  return new Request(url, init)
}

const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'

async function writeResponse(res: Response, out: ServerResponse, signal: AbortSignal): Promise<void> {
  if (IS_BUN && res.body && !res.headers.has('content-type')) {
    // Bun fills implied content types (e.g. for string bodies) lazily, only in Bun.serve.
    // Recover it here. Mach's own streaming responses always set content-type, so this only buffers
    // bodies that were not streams to begin with (or hand-made streams without a content type).
    const blob = await res.blob()
    const fixed = new Headers(res.headers)
    if (blob.type) fixed.set('content-type', blob.type)
    res = new Response(blob.size ? blob : null, { status: res.status, statusText: res.statusText, headers: fixed })
  }
  const headers: Record<string, string | string[]> = {}
  res.headers.forEach((value, key) => {
    if (key === 'set-cookie') return
    headers[key] = value
  })
  const cookies = res.headers.getSetCookie?.() ?? []
  if (cookies.length) headers['set-cookie'] = cookies
  out.writeHead(res.status, res.statusText || undefined, headers)

  if (!res.body) {
    out.end()
    return
  }
  const isStream = (res.headers.get('content-type') ?? '').startsWith('text/event-stream')
  if (isStream) out.flushHeaders()

  const reader = res.body.getReader()
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel()
        break
      }
      const { value, done } = await reader.read()
      if (done) break
      if (!out.write(value)) {
        await new Promise<void>((resolve) => {
          const done = () => {
            out.off('drain', done)
            out.off('close', done)
            resolve()
          }
          out.on('drain', done)
          out.on('close', done)
        })
      }
    }
  } catch (err) {
    if (!signal.aborted) console.error('[mach] error writing response:', err)
    await reader.cancel().catch(() => {})
  } finally {
    out.end()
  }
}
