export interface HTTPExceptionOptions {
  /** A fully custom response. When set, it is returned as-is. */
  res?: Response
  /** Extra JSON fields merged into the default error body. */
  details?: Record<string, unknown>
  cause?: unknown
}

/**
 * Throw from any handler or middleware to short-circuit with an HTTP error.
 *
 * ```ts
 * throw new HTTPException(401, 'Missing API key')
 * ```
 */
export class HTTPException extends Error {
  readonly status: number
  readonly details: Record<string, unknown> | undefined
  readonly #res: Response | undefined

  constructor(status = 500, message?: string, options: HTTPExceptionOptions = {}) {
    super(message ?? defaultMessage(status), options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'HTTPException'
    this.status = status
    this.details = options.details
    this.#res = options.res
  }

  getResponse(): Response {
    if (this.#res) return this.#res
    return Response.json({ error: this.message, ...this.details }, { status: this.status })
  }
}

export interface ValidationIssue {
  message: string
  path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>
}

/** Thrown when request input fails schema validation. Renders as a 400 with the issue list. */
export class ValidationError extends HTTPException {
  readonly target: string
  readonly issues: ReadonlyArray<{ message: string; path: string }>

  constructor(target: string, issues: ReadonlyArray<ValidationIssue>) {
    const normalized = issues.map((i) => ({ message: i.message, path: formatPath(i.path) }))
    super(400, `Invalid ${target}`, { details: { target, issues: normalized } })
    this.name = 'ValidationError'
    this.target = target
    this.issues = normalized
  }
}

export function formatPath(path: ValidationIssue['path']): string {
  if (!path || path.length === 0) return ''
  let out = ''
  for (const seg of path) {
    const key = typeof seg === 'object' && seg !== null ? seg.key : seg
    out += typeof key === 'number' ? `[${key}]` : out === '' ? String(key) : `.${String(key)}`
  }
  return out
}

function defaultMessage(status: number): string {
  switch (status) {
    case 400: return 'Bad Request'
    case 401: return 'Unauthorized'
    case 403: return 'Forbidden'
    case 404: return 'Not Found'
    case 405: return 'Method Not Allowed'
    case 409: return 'Conflict'
    case 413: return 'Payload Too Large'
    case 415: return 'Unsupported Media Type'
    case 422: return 'Unprocessable Entity'
    case 429: return 'Too Many Requests'
    case 501: return 'Not Implemented'
    case 502: return 'Bad Gateway'
    case 503: return 'Service Unavailable'
    default: return status >= 500 ? 'Internal Server Error' : 'Error'
  }
}
