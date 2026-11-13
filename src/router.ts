/**
 * Mach's router.
 *
 * - Static routes resolve through a single Map lookup with a prebuilt result (no allocation).
 * - Dynamic routes per method are compiled into ONE anchored RegExp. Alternatives are ordered
 *   by specificity (static segment > `:param` > `*`, compared left to right), which gives the
 *   same precedence as a backtracking trie. A marker group at the start of each alternative
 *   identifies the matched route in a single `exec`.
 * - Supports `:param`, optional trailing `:param?`, and a trailing `*` wildcard (captured as `*`).
 * - RegExp only, no `eval`/`new Function`, so it runs on Cloudflare Workers and other strict runtimes.
 */

export type Params = Record<string, string>

export interface Match<T> {
  value: T
  params: Params
}

const EMPTY_PARAMS: Params = Object.freeze({}) as Params

interface DynamicRoute<T> {
  path: string
  segments: string[]
  value: T
  rank: number[]
}

interface Compiled<T> {
  re: RegExp
  /** Indexed by marker group index. */
  targets: ({ value: T; names: string[]; wildcard: boolean } | undefined)[]
}

export class Router<T> {
  // Plain (non-#private) fields: measurably faster property access on the hot path in JSC/V8.
  /** path -> method -> prebuilt match */
  private _static: Map<string, Record<string, Match<T>>> = new Map()
  private _staticMethods = new Set<string>()
  private _dynamic = new Map<string, DynamicRoute<T>[]>()
  private _compiled: Record<string, Compiled<T> | null | undefined> = Object.create(null)

  add(method: string, path: string, value: T): void {
    const normalized = normalizePath(path)
    // Optional trailing param: register both with and without it.
    const optional = /\/:([A-Za-z0-9_]+)\?$/.exec(normalized)
    if (optional) {
      this.add(method, normalized.slice(0, optional.index) || '/', value)
      this.add(method, normalized.slice(0, -1), value)
      return
    }

    if (!normalized.includes(':') && !normalized.includes('*')) {
      let byMethod = this._static.get(normalized)
      if (!byMethod) this._static.set(normalized, (byMethod = Object.create(null) as Record<string, Match<T>>))
      if (byMethod[method]) throw new Error(`Route already registered: ${method} ${path}`)
      byMethod[method] = Object.freeze({ value, params: EMPTY_PARAMS }) as Match<T>
      this._staticMethods.add(method)
      return
    }

    const segments = normalized.split('/').slice(1)
    const names = new Set<string>()
    const rank = segments.map((seg, i) => {
      if (seg === '*') {
        if (i !== segments.length - 1) throw new Error(`Wildcard must be the last segment: ${path}`)
        return 2
      }
      if (seg.charCodeAt(0) === 58 /* : */) {
        const name = seg.slice(1)
        if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Invalid param name "${name}" in ${path}`)
        if (names.has(name)) throw new Error(`Duplicate param name "${name}" in ${path}`)
        names.add(name)
        return 1
      }
      return 0
    })
    const list = this._dynamic.get(method) ?? []
    const shape = shapeOf(segments)
    for (const r of list) {
      if (shapeOf(r.segments) === shape) throw new Error(`Route already registered: ${method} ${path}`)
    }
    list.push({ path: normalized, segments, value, rank })
    this._dynamic.set(method, list)
    this._compiled[method] = undefined
  }

  match(method: string, path: string): Match<T> | null {
    const hit = this._static.get(path)?.[method]
    if (hit !== undefined) return hit
    let p = path
    if (p.length > 1 && p.charCodeAt(p.length - 1) === 47 /* / */) {
      p = p.slice(0, -1)
      const alt = this._static.get(p)?.[method]
      if (alt !== undefined) return alt
    }
    let compiled = this._compiled[method]
    if (compiled === undefined) compiled = this.compile(method)
    if (compiled === null) return null

    const m = compiled.re.exec(p)
    if (m === null) return null
    const marker = m.indexOf('', 1)
    const target = compiled.targets[marker]!
    const params: Params = {}
    const names = target.names
    for (let i = 0; i < names.length; i++) {
      const raw = m[marker + 1 + i]
      params[names[i]!] = raw === undefined ? '' : raw.indexOf('%') === -1 ? raw : safeDecode(raw)
    }
    return { value: target.value, params }
  }

  /** Methods that have at least one route matching `path`. Used for 405 responses. */
  allowed(path: string): string[] {
    const out: string[] = []
    const methods = new Set([...this._staticMethods, ...this._dynamic.keys()])
    for (const m of methods) if (this.match(m, path)) out.push(m)
    return out
  }

  private compile(method: string): Compiled<T> | null {
    const routes = this._dynamic.get(method)
    if (!routes || routes.length === 0) {
      this._compiled[method] = null
      return null
    }
    const sorted = [...routes].sort((a, b) => compareRank(a.rank, b.rank))
    const targets: Compiled<T>['targets'] = []
    let group = 1
    const alternatives = sorted.map((r) => {
      const names: string[] = []
      let src = '()'
      const marker = group++
      let wildcard = false
      for (const seg of r.segments) {
        if (seg === '*') {
          src += '(?:/(.*))?'
          names.push('*')
          wildcard = true
          group++
        } else if (seg.charCodeAt(0) === 58) {
          src += '/([^/]+)'
          names.push(seg.slice(1))
          group++
        } else {
          src += `/${escapeRegExp(seg)}`
        }
      }
      if (r.segments.length === 1 && r.segments[0] === '*') src = '()(?:/(.*))?'
      targets[marker] = { value: r.value, names, wildcard }
      return src
    })
    const compiled: Compiled<T> = { re: new RegExp(`^(?:${alternatives.join('|')})$`), targets }
    this._compiled[method] = compiled
    return compiled
  }
}

function compareRank(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return b.length - a.length
}

function shapeOf(segments: string[]): string {
  return segments.map((s) => (s === '*' ? '*' : s.charCodeAt(0) === 58 ? ':' : s)).join('/')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function safeDecode(s: string): string {
  if (s.indexOf('%') === -1) return s
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

export function normalizePath(path: string): string {
  if (path === '' || path === '/') return '/'
  let p = path.charCodeAt(0) === 47 ? path : `/${path}`
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p.replace(/\/{2,}/g, '/')
}

/** Extract the pathname from a request URL without allocating a URL object. */
export function getPath(url: string): string {
  // Skip "scheme://host"
  const start = url.indexOf('/', url.indexOf(':') + 4)
  if (start === -1) return '/'
  let end = start
  for (; end < url.length; end++) {
    const c = url.charCodeAt(end)
    if (c === 63 /* ? */ || c === 35 /* # */) break
  }
  return url.slice(start, end)
}

/** Compile a middleware path pattern (`*`, `/api/*`, `/exact`, `/users/:id`) into a fast predicate. */
export function compilePattern(pattern: string): (path: string) => boolean {
  if (pattern === '*' || pattern === '/*') return () => true
  const p = normalizePath(pattern)
  if (p.endsWith('/*') && !p.slice(0, -2).includes(':') && !p.slice(0, -2).includes('*')) {
    const prefix = p.slice(0, -2)
    const prefixSlash = `${prefix}/`
    return (path) => path === prefix || path.startsWith(prefixSlash)
  }
  if (!p.includes(':') && !p.includes('*')) {
    return (path) => path === p || path === `${p}/`
  }
  const re = new RegExp(
    `^${p
      .split('/')
      .map((s) => (s === '*' ? '.*' : s.startsWith(':') ? '[^/]+' : s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')))
      .join('/')}/?$`,
  )
  return (path) => re.test(path)
}
