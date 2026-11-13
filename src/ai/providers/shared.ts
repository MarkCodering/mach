import { ModelError } from '../types.js'

export interface ProviderHTTPOptions {
  /** Custom fetch (testing, proxies, instrumentation). */
  fetch?: typeof fetch
  /** Extra headers on every request. */
  headers?: Record<string, string>
  /** Retries for 408/409/429/5xx and network errors before the stream starts (default 2). */
  maxRetries?: number
}

/** Read an env var on Node, Bun and Deno without depending on any of them. */
export function env(name: string): string | undefined {
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> }
    Deno?: { env?: { get(n: string): string | undefined } }
  }
  try {
    return g.process?.env?.[name] ?? g.Deno?.env?.get(name)
  } catch {
    return undefined
  }
}

/**
 * POST JSON and return the streaming response, retrying transient failures with
 * exponential backoff (honouring `retry-after`).
 */
export async function postStream(
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: ProviderHTTPOptions & { signal?: AbortSignal },
): Promise<ReadableStream<Uint8Array>> {
  const doFetch = options.fetch ?? globalThis.fetch
  const maxRetries = options.maxRetries ?? 2
  const payload = JSON.stringify(body)
  let attempt = 0
  while (true) {
    let res: Response
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers, ...options.headers },
        body: payload,
        signal: options.signal ?? null,
      })
    } catch (err) {
      if (options.signal?.aborted) throw err
      if (attempt < maxRetries) {
        await backoff(attempt++, null, options.signal)
        continue
      }
      throw new ModelError(provider, `Network error: ${(err as Error)?.message ?? String(err)}`, { cause: err })
    }

    if (res.ok && res.body) return res.body

    const text = await res.text().catch(() => '')
    let parsed: unknown = text
    try {
      parsed = JSON.parse(text)
    } catch {
      /* keep text */
    }
    const error = new ModelError(provider, `HTTP ${res.status}: ${extractMessage(parsed) ?? res.statusText}`, {
      status: res.status,
      body: parsed,
    })
    if (error.retryable && attempt < maxRetries) {
      await backoff(attempt++, res.headers.get('retry-after'), options.signal)
      continue
    }
    throw error
  }
}

function extractMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const e = (body as { error?: unknown }).error
    if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
      return (e as { message: string }).message
    }
    if (typeof e === 'string') return e
    if (typeof (body as { message?: unknown }).message === 'string') return (body as { message: string }).message
  }
  if (typeof body === 'string' && body) return body.slice(0, 500)
  return undefined
}

async function backoff(attempt: number, retryAfter: string | null, signal?: AbortSignal): Promise<void> {
  let ms = Math.min(8000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5)
  if (retryAfter) {
    const secs = Number(retryAfter)
    if (Number.isFinite(secs)) ms = Math.min(60_000, secs * 1000)
  }
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

export function parseJSONSafe(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (text.trim() === '') return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (err) {
    return { ok: false, error: `Tool arguments were not valid JSON (${(err as Error).message})` }
  }
}
