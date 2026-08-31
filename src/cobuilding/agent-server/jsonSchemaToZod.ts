/**
 * JSON Schema → zod, for hosted MCP tools (`docs/design/mcp-hosting.md`,
 * Increment 4, spike S2a).
 *
 * `tool()` (`sdk.d.ts:5368`) wants an `AnyZodRawShape` — a PLAIN OBJECT whose
 * values are zod types, not a `ZodObject`. Every relay Acabox ships today
 * hand-writes that shape (see `createMcpRelayServers` in `index.ts`). A hosted
 * server's tools are discovered at runtime from whatever `tools/list` returns,
 * so this module builds the same shape from a third party's JSON Schema
 * instead.
 *
 * MEASURED, not assumed, before writing this:
 * - `zod@4.3.6` is what's on disk (`package.json`), and `.describe()` set
 *   BEFORE `.optional()` does not survive the wrap — `z.string().describe('x').optional().description`
 *   is `undefined`, while `z.string().optional().describe('x').description` is
 *   `'x'`. So every property builder here applies `.optional()` first and
 *   `.describe()` last; getting the order backwards silently drops the text
 *   the model is supposed to read, with no type error to catch it.
 * - `z.record()` in this zod version takes TWO arguments (key schema, value
 *   schema) — `z.record(z.string(), z.unknown())` — matching the one existing
 *   use of it in `index.ts` (`call_published_tool`'s `arguments` field).
 *
 * NEVER THROW. `inputSchema` comes from a third-party stdio server the user
 * chose to run, over which Acabox has no authorship. A malformed, partial, or
 * deliberately hostile schema must degrade to `z.unknown()` at the offending
 * node and keep going — a tool call sent through the resulting shape is
 * strictly less safe than a correctly typed one, but a tool that VANISHES
 * because its schema had a typo is a worse outcome: the model loses the
 * capability entirely, with nothing in the transcript explaining why.
 *
 * RECURSION DEPTH is capped (`MAX_DEPTH`) so a schema that references itself
 * through nested `properties`/`items` (accidentally, or as an attempted DoS —
 * this is untrusted input) cannot recurse the process into a stack overflow.
 * Past the cap, whatever remains degrades to `z.unknown()` exactly like any
 * other unhandled shape; there is no special error for it.
 */
import { z } from 'zod';

/** Matches `freePort.ts`'s "cap something that could otherwise be unbounded" posture — 10 levels comfortably covers any realistic tool schema (the deepest shipped relay tool here, `notification.show_notification`'s `navigation` field, is 2 levels) while still being a hard ceiling. */
const MAX_DEPTH = 10;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function descriptionOf(schema: Record<string, unknown>): string | undefined {
  return typeof schema.description === 'string' ? schema.description : undefined;
}

function requiredSetOf(schema: Record<string, unknown>): Set<string> {
  const required = schema.required;
  if (!Array.isArray(required)) return new Set();
  return new Set(required.filter((r): r is string => typeof r === 'string'));
}

/**
 * The structural conversion, with NO `.optional()`/`.describe()` applied —
 * callers decide those, because only a property's own container (an object's
 * `properties` entry) has an optionality concept, and `.describe()` must be
 * the outermost call (see the module comment) so it has to happen after any
 * `.optional()` wrap, not inside this function.
 */
function baseType(schema: unknown, depth: number): z.ZodTypeAny {
  if (depth > MAX_DEPTH) return z.unknown();
  if (!isPlainObject(schema)) return z.unknown();

  // No resolvable type at all, or a shape this module deliberately does not
  // attempt to resolve. `$ref` would need the rest of the schema document
  // (defs/$defs) that `tools/list` does not carry alongside inputSchema;
  // `anyOf`/`oneOf` would need a discriminated union guess with no reliable
  // signal. Both degrade rather than guess wrong.
  if ('$ref' in schema || 'anyOf' in schema || 'oneOf' in schema) {
    return z.unknown();
  }

  switch (schema.type) {
    case 'string': {
      const enumValues = schema.enum;
      if (Array.isArray(enumValues) && enumValues.length > 0 && enumValues.every((v) => typeof v === 'string')) {
        return z.enum(enumValues as [string, ...string[]]);
      }
      return z.string();
    }
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'array': {
      const itemType = 'items' in schema ? withDescription(baseType(schema.items, depth + 1), schema.items) : z.unknown();
      return z.array(itemType);
    }
    case 'object': {
      const properties = schema.properties;
      if (!isPlainObject(properties)) {
        // No declared properties — an open dictionary, not "no arguments".
        // (The all-the-way-at-the-top case, a tool with no inputSchema at
        // all, is handled separately by `jsonSchemaToZod` below and yields
        // `{}`, not this.)
        return z.record(z.string(), z.unknown());
      }
      const required = requiredSetOf(schema);
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, propSchema] of Object.entries(properties)) {
        shape[key] = buildProperty(propSchema, required.has(key), depth + 1);
      }
      return z.object(shape);
    }
    default:
      // Absent `type`, or a value this module doesn't recognise (`null`,
      // a `type` array, a future JSON Schema keyword). Untyped is not the
      // same failure as malformed, but the outcome is identical: the tool
      // stays callable with a loose type instead of vanishing.
      return z.unknown();
  }
}

function withDescription(zodType: z.ZodTypeAny, schema: unknown): z.ZodTypeAny {
  if (!isPlainObject(schema)) return zodType;
  const description = descriptionOf(schema);
  return description ? zodType.describe(description) : zodType;
}

/** One object property: structure, then `.optional()` if not required, then `.describe()` last — see the module comment on why that order is load-bearing. */
function buildProperty(schema: unknown, required: boolean, depth: number): z.ZodTypeAny {
  let zodType = baseType(schema, depth);
  if (!required) zodType = zodType.optional();
  return withDescription(zodType, schema);
}

/**
 * Convert a tool's `inputSchema` into the raw shape `tool()` wants.
 *
 * Returns `{}` — a valid, empty, callable shape — for anything that isn't a
 * usable object schema: no `inputSchema`, a non-object `inputSchema` (a tool
 * that (mis)declares its whole input as e.g. a bare string), or an object
 * schema with no `properties`. This is deliberately NOT the same as the
 * nested "object with no properties" case inside `baseType` (which becomes an
 * open `z.record`): there is no way to represent "the whole argument list is
 * an open dictionary" as a raw shape — a raw shape is inherently a set of
 * named keys — so the honest degradation at the top is "this tool takes no
 * typed arguments", not a fabricated wildcard key.
 *
 * `type` is treated as `'object'` when absent, because real-world tool
 * schemas routinely omit it and imply object-ness by having `properties` —
 * MCP's own reference servers do this. An EXPLICIT non-object `type` is
 * still refused.
 *
 * DECLARED RETURN TYPE, measured rather than assumed: this returns
 * `Record<string, z.ZodTypeAny>`, not the SDK's own `AnyZodRawShape` alias,
 * even though the two describe the same runtime shape and the former is
 * assignable everywhere the latter is expected (including `tool()`'s
 * `Schema extends AnyZodRawShape` parameter — see its use in `index.ts`).
 * `AnyZodRawShape` resolves (via `zod`'s own `ZodRawShape = core.$ZodShape`)
 * to a value type of the CORE, generic-erased `$ZodType`, which does not
 * statically expose `.safeParse()`/`.optional()`/`.describe()` — those live
 * on the "classic" `ZodType` interface that `z.string()` etc. actually
 * return. Typing the working shape (and this return) as `AnyZodRawShape`
 * would make every property unusable to a caller without a manual cast, for
 * no runtime benefit — confirmed by hitting exactly that wall while writing
 * `jsonSchemaToZod.test.ts`.
 */
export function jsonSchemaToZod(inputSchema: unknown): Record<string, z.ZodTypeAny> {
  if (!isPlainObject(inputSchema)) return {};
  if (inputSchema.type !== undefined && inputSchema.type !== 'object') return {};

  const properties = inputSchema.properties;
  if (!isPlainObject(properties)) return {};

  const required = requiredSetOf(inputSchema);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, propSchema] of Object.entries(properties)) {
    shape[key] = buildProperty(propSchema, required.has(key), 1);
  }
  return shape;
}
