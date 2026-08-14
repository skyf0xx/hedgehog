/**
 * The field DSL every layer generator shares, plus the one mapping from a
 * field type to its Drizzle column, its TypeScript type, and its Zod
 * schema. Owned here so the seven generators cannot drift from each other
 * on what `dueDate:timestamp?` means.
 *
 * Wire format (the `--fields` option): a comma-separated list of
 * `name:type` pairs, with a trailing `?` on the type marking the column
 * nullable — `title:string,done:boolean,dueDate:timestamp?`.
 *
 * A `string` takes an optional length in parentheses —
 * `title:string(500)`, or `title:string(500)?` when it is also nullable.
 * The value threads to both the Drizzle `varchar` and the Zod `.max()`,
 * so the two bounds are the same number by construction: a Zod bound that
 * outran its column would let an over-long value past validation and fail
 * at the driver as a 500 instead of a 400.
 */

export type FieldType =
  | 'string'
  | 'text'
  | 'boolean'
  | 'integer'
  | 'timestamp';

export interface Field {
  name: string;
  type: FieldType;
  nullable: boolean;
  /** Max characters for a `string`; undefined on every other type. */
  length?: number;
}

/** The `varchar` bound a `string` gets when the field list names none. */
export const DEFAULT_STRING_LENGTH = 255;

const FIELD_TYPES: readonly FieldType[] = [
  'string',
  'text',
  'boolean',
  'integer',
  'timestamp',
];

export function parseFields(raw: string): Field[] {
  const fields = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [name, rawType] = entry.split(':').map((part) => part.trim());
      if (!name || !rawType) {
        throw new Error(
          `Field "${entry}" is not in name:type form (e.g. title:string, dueDate:timestamp?).`,
        );
      }
      const nullable = rawType.endsWith('?');
      const bare = nullable ? rawType.slice(0, -1) : rawType;

      const sized = /^(\w+)\((\d+)\)$/.exec(bare);
      const type = (sized ? sized[1] : bare) as FieldType;
      const length = sized ? Number(sized[2]) : undefined;

      if (!FIELD_TYPES.includes(type)) {
        throw new Error(
          `Field "${entry}" has unknown type "${type}". Known types: ${FIELD_TYPES.join(', ')}.`,
        );
      }
      // A length on anything but `string` has no column to bind to, so it
      // would be silently dropped — the exact failure mode the syntax
      // exists to remove. `text` is unbounded by design: cap it and you
      // want a `string`.
      if (length !== undefined && type !== 'string') {
        throw new Error(
          `Field "${entry}" puts a length on "${type}", which has no length. Only string does (title:string(500)).`,
        );
      }
      if (length !== undefined && length < 1) {
        throw new Error(`Field "${entry}" has length ${length}; it must be at least 1.`);
      }
      if (RESERVED_FIELD_NAMES.includes(name)) {
        throw new Error(
          `Field "${name}" collides with a column every table already carries (${RESERVED_FIELD_NAMES.join(', ')}).`,
        );
      }
      return { name, type, nullable, length };
    });

  if (fields.length === 0) {
    throw new Error('At least one field is required.');
  }
  return fields;
}

// Columns the schema generator writes on every table — a field list may
// not redeclare them.
const RESERVED_FIELD_NAMES = ['id', 'createdAt', 'updatedAt'];

/** snake_case, the database column name for a camelCase field. */
export function columnName(name: string): string {
  return name.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

export function drizzleImports(fields: Field[]): string[] {
  const imports = new Set<string>(['pgTable', 'uuid', 'timestamp']);
  for (const field of fields) {
    imports.add(DRIZZLE_IMPORT[field.type]);
  }
  return [...imports].sort();
}

const DRIZZLE_IMPORT: Record<FieldType, string> = {
  string: 'varchar',
  text: 'text',
  boolean: 'boolean',
  integer: 'integer',
  timestamp: 'timestamp',
};

/** The character bound for a `string`, named or defaulted. */
export function stringLength(field: Field): number {
  return field.length ?? DEFAULT_STRING_LENGTH;
}

export function drizzleColumn(field: Field): string {
  const column = `'${columnName(field.name)}'`;
  const base: Record<FieldType, string> = {
    string: `varchar(${column}, { length: ${stringLength(field)} })`,
    text: `text(${column})`,
    boolean: `boolean(${column})`,
    integer: `integer(${column})`,
    // `mode: 'date'` keeps the column a real `Date` on the server; the
    // contract layer's timestamp union is what reconciles that with the
    // ISO string the same field arrives as over JSON.
    timestamp: `timestamp(${column}, { mode: 'date', withTimezone: true })`,
  };
  const modifiers = field.nullable
    ? ''
    : field.type === 'boolean'
      ? '.notNull().default(false)'
      : '.notNull()';
  return `${field.name}: ${base[field.type]}${modifiers},`;
}

/** True when a field reflects through drizzle-zod as a `z.date()`. */
export function isDateField(field: Field): boolean {
  return field.type === 'timestamp';
}

/** The Zod schema for a field as it appears in a hand-written override. */
export function zodSchema(field: Field): string {
  const base: Record<FieldType, string> = {
    string: `z.string().min(1).max(${stringLength(field)})`,
    text: 'z.string()',
    boolean: 'z.boolean()',
    integer: 'z.number().int()',
    timestamp: 'timestampSchema',
  };
  return field.nullable ? `${base[field.type]}.nullable()` : base[field.type];
}
