/**
 * Generate an OpenAPI 3.1 document from a Mach app's routes and schemas.
 *
 * ```ts
 * import { openapi } from 'machjs/openapi'
 * app.get('/openapi.json', () => openapi(app, { info: { title: 'My API', version: '1.0.0' } }))
 * ```
 */
import type { Mach, RouteInfo, RouteResponseDoc } from './mach.js'
import { isStandardSchema, type JSONSchema, toJSONSchema } from './schema/standard.js'

export interface OpenAPIOptions {
  info: { title: string; version: string; description?: string; [key: string]: unknown }
  servers?: { url: string; description?: string }[]
  /** Extra top-level fields (components.securitySchemes, security, tags, ...). */
  extend?: Record<string, unknown>
}

export type OpenAPIDocument = {
  openapi: '3.1.0'
  info: OpenAPIOptions['info']
  paths: Record<string, Record<string, unknown>>
  [key: string]: unknown
}

const DOC_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'])

const VALIDATION_ERROR: JSONSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    target: { type: 'string' },
    issues: {
      type: 'array',
      items: { type: 'object', properties: { message: { type: 'string' }, path: { type: 'string' } }, required: ['message', 'path'] },
    },
  },
  required: ['error'],
}

export function openapi(app: Mach<any>, options: OpenAPIOptions): OpenAPIDocument {
  const paths: OpenAPIDocument['paths'] = {}
  const usedIds = new Set<string>()

  for (const route of app.routes) {
    if (route.docs?.hidden || !DOC_METHODS.has(route.method)) continue
    if (route.method === 'HEAD' || route.method === 'OPTIONS') {
      if (!route.docs) continue // usually framework plumbing
    }
    for (const variant of expandOptional(route.path)) {
      const { path, params } = toOpenAPIPath(variant)
      const op = operation(route, params, usedIds)
      ;(paths[path] ??= {})[route.method.toLowerCase()] = op
    }
  }

  return {
    openapi: '3.1.0',
    info: options.info,
    ...(options.servers && { servers: options.servers }),
    paths,
    ...options.extend,
  }
}

/** `/docs/:page?` → [`/docs`, `/docs/:page`] (OpenAPI has no optional path params). */
function expandOptional(path: string): string[] {
  const m = /\/:([A-Za-z0-9_]+)\?$/.exec(path)
  if (!m) return [path]
  return [path.slice(0, m.index) || '/', path.slice(0, -1)]
}

function toOpenAPIPath(path: string): { path: string; params: string[] } {
  const params: string[] = []
  const out = path
    .split('/')
    .map((seg) => {
      if (seg === '*') {
        params.push('*')
        return '{wildcard}'
      }
      if (seg.startsWith(':')) {
        params.push(seg.slice(1))
        return `{${seg.slice(1)}}`
      }
      return seg
    })
    .join('/')
  return { path: out || '/', params }
}

function operation(route: RouteInfo, pathParams: string[], usedIds: Set<string>): Record<string, unknown> {
  const { schemas, docs } = route
  const op: Record<string, unknown> = {}
  if (docs?.summary) op.summary = docs.summary
  if (docs?.description) op.description = docs.description
  if (docs?.tags) op.tags = docs.tags
  if (docs?.deprecated) op.deprecated = true
  op.operationId = uniqueId(docs?.operationId ?? defaultOperationId(route.method, route.path), usedIds)

  const parameters: Record<string, unknown>[] = []
  const paramsSchema = schemaOf(schemas.params)
  for (const name of pathParams) {
    parameters.push({
      name: name === '*' ? 'wildcard' : name,
      in: 'path',
      required: true,
      schema: propertyOf(paramsSchema, name) ?? { type: 'string' },
    })
  }
  parameters.push(...objectParameters(schemaOf(schemas.query), 'query'))
  parameters.push(...objectParameters(schemaOf(schemas.headers), 'header'))
  if (parameters.length) op.parameters = parameters

  if (docs?.requestBody) {
    op.requestBody = { required: true, content: content(docs.requestBody) }
  } else if (schemas.body) {
    op.requestBody = { required: true, content: { 'application/json': { schema: schemaOf(schemas.body) ?? {} } } }
  }

  const responses: Record<string, unknown> = {}
  if (docs?.responses) {
    for (const [status, r] of Object.entries(docs.responses)) {
      responses[status] = { description: r.description ?? defaultDescription(status), ...(r.schema !== undefined && { content: content(r) }) }
    }
  }
  if (!responses['200'] && !Object.keys(responses).some((s) => s.startsWith('2'))) {
    responses['200'] = schemas.response
      ? { description: 'OK', content: { 'application/json': { schema: schemaOf(schemas.response) ?? {} } } }
      : { description: 'OK' }
  }
  if ((schemas.body || schemas.query || schemas.params || schemas.headers) && !responses['400']) {
    responses['400'] = { description: 'Invalid request', content: { 'application/json': { schema: VALIDATION_ERROR } } }
  }
  op.responses = responses
  return op
}

function content(doc: RouteResponseDoc): Record<string, unknown> {
  const schema = isStandardSchema(doc.schema) ? (schemaOf(doc.schema) ?? {}) : (doc.schema ?? {})
  return { [doc.contentType ?? 'application/json']: { schema } }
}

function schemaOf(schema: unknown): JSONSchema | undefined {
  if (schema === undefined) return undefined
  return toJSONSchema(schema)
}

function propertyOf(schema: JSONSchema | undefined, name: string): JSONSchema | undefined {
  const props = schema?.properties as Record<string, JSONSchema> | undefined
  return props?.[name]
}

function objectParameters(schema: JSONSchema | undefined, where: 'query' | 'header'): Record<string, unknown>[] {
  const props = schema?.properties as Record<string, JSONSchema> | undefined
  if (!props) return []
  const required = new Set((schema?.required as string[] | undefined) ?? [])
  return Object.entries(props).map(([name, prop]) => {
    const { description, ...rest } = prop
    return {
      name,
      in: where,
      required: required.has(name),
      ...(typeof description === 'string' && { description }),
      schema: rest,
    }
  })
}

function defaultOperationId(method: string, path: string): string {
  const words = path
    .split('/')
    .filter(Boolean)
    .map((seg) => (seg === '*' ? 'wildcard' : seg.startsWith(':') ? `by ${seg.slice(1).replace(/\?$/, '')}` : seg))
    .join(' ')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  return [method.toLowerCase(), ...words.map((w) => w[0]!.toUpperCase() + w.slice(1))].join('') || method.toLowerCase()
}

function uniqueId(id: string, used: Set<string>): string {
  let out = id
  for (let i = 2; used.has(out); i++) out = `${id}${i}`
  used.add(out)
  return out
}

function defaultDescription(status: string): string {
  if (status.startsWith('2')) return 'OK'
  if (status === '400') return 'Bad Request'
  if (status === '401') return 'Unauthorized'
  if (status === '403') return 'Forbidden'
  if (status === '404') return 'Not Found'
  if (status === '429') return 'Too Many Requests'
  return 'Response'
}
