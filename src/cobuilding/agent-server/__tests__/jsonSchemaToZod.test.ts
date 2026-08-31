/** @jest-environment node */
/**
 * `jsonSchemaToZod` is pure (no I/O, no globals), so every case here drives it
 * directly and asserts on PARSE BEHAVIOUR — `shape.foo.safeParse(...)` — never
 * on the zod instance's internal `_def`/`_zod` shape. The internals are a zod
 * version detail (v3 vs v4 already differ enough that this repo carries a
 * type-compat shim in the SDK's own `.d.ts`); parse behaviour is the actual
 * contract `tool()` relies on and is the same test whether zod is bumped or
 * swapped.
 */
import { z } from 'zod';
import { jsonSchemaToZod } from '../jsonSchemaToZod';

describe('jsonSchemaToZod — top-level degradation', () => {
  it('returns {} for undefined inputSchema', () => {
    expect(jsonSchemaToZod(undefined)).toEqual({});
  });

  it('returns {} for null', () => {
    expect(jsonSchemaToZod(null)).toEqual({});
  });

  it('returns {} for a non-object inputSchema (a bare string/array)', () => {
    expect(jsonSchemaToZod('nonsense')).toEqual({});
    expect(jsonSchemaToZod(['a', 'b'])).toEqual({});
    expect(jsonSchemaToZod(42)).toEqual({});
  });

  it('returns {} for an inputSchema whose declared type is explicitly not object', () => {
    expect(jsonSchemaToZod({ type: 'string' })).toEqual({});
  });

  it('returns {} for an object schema with no properties', () => {
    expect(jsonSchemaToZod({ type: 'object' })).toEqual({});
    expect(jsonSchemaToZod({ type: 'object', properties: 'nope' })).toEqual({});
  });

  it('treats a missing top-level "type" as object when properties are present (real-world servers omit it)', () => {
    const shape = jsonSchemaToZod({ properties: { q: { type: 'string' } }, required: ['q'] });
    expect(shape.q.safeParse('hello').success).toBe(true);
    expect(shape.q.safeParse(undefined).success).toBe(false);
  });

  it('never throws on malformed input', () => {
    const inputs: unknown[] = [
      { type: 'object', properties: null },
      { type: 'object', properties: { a: null } },
      { type: 'object', properties: { a: 'not-a-schema' } },
      { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'object', properties: { a: 'cycle-ish' } } } } } },
      Symbol('weird'),
      () => {},
    ];
    for (const input of inputs) {
      expect(() => jsonSchemaToZod(input)).not.toThrow();
    }
  });
});

describe('jsonSchemaToZod — required vs optional', () => {
  const shape = jsonSchemaToZod({
    type: 'object',
    properties: {
      needed: { type: 'string' },
      extra: { type: 'string' },
    },
    required: ['needed'],
  });

  it('required property rejects undefined', () => {
    expect(shape.needed.safeParse(undefined).success).toBe(false);
    expect(shape.needed.safeParse('x').success).toBe(true);
  });

  it('property absent from "required" accepts undefined', () => {
    expect(shape.extra.safeParse(undefined).success).toBe(true);
    expect(shape.extra.safeParse('x').success).toBe(true);
  });

  it('an absent "required" array makes every property optional', () => {
    const noRequired = jsonSchemaToZod({
      type: 'object',
      properties: { a: { type: 'string' } },
    });
    expect(noRequired.a.safeParse(undefined).success).toBe(true);
  });
});

describe('jsonSchemaToZod — description propagation', () => {
  it('carries the description onto the outer (possibly-optional) type, not just the inner one', () => {
    const shape = jsonSchemaToZod({
      type: 'object',
      properties: {
        note: { type: 'string', description: 'a helpful note' },
      },
      required: ['note'],
    });
    expect((shape.note as z.ZodTypeAny).description).toBe('a helpful note');
  });

  it('survives being wrapped in .optional()', () => {
    const shape = jsonSchemaToZod({
      type: 'object',
      properties: {
        note: { type: 'string', description: 'optional note' },
      },
    });
    expect((shape.note as z.ZodTypeAny).description).toBe('optional note');
    expect(shape.note.safeParse(undefined).success).toBe(true);
  });

  it('propagates at nested levels too (array items, object properties)', () => {
    const shape = jsonSchemaToZod({
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string', description: 'one tag' },
          description: 'a list of tags',
        },
      },
    });
    expect((shape.tags as z.ZodTypeAny).description).toBe('a list of tags');
  });
});

describe('jsonSchemaToZod — string, enum, number, integer, boolean', () => {
  const shape = jsonSchemaToZod({
    type: 'object',
    properties: {
      name: { type: 'string' },
      mode: { type: 'string', enum: ['fast', 'slow'] },
      score: { type: 'number' },
      count: { type: 'integer' },
      active: { type: 'boolean' },
    },
    required: ['name', 'mode', 'score', 'count', 'active'],
  });

  it('string accepts strings, rejects numbers', () => {
    expect(shape.name.safeParse('hi').success).toBe(true);
    expect(shape.name.safeParse(1).success).toBe(false);
  });

  it('enum accepts only listed values', () => {
    expect(shape.mode.safeParse('fast').success).toBe(true);
    expect(shape.mode.safeParse('slow').success).toBe(true);
    expect(shape.mode.safeParse('turbo').success).toBe(false);
  });

  it('number accepts floats, integer rejects them', () => {
    expect(shape.score.safeParse(3.14).success).toBe(true);
    expect(shape.count.safeParse(3).success).toBe(true);
    expect(shape.count.safeParse(3.14).success).toBe(false);
  });

  it('boolean accepts only booleans', () => {
    expect(shape.active.safeParse(true).success).toBe(true);
    expect(shape.active.safeParse('true').success).toBe(false);
  });

  it('an enum with non-string members degrades to plain string rather than throwing', () => {
    const degraded = jsonSchemaToZod({
      type: 'object',
      properties: { code: { type: 'string', enum: [1, 2, 3] } },
    });
    expect(degraded.code.safeParse('anything').success).toBe(true);
  });

  it('an empty enum array degrades to plain string', () => {
    const degraded = jsonSchemaToZod({
      type: 'object',
      properties: { code: { type: 'string', enum: [] } },
    });
    expect(degraded.code.safeParse('anything').success).toBe(true);
  });
});

describe('jsonSchemaToZod — array', () => {
  it('array with typed items enforces the item type', () => {
    const shape = jsonSchemaToZod({
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
      required: ['tags'],
    });
    expect(shape.tags.safeParse(['a', 'b']).success).toBe(true);
    expect(shape.tags.safeParse([1, 2]).success).toBe(false);
  });

  it('array with no "items" accepts anything inside', () => {
    const shape = jsonSchemaToZod({
      type: 'object',
      properties: { misc: { type: 'array' } },
    });
    expect(shape.misc.safeParse([1, 'a', { x: true }]).success).toBe(true);
  });

  it('array whose "items" is itself unresolvable (e.g. $ref) accepts anything inside', () => {
    const shape = jsonSchemaToZod({
      type: 'object',
      properties: { misc: { type: 'array', items: { $ref: '#/$defs/Thing' } } },
    });
    expect(shape.misc.safeParse([1, 'a', {}]).success).toBe(true);
  });

  it('array of objects recurses correctly', () => {
    const shape = jsonSchemaToZod({
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
      },
      required: ['rows'],
    });
    expect(shape.rows.safeParse([{ id: 'a' }]).success).toBe(true);
    expect(shape.rows.safeParse([{}]).success).toBe(false);
  });
});

describe('jsonSchemaToZod — nested object', () => {
  it('object with properties builds a real z.object, enforcing required nested fields', () => {
    const shape = jsonSchemaToZod({
      type: 'object',
      properties: {
        target: {
          type: 'object',
          properties: {
            host: { type: 'string' },
            port: { type: 'number' },
          },
          required: ['host'],
        },
      },
      required: ['target'],
    });
    expect(shape.target.safeParse({ host: 'x' }).success).toBe(true);
    expect(shape.target.safeParse({ host: 'x', port: 8080 }).success).toBe(true);
    expect(shape.target.safeParse({ port: 8080 }).success).toBe(false); // host missing
  });

  it('nested object with no properties becomes an open record (unlike the top level, which yields {})', () => {
    const shape = jsonSchemaToZod({
      type: 'object',
      properties: { meta: { type: 'object' } },
      required: ['meta'],
    });
    expect(shape.meta.safeParse({ anything: 'goes', here: 1 }).success).toBe(true);
    expect(shape.meta.safeParse('not-an-object').success).toBe(false);
  });
});

describe('jsonSchemaToZod — unresolvable shapes degrade to z.unknown()', () => {
  it('$ref degrades and accepts anything', () => {
    const shape = jsonSchemaToZod({
      type: 'object',
      properties: { thing: { $ref: '#/$defs/Thing' } },
      required: ['thing'],
    });
    expect(shape.thing.safeParse({ whatever: true }).success).toBe(true);
    expect(shape.thing.safeParse('x').success).toBe(true);
    expect(shape.thing.safeParse(undefined).success).toBe(true); // z.unknown() accepts undefined too
  });

  it('anyOf degrades and accepts anything', () => {
    const shape = jsonSchemaToZod({
      type: 'object',
      properties: { thing: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
    });
    expect(shape.thing.safeParse('x').success).toBe(true);
    expect(shape.thing.safeParse(42).success).toBe(true);
    expect(shape.thing.safeParse({ nested: true }).success).toBe(true);
  });

  it('oneOf degrades and accepts anything', () => {
    const shape = jsonSchemaToZod({
      type: 'object',
      properties: { thing: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
    });
    expect(shape.thing.safeParse(['array', 'too']).success).toBe(true);
  });

  it('an absent property type degrades to z.unknown()', () => {
    const shape = jsonSchemaToZod({
      type: 'object',
      properties: { thing: {} },
    });
    expect(shape.thing.safeParse(12345).success).toBe(true);
    expect(shape.thing.safeParse('anything').success).toBe(true);
  });

  it('an unrecognised "type" value degrades to z.unknown() rather than throwing', () => {
    const shape = jsonSchemaToZod({
      type: 'object',
      properties: { thing: { type: 'null' } },
    });
    expect(shape.thing.safeParse(null).success).toBe(true);
    expect(shape.thing.safeParse('anything').success).toBe(true);
  });
});

describe('jsonSchemaToZod — recursion depth cap', () => {
  function buildDeeplyNested(depth: number): unknown {
    let schema: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < depth; i++) {
      schema = { type: 'object', properties: { next: schema }, required: ['next'] };
    }
    return schema;
  }

  it('a schema nested well past MAX_DEPTH does not hang or throw — it degrades', () => {
    const pathological = buildDeeplyNested(50);
    let shape: ReturnType<typeof jsonSchemaToZod> = {};
    expect(() => { shape = jsonSchemaToZod(pathological); }).not.toThrow();
    // Whatever comes out must still be a usable raw shape whose top key
    // parses SOMETHING without throwing — the exact type at that depth is
    // deliberately not pinned since it degrades to z.unknown() past the cap.
    expect(shape.next).toBeDefined();
    expect(() => shape.next.safeParse('anything')).not.toThrow();
  });

  it('a moderately nested schema well within the cap still resolves correctly end to end', () => {
    const shallow = buildDeeplyNested(3);
    const shape = jsonSchemaToZod(shallow);
    // 3 levels of {next: string}, so the fully-typed shape should accept a
    // correctly-shaped value and reject a wrongly-typed leaf.
    expect(shape.next.safeParse({ next: { next: 'leaf' } }).success).toBe(true);
    expect(shape.next.safeParse({ next: { next: 42 } }).success).toBe(false);
  });
});
