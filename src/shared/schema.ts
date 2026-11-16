// A JSON Schema validator for the subset Grok Link supports: type, properties, required, items, enum,
// additionalProperties: false, minItems, maxItems. Other keywords are ignored.

export type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  additionalProperties?: boolean | Schema;
  minItems?: number;
  maxItems?: number;
};
export type Validation = { ok: true } | { ok: false; errors: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function hasType(v: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isObject(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    default:
      return false;
  }
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]));
  }
  return false;
}

const pointer = (path: string, key: string | number) => `${path}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
const where = (path: string) => path || "/";

function check(v: unknown, s: Schema, path: string, errors: string[]): void {
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => hasType(v, t))) {
      errors.push(`${where(path)}: expected ${types.join(" or ")}, got ${typeOf(v)}`);
      return;
    }
  }
  if (s.enum !== undefined && !s.enum.some((e) => equal(e, v)))
    errors.push(`${where(path)}: must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  if (isObject(v)) {
    for (const k of s.required ?? []) if (!Object.hasOwn(v, k)) errors.push(`${where(path)}: missing required property "${k}"`);
    for (const [k, sub] of Object.entries(s.properties ?? {})) if (Object.hasOwn(v, k)) check(v[k], sub, pointer(path, k), errors);
    if (s.additionalProperties === false)
      for (const k of Object.keys(v)) if (!Object.hasOwn(s.properties ?? {}, k)) errors.push(`${pointer(path, k)}: property not allowed`);
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems)
      errors.push(`${where(path)}: needs at least ${s.minItems} items, has ${v.length}`);
    if (s.maxItems !== undefined && v.length > s.maxItems)
      errors.push(`${where(path)}: allows at most ${s.maxItems} items, has ${v.length}`);
    const items = s.items;
    if (items) for (const [i, x] of v.entries()) check(x, items, pointer(path, i), errors);
  }
}

/** Validate `value` against `schema`; errors start with the JSON pointer of the failing value ("/" for the root). */
export function validate(value: unknown, schema: Schema): Validation {
  const errors: string[] = [];
  check(value, schema, "", errors);
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** The body of the last ```json fenced block in `text`, or null if there's none. */
export function lastJsonBlock(text: string): string | null {
  let last: string | null = null;
  for (const m of text.matchAll(/```json[^\S\n]*\n([\s\S]*?)```/g)) last = m[1];
  return last;
}
