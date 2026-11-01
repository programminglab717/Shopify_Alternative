import {
  buildClientSchema,
  isObjectType,
  printSchema,
  printType,
  type GraphQLField,
  type GraphQLSchema,
  type IntrospectionQuery,
} from 'graphql';
import { HattiAdminClient, isMutation } from '@hatti/admin-client';

// What an AI agent, or a person, asks of a shop from the terminal (DEV-08, ADR-990): any Admin API
// query or mutation, answered as JSON; the API's schema, whole, a type or a search of it; and the
// lists asked for most, as JSON too.

/** The request is the caller's to fix; its message says how. */
export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

/** `{ "first": 5 }`, or variables given one by one as `name=value`, JSON where it reads as such. */
export function variablesOf(
  json: string | undefined,
  pairs: readonly string[],
): Record<string, unknown> {
  let variables: Record<string, unknown> = {};
  if (json !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new AgentError('--variables is not JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new AgentError('--variables is a JSON object: {"first": 5}');
    }
    variables = parsed as Record<string, unknown>;
  }
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at < 1) throw new AgentError(`--var is name=value: ${pair}`);
    const value = pair.slice(at + 1);
    let read: unknown = value;
    try {
      read = JSON.parse(value);
    } catch {
      // A plain word: kept as the string it is.
    }
    variables[pair.slice(0, at)] = read;
  }
  return variables;
}

/**
 * `query` asked with `variables`: its data and cost. A mutation is refused where the caller only
 * reads, as `hatti mcp`'s query tool and `hatti api --read-only` do.
 */
export async function ask(
  client: HattiAdminClient,
  query: string,
  variables: Record<string, unknown>,
  options: { readOnly?: boolean } = {},
): Promise<{ data: unknown; cost: unknown }> {
  if (!query.trim()) throw new AgentError('Say what to ask: a GraphQL query or mutation');
  if (options.readOnly && isMutation(query)) {
    throw new AgentError('Only queries here: this changes the shop');
  }
  const { data, cost } = await client.request(query, variables);
  return { data, cost };
}

/** A type as a field holds it: up to five lists and non-nulls around it, as [[X!]!]! is. */
const TYPE_REF =
  'kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }';

/**
 * The introspection query, as graphql-js writes it but with its types' wrappings five deep rather
 * than eight: the Admin API refuses any query more than 12 deep (ADR-576), its own included.
 */
export const INTROSPECTION = `query CliIntrospection {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind name description
      fields(includeDeprecated: true) {
        name description isDeprecated deprecationReason
        args { name description defaultValue type { ${TYPE_REF} } }
        type { ${TYPE_REF} }
      }
      inputFields { name description defaultValue type { ${TYPE_REF} } }
      interfaces { ${TYPE_REF} }
      enumValues(includeDeprecated: true) { name description isDeprecated deprecationReason }
      possibleTypes { ${TYPE_REF} }
    }
    directives {
      name description locations
      args { name description defaultValue type { ${TYPE_REF} } }
    }
  }
}`;

/** The Admin API's schema, as the API describes itself. */
export async function schemaOf(client: HattiAdminClient): Promise<GraphQLSchema> {
  const { data } = await client.request<IntrospectionQuery>(INTROSPECTION);
  return buildClientSchema(data);
}

/** The schema in SDL: whole, one type's, or what a search finds. */
export function describeSchema(
  schema: GraphQLSchema,
  options: { type?: string; search?: string } = {},
): string {
  if (options.type) {
    const type = schema.getType(options.type);
    if (!type) {
      const near = Object.keys(schema.getTypeMap())
        .filter((name) => !name.startsWith('__'))
        .filter((name) => name.toLowerCase().includes(options.type!.toLowerCase()))
        .slice(0, 10);
      throw new AgentError(
        `No type is named ${options.type}${near.length ? `: perhaps ${near.join(', ')}` : ''}`,
      );
    }
    return printType(type);
  }
  if (options.search) return searchSchema(schema, options.search);
  return printSchema(schema);
}

function fieldLine(root: string, field: GraphQLField<unknown, unknown>): string {
  const args = field.args.map((arg) => `${arg.name}: ${String(arg.type)}`).join(', ');
  const about = field.description?.split('\n')[0]?.slice(0, 160);
  return `${root}.${field.name}${args ? `(${args})` : ''}: ${String(field.type)}${about ? `\n    ${about}` : ''}`;
}

/** The queries, mutations and types whose names or descriptions hold every word of `words`. */
export function searchSchema(schema: GraphQLSchema, words: string): string {
  const terms = words.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => terms.every((term) => text.toLowerCase().includes(term));
  const lines: string[] = [];
  for (const [root, type] of [
    ['Query', schema.getQueryType()],
    ['Mutation', schema.getMutationType()],
  ] as const) {
    for (const field of Object.values(type?.getFields() ?? {})) {
      if (matches(`${field.name} ${field.description ?? ''}`)) lines.push(fieldLine(root, field));
    }
  }
  const types = Object.values(schema.getTypeMap()).filter(
    (type) =>
      !type.name.startsWith('__') &&
      type !== schema.getQueryType() &&
      type !== schema.getMutationType() &&
      matches(`${type.name} ${type.description ?? ''}`),
  );
  if (types.length > 0) {
    lines.push('', 'Types:');
    for (const type of types.slice(0, 50)) {
      const kind = isObjectType(type) ? 'type' : 'input/enum/scalar';
      lines.push(`  ${type.name} (${kind})`);
    }
  }
  return lines.length > 0
    ? `${lines.join('\n')}\n\nSee one whole: hatti schema --type <Name>`
    : `Nothing in the schema matches "${words}"`;
}

const PRODUCTS = /* GraphQL */ `
  query CliProducts($first: Int, $query: String) {
    products(first: $first, query: $query) {
      nodes {
        id
        title
        handle
        status
        vendor
        productType
        totalInventory
        priceRange {
          minVariantPrice {
            formatted
          }
          maxVariantPrice {
            formatted
          }
        }
      }
    }
  }
`;

const ORDERS = /* GraphQL */ `
  query CliOrders($first: Int, $query: String) {
    orders(first: $first, query: $query) {
      nodes {
        id
        name
        createdAt
        stage
        status
        financialStatus
        fulfillmentStatus
        paymentMethod
        totalPrice {
          formatted
        }
        shippingAddress {
          name
          city
        }
      }
    }
  }
`;

const ORDER = /* GraphQL */ `
  query CliOrder($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      stage
      status
      confirmationStatus
      financialStatus
      fulfillmentStatus
      paymentMethod
      note
      tags
      totalPrice {
        formatted
      }
      codAmount {
        formatted
      }
      shippingAddress {
        name
        city
        formatted
      }
      lineItems {
        title
        variantTitle
        sku
        quantity
        totalPrice {
          formatted
        }
      }
    }
  }
`;

/** How many a list gives: 1 to 250, 20 unless said. */
export function firstOf(value: unknown): number {
  if (value === undefined) return 20;
  const first = Number(value);
  if (!Number.isInteger(first) || first < 1 || first > 250) {
    throw new AgentError('--first is 1 to 250');
  }
  return first;
}

/** `hatti products list` and `hatti orders list|get`: the shop's, as JSON. */
export async function shortcut(
  client: HattiAdminClient,
  area: 'products' | 'orders',
  command: string,
  options: { first?: unknown; query?: string; id?: string },
): Promise<unknown> {
  const query = options.query || null;
  if (area === 'products' && command === 'list') {
    const { data } = await client.request<{ products: { nodes: unknown[] } }>(PRODUCTS, {
      first: firstOf(options.first),
      query,
    });
    return data.products.nodes;
  }
  if (area === 'orders' && command === 'list') {
    const { data } = await client.request<{ orders: { nodes: unknown[] } }>(ORDERS, {
      first: firstOf(options.first),
      query,
    });
    return data.orders.nodes;
  }
  if (area === 'orders' && command === 'get') {
    if (!options.id) throw new AgentError('Say which order: hatti orders get <id or #number>');
    let id = options.id;
    // By its number, as staff say it: #1001.
    if (/^#?\d+$/.test(id)) {
      const { data } = await client.request<{ orders: { nodes: { id: string; name: string }[] } }>(
        `query CliOrderNumbered($query: String) { orders(first: 5, query: $query) { nodes { id name } } }`,
        { query: id.replace('#', '') },
      );
      const named = data.orders.nodes.find((each) => each.name === `#${id.replace('#', '')}`);
      if (!named) throw new AgentError(`The shop has no order ${id}`);
      id = named.id;
    }
    const { data } = await client.request<{ order: unknown }>(ORDER, { id });
    if (!data.order) throw new AgentError(`The shop has no order ${options.id}`);
    return data.order;
  }
  throw new AgentError(`No such command: hatti ${area} ${command}`);
}
