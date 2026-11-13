/**
 * Standard Schema v1 (https://standardschema.dev): the shared interface implemented by
 * Zod, Valibot, ArkType, Effect Schema and Mach's own `s` builder. Copied here so Mach
 * has zero dependencies.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>
}

export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>
    readonly types?: Types<Input, Output> | undefined
  }
  export type Result<Output> = SuccessResult<Output> | FailureResult
  export interface SuccessResult<Output> {
    readonly value: Output
    readonly issues?: undefined
  }
  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>
  }
  export interface Issue {
    readonly message: string
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined
  }
  export interface PathSegment {
    readonly key: PropertyKey
  }
  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input
    readonly output: Output
  }
  export type InferInput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['input']
  export type InferOutput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['output']
}

export type InferOutput<S> = S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : unknown

export type JSONSchema = { [key: string]: unknown }

/** Validate with any Standard Schema. */
export async function validate<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<StandardSchemaV1.Result<StandardSchemaV1.InferOutput<S>>> {
  let result = schema['~standard'].validate(value)
  if (result instanceof Promise) result = await result
  return result as StandardSchemaV1.Result<StandardSchemaV1.InferOutput<S>>
}

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { '~standard'?: { validate?: unknown } })['~standard']?.validate === 'function'
  )
}

/**
 * Get a JSON Schema for a schema, needed to describe tool inputs to LLMs.
 * Supports: Mach `s` schemas, the Standard JSON Schema extension (`~standard.jsonSchema`,
 * implemented by Zod ≥ 4.2, Valibot, ArkType), and anything with a `toJSONSchema()` method.
 */
export function toJSONSchema(schema: unknown): JSONSchema | undefined {
  if (!schema || typeof schema !== 'object') return undefined
  const std = (schema as { '~standard'?: { jsonSchema?: { input?: (o: unknown) => JSONSchema } } })['~standard']
  if (std?.jsonSchema?.input) {
    try {
      return stripMeta(std.jsonSchema.input({ target: 'draft-2020-12' }))
    } catch {
      /* fall through */
    }
  }
  const method = (schema as { toJSONSchema?: () => JSONSchema }).toJSONSchema
  if (typeof method === 'function') return stripMeta(method.call(schema))
  return undefined
}

function stripMeta(schema: JSONSchema): JSONSchema {
  if (!('$schema' in schema)) return schema
  const { $schema: _ignored, ...rest } = schema
  return rest
}
