/**
 * `s`: a tiny schema builder that validates at runtime, infers TypeScript types,
 * emits JSON Schema (for LLM tools and MCP), and implements Standard Schema
 * (so it plugs into anything that accepts Zod/Valibot).
 *
 * ```ts
 * const Weather = s.object({
 *   city: s.string().describe('City name'),
 *   unit: s.enum(['c', 'f']).optional(),
 * })
 * type Weather = s.infer<typeof Weather> // { city: string; unit?: 'c' | 'f' }
 * ```
 */
import type { JSONSchema, StandardSchemaV1 } from './standard.js'

export type { StandardSchemaV1, JSONSchema, InferOutput } from './standard.js'
export { validate, isStandardSchema, toJSONSchema } from './standard.js'

type Issue = { message: string; path: PropertyKey[] }
type Ctx = { issues: Issue[]; path: PropertyKey[] }

const INVALID: unique symbol = Symbol('invalid')
type Invalid = typeof INVALID

export abstract class Schema<Out = unknown, Optional extends boolean = false> implements StandardSchemaV1<unknown, Out> {
  /** @internal phantom type */
  declare readonly _out: Out
  /** @internal phantom flag */
  declare readonly _optional: Optional
  protected _description: string | undefined
  protected _default: { value: unknown } | undefined
  protected _optionalFlag = false
  protected _nullable = false

  protected abstract check(value: unknown, ctx: Ctx): unknown | Invalid
  protected abstract json(): JSONSchema

  /** @internal */
  _run(value: unknown, ctx: Ctx): unknown | Invalid {
    if (value === undefined) {
      if (this._default) return structuredCloneSafe(this._default.value)
      if (this._optionalFlag) return undefined
    }
    if (value === null && this._nullable) return null
    return this.check(value, ctx)
  }

  /** @internal */
  get _isOptional(): boolean {
    return this._optionalFlag || this._default !== undefined
  }

  get '~standard'(): StandardSchemaV1.Props<unknown, Out> {
    return {
      version: 1,
      vendor: 'mach',
      validate: (value) => this.safeParse(value),
    }
  }

  safeParse(value: unknown): StandardSchemaV1.Result<Out> {
    const ctx: Ctx = { issues: [], path: [] }
    const out = this._run(value, ctx)
    if (ctx.issues.length > 0 || out === INVALID) {
      return { issues: ctx.issues.length ? ctx.issues : [{ message: 'Invalid value', path: [] }] }
    }
    return { value: out as Out }
  }

  parse(value: unknown): Out {
    const result = this.safeParse(value)
    if (result.issues) {
      const msg = result.issues.map((i) => `${i.path?.length ? `${i.path.join('.')}: ` : ''}${i.message}`).join('; ')
      throw new TypeError(`Validation failed: ${msg}`)
    }
    return result.value
  }

  toJSONSchema(): JSONSchema {
    const base = this.json()
    const out: JSONSchema = { ...base }
    if (this._description !== undefined) out.description = this._description
    if (this._default !== undefined) out.default = this._default.value
    if (this._nullable) {
      if (typeof out.type === 'string') out.type = [out.type, 'null']
      else return { anyOf: [out, { type: 'null' }] }
    }
    return out
  }

  /** Human-readable description; surfaced to LLMs in tool schemas. */
  describe(description: string): this {
    const c = this.clone()
    c._description = description
    return c
  }

  optional(): Schema<Out | undefined, true> & Omit<this, '_out' | '_optional'> {
    const c = this.clone()
    c._optionalFlag = true
    return c as never
  }

  nullable(): Schema<Out | null, Optional> & Omit<this, '_out' | '_optional'> {
    const c = this.clone()
    c._nullable = true
    return c as never
  }

  /** Value used when the input is undefined. The output key is always present. */
  default(value: Exclude<Out, undefined>): Schema<Exclude<Out, undefined>, false> & Omit<this, '_out' | '_optional'> {
    const c = this.clone()
    c._default = { value }
    return c as never
  }

  protected clone(): this {
    return Object.assign(Object.create(Object.getPrototypeOf(this)), this)
  }
}

function structuredCloneSafe<T>(v: T): T {
  return v !== null && typeof v === 'object' ? structuredClone(v) : v
}

function issue(ctx: Ctx, message: string): Invalid {
  ctx.issues.push({ message, path: [...ctx.path] })
  return INVALID
}

function typeName(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

// ─── Primitives ──────────────────────────────────────────────────────────────

export interface StringOptions {
  min?: number
  max?: number
  pattern?: RegExp
  format?: 'email' | 'uri' | 'uuid' | 'date-time' | 'date'
}

const FORMATS: Record<NonNullable<StringOptions['format']>, RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uri: /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]*$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
}

export class StringSchema extends Schema<string> {
  constructor(private readonly opts: StringOptions = {}) {
    super()
  }
  protected check(v: unknown, ctx: Ctx) {
    if (typeof v !== 'string') return issue(ctx, `Expected string, received ${typeName(v)}`)
    const { min, max, pattern, format } = this.opts
    if (min !== undefined && v.length < min) return issue(ctx, `Must be at least ${min} character${min === 1 ? '' : 's'}`)
    if (max !== undefined && v.length > max) return issue(ctx, `Must be at most ${max} character${max === 1 ? '' : 's'}`)
    if (pattern && !pattern.test(v)) return issue(ctx, `Must match ${pattern}`)
    if (format && !FORMATS[format].test(v)) return issue(ctx, `Must be a valid ${format}`)
    return v
  }
  protected json(): JSONSchema {
    const { min, max, pattern, format } = this.opts
    return {
      type: 'string',
      ...(min !== undefined && { minLength: min }),
      ...(max !== undefined && { maxLength: max }),
      ...(pattern && { pattern: pattern.source }),
      ...(format && { format }),
    }
  }
}

export interface NumberOptions {
  min?: number
  max?: number
  int?: boolean
}

export class NumberSchema extends Schema<number> {
  constructor(private readonly opts: NumberOptions = {}, private readonly coerce = false) {
    super()
  }
  protected check(v: unknown, ctx: Ctx) {
    let n = v
    if (this.coerce && typeof v === 'string' && v.trim() !== '') n = Number(v)
    if (typeof n !== 'number' || Number.isNaN(n)) return issue(ctx, `Expected number, received ${typeName(v)}`)
    const { min, max, int } = this.opts
    if (int && !Number.isInteger(n)) return issue(ctx, 'Expected integer')
    if (min !== undefined && n < min) return issue(ctx, `Must be >= ${min}`)
    if (max !== undefined && n > max) return issue(ctx, `Must be <= ${max}`)
    return n
  }
  protected json(): JSONSchema {
    const { min, max, int } = this.opts
    return {
      type: int ? 'integer' : 'number',
      ...(min !== undefined && { minimum: min }),
      ...(max !== undefined && { maximum: max }),
    }
  }
}

export class BooleanSchema extends Schema<boolean> {
  constructor(private readonly coerce = false) {
    super()
  }
  protected check(v: unknown, ctx: Ctx) {
    if (this.coerce && typeof v === 'string') {
      if (v === 'true' || v === '1') return true
      if (v === 'false' || v === '0') return false
    }
    if (typeof v !== 'boolean') return issue(ctx, `Expected boolean, received ${typeName(v)}`)
    return v
  }
  protected json(): JSONSchema {
    return { type: 'boolean' }
  }
}

type Literal = string | number | boolean | null

export class LiteralSchema<T extends Literal> extends Schema<T> {
  constructor(private readonly value: T) {
    super()
  }
  protected check(v: unknown, ctx: Ctx) {
    return v === this.value ? v : issue(ctx, `Expected ${JSON.stringify(this.value)}`)
  }
  protected json(): JSONSchema {
    return { const: this.value }
  }
}

export class EnumSchema<T extends readonly [string, ...string[]]> extends Schema<T[number]> {
  readonly options: T
  constructor(values: T) {
    super()
    this.options = values
  }
  protected check(v: unknown, ctx: Ctx) {
    return typeof v === 'string' && this.options.includes(v)
      ? v
      : issue(ctx, `Expected one of ${this.options.map((o) => JSON.stringify(o)).join(', ')}`)
  }
  protected json(): JSONSchema {
    return { type: 'string', enum: [...this.options] }
  }
}

export class UnknownSchema<T = unknown> extends Schema<T> {
  protected check(v: unknown) {
    return v
  }
  protected json(): JSONSchema {
    return {}
  }
}

// ─── Composites ──────────────────────────────────────────────────────────────

export class ArraySchema<S extends Schema<any, any>> extends Schema<Array<S['_out']>> {
  constructor(private readonly item: S, private readonly opts: { min?: number; max?: number } = {}) {
    super()
  }
  protected check(v: unknown, ctx: Ctx) {
    if (!Array.isArray(v)) return issue(ctx, `Expected array, received ${typeName(v)}`)
    const { min, max } = this.opts
    if (min !== undefined && v.length < min) return issue(ctx, `Must contain at least ${min} item${min === 1 ? '' : 's'}`)
    if (max !== undefined && v.length > max) return issue(ctx, `Must contain at most ${max} item${max === 1 ? '' : 's'}`)
    const out: unknown[] = new Array(v.length)
    let ok = true
    for (let i = 0; i < v.length; i++) {
      ctx.path.push(i)
      const r = this.item._run(v[i], ctx)
      ctx.path.pop()
      if (r === INVALID) ok = false
      else out[i] = r
    }
    return ok ? out : INVALID
  }
  protected json(): JSONSchema {
    const { min, max } = this.opts
    return {
      type: 'array',
      items: this.item.toJSONSchema(),
      ...(min !== undefined && { minItems: min }),
      ...(max !== undefined && { maxItems: max }),
    }
  }
}

export type Shape = Record<string, Schema<any, any>>

type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K]['_optional'] extends true ? K : never }[keyof S]
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>
type Simplify<T> = { [K in keyof T]: T[K] } & {}
export type ObjectOutput<S extends Shape> = Simplify<
  { [K in RequiredKeys<S>]: S[K]['_out'] } & { [K in OptionalKeys<S>]?: Exclude<S[K]['_out'], undefined> }
>

export class ObjectSchema<S extends Shape> extends Schema<ObjectOutput<S>> {
  readonly shape: S
  protected _passthrough = false
  constructor(shape: S) {
    super()
    this.shape = shape
  }
  /** Keep unknown keys instead of stripping them. */
  passthrough(): this {
    const c = this.clone()
    c._passthrough = true
    return c
  }
  protected check(v: unknown, ctx: Ctx) {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return issue(ctx, `Expected object, received ${typeName(v)}`)
    }
    const input = v as Record<string, unknown>
    const out: Record<string, unknown> = this._passthrough ? { ...input } : {}
    let ok = true
    for (const key in this.shape) {
      const schema = this.shape[key]!
      ctx.path.push(key)
      const r = schema._run(input[key], ctx)
      ctx.path.pop()
      if (r === INVALID) {
        if (input[key] === undefined && !schema._isOptional && ctx.issues.at(-1)?.path.at(-1) === key) {
          ctx.issues[ctx.issues.length - 1]!.message = 'Required'
        }
        ok = false
      } else if (r !== undefined || key in input) {
        out[key] = r
      }
    }
    return ok ? out : INVALID
  }
  protected json(): JSONSchema {
    const properties: Record<string, JSONSchema> = {}
    const required: string[] = []
    for (const key in this.shape) {
      const schema = this.shape[key]!
      properties[key] = schema.toJSONSchema()
      if (!schema._isOptional) required.push(key)
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 && { required }),
      additionalProperties: this._passthrough,
    }
  }
}

export class UnionSchema<T extends readonly Schema<any, any>[]> extends Schema<T[number]['_out']> {
  constructor(private readonly options: T) {
    super()
  }
  protected check(v: unknown, ctx: Ctx) {
    for (const option of this.options) {
      const sub: Ctx = { issues: [], path: [...ctx.path] }
      const r = option._run(v, sub)
      if (r !== INVALID && sub.issues.length === 0) return r
    }
    return issue(ctx, 'Did not match any allowed type')
  }
  protected json(): JSONSchema {
    return { anyOf: this.options.map((o) => o.toJSONSchema()) }
  }
}

export class RecordSchema<V extends Schema<any, any>> extends Schema<Record<string, V['_out']>> {
  constructor(private readonly value: V) {
    super()
  }
  protected check(v: unknown, ctx: Ctx) {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      return issue(ctx, `Expected object, received ${typeName(v)}`)
    }
    const out: Record<string, unknown> = {}
    let ok = true
    for (const [k, val] of Object.entries(v)) {
      ctx.path.push(k)
      const r = this.value._run(val, ctx)
      ctx.path.pop()
      if (r === INVALID) ok = false
      else out[k] = r
    }
    return ok ? out : INVALID
  }
  protected json(): JSONSchema {
    return { type: 'object', additionalProperties: this.value.toJSONSchema() }
  }
}

// ─── Builder ─────────────────────────────────────────────────────────────────

export const s = {
  string: (opts?: StringOptions) => new StringSchema(opts),
  number: (opts?: NumberOptions) => new NumberSchema(opts),
  integer: (opts?: Omit<NumberOptions, 'int'>) => new NumberSchema({ ...opts, int: true }),
  boolean: () => new BooleanSchema(),
  literal: <const T extends Literal>(value: T) => new LiteralSchema(value),
  enum: <const T extends readonly [string, ...string[]]>(values: T) => new EnumSchema(values),
  array: <S extends Schema<any, any>>(item: S, opts?: { min?: number; max?: number }) => new ArraySchema(item, opts),
  object: <S extends Shape>(shape: S) => new ObjectSchema(shape),
  record: <V extends Schema<any, any>>(value: V) => new RecordSchema(value),
  union: <const T extends readonly [Schema<any, any>, ...Schema<any, any>[]]>(options: T) => new UnionSchema(options),
  unknown: () => new UnknownSchema(),
  any: () => new UnknownSchema<any>(),
  /** Coercing variants for query strings, params and headers (always strings on the wire). */
  coerce: {
    number: (opts?: NumberOptions) => new NumberSchema(opts, true),
    integer: (opts?: Omit<NumberOptions, 'int'>) => new NumberSchema({ ...opts, int: true }, true),
    boolean: () => new BooleanSchema(true),
  },
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace s {
  export type infer<T extends Schema<any, any>> = T['_out']
}

export type Infer<T extends Schema<any, any>> = T['_out']
