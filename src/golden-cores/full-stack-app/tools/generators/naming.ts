/**
 * Every name a layer generator derives from one module name, in one place.
 *
 * A domain module is one table (see `.claude/skills/hedgehog-loop`'s Domain
 * Module Pattern), named in plural kebab-case — `tasks`, `order-items`. The
 * entity names below are its singular form, which is what a type, a domain
 * error, and a service method are named after.
 */

export interface ModuleNames {
  /** `order-items` — the module name as core.yaml's `{module}` token. */
  module: string;
  /** `orderItems` — the Drizzle table export and query-key root. */
  camel: string;
  /** `OrderItems` — the NestJS module/controller class prefix. */
  pascal: string;
  /** `order-item` — singular kebab, for a singular file name. */
  entityKebab: string;
  /** `orderItem` — singular camel, for a variable or a route param. */
  entityCamel: string;
  /** `OrderItem` — singular pascal, for the entity type and its errors. */
  entityPascal: string;
  /** `order_items` — the Postgres table name. */
  tableName: string;
  /** `ORDER_ITEM` — the singular constant case, for a DI token name. */
  entityConstant: string;
}

export function moduleNames(module: string): ModuleNames {
  const normalized = module.trim().toLowerCase();
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(normalized)) {
    throw new Error(
      `Module name "${module}" must be lower kebab-case (e.g. tasks, order-items).`,
    );
  }
  const segments = normalized.split('-');
  const entitySegments = segments.map((segment, index) =>
    index === segments.length - 1 ? singular(segment) : segment,
  );

  return {
    module: normalized,
    camel: toCamel(segments),
    pascal: toPascal(segments),
    entityKebab: entitySegments.join('-'),
    entityCamel: toCamel(entitySegments),
    entityPascal: toPascal(entitySegments),
    tableName: segments.join('_'),
    entityConstant: entitySegments.join('_').toUpperCase(),
  };
}

function toCamel(segments: string[]): string {
  return segments
    .map((segment, index) => (index === 0 ? segment : capitalize(segment)))
    .join('');
}

function toPascal(segments: string[]): string {
  return segments.map(capitalize).join('');
}

function capitalize(segment: string): string {
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

/**
 * English plural-to-singular for the shapes a table name actually takes.
 * A module whose singular this gets wrong is a rename away from correct —
 * the entity name is cosmetic to every gate, unlike the module name, which
 * core.yaml's scope globs key on.
 */
function singular(word: string): string {
  if (word.endsWith('ies') && word.length > 3) {
    return `${word.slice(0, -3)}y`;
  }
  if (/(s|x|z|ch|sh)es$/.test(word)) {
    return word.slice(0, -2);
  }
  if (word.endsWith('s') && !word.endsWith('ss')) {
    return word.slice(0, -1);
  }
  return word;
}
