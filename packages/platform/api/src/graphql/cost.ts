import {
  GraphQLIncludeDirective,
  GraphQLSkipDirective,
  Kind,
  getArgumentValues,
  getDirectiveValues,
  getNamedType,
  getNullableType,
  getOperationAST,
  getVariableValues,
  isAbstractType,
  isCompositeType,
  isLeafType,
  isListType,
  isObjectType,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type FragmentSpreadNode,
  type GraphQLCompositeType,
  type GraphQLField,
  type GraphQLObjectType,
  type GraphQLSchema,
  type InlineFragmentNode,
  type SelectionSetNode,
} from 'graphql';

/**
 * What queries cost, in points, as in Shopify's Admin API (ADR-576). A query's cost is worked out
 * from its document before it runs, and again from what it returned after.
 */
export const QUERY_COST = {
  /** An object, or a plain list of them, which is counted as if it held one. */
  object: 1,
  /** A connection, or a paged list, before what each of its nodes costs. */
  connection: 2,
  /** A mutation's root field, before what its payload's fields cost. */
  mutation: 10,
  /** `__schema` or `__type`, whatever they ask for: the schema is in memory. */
  introspection: 1,
  /** What a connection is counted as holding when it is asked for neither `first` nor `last`. */
  defaultPageSize: 50,
  /** The most a single query may cost, however full its caller's bucket. */
  maximum: 1_000,
} as const;

/** One operation of a document, as the GraphQL server is asked to run it. */
export interface CostedOperation {
  schema: GraphQLSchema;
  /** The document, already validated against the schema. */
  document: DocumentNode;
  /** As the request sent them; coerced here as the server coerces them. */
  variables?: Record<string, unknown> | null;
  operationName?: string | null;
}

/**
 * What the operation may cost at most, before it runs: Shopify's requestedQueryCost. Scalars and
 * enums cost nothing; objects 1 and what they select; plain lists of objects as one object, as
 * they are short and come whole with their parent (a product's options and variants, an order's
 * line items); connections, and lists paged with `first` or `last`, 2, and each node, 1 and what
 * it selects, times the page asked for, their edges and page info free; mutations' root fields 10
 * and what their payloads select. Where a field's type is a union or an interface, the costliest
 * of its types counts. Fields skipped with `@skip` or `@include` cost nothing.
 */
export function requestedQueryCost(operation: CostedOperation): number {
  return new CostWalk(operation, false).total(undefined);
}

/**
 * What the operation cost, from the data it returned: Shopify's actualQueryCost. Connections and
 * paged lists count the nodes they returned rather than the page asked for, and an object that
 * came back null its 1 alone. It is never more than {@link requestedQueryCost}.
 */
export function actualQueryCost(operation: CostedOperation, data: unknown): number {
  const actual = new CostWalk(operation, true).total(data ?? null);
  return Math.min(actual, requestedQueryCost(operation));
}

type FieldsByKey = Map<string, FieldNode[]>;

/** Field sets on connections that hold their nodes. */
const NODE_LISTS = new Set(['nodes', 'edges']);

class CostWalk {
  private readonly schema: GraphQLSchema;
  private readonly fragments = new Map<string, FragmentDefinitionNode>();
  private readonly variables: Record<string, unknown>;
  private readonly root: { type: GraphQLObjectType; selectionSet: SelectionSetNode } | null;
  private readonly mutation: boolean;

  constructor(
    operation: CostedOperation,
    /** Whether to cost what was returned rather than what was asked for. */
    private readonly actual: boolean,
  ) {
    this.schema = operation.schema;
    for (const definition of operation.document.definitions) {
      if (definition.kind === Kind.FRAGMENT_DEFINITION) {
        this.fragments.set(definition.name.value, definition);
      }
    }
    const ast = getOperationAST(operation.document, operation.operationName ?? undefined);
    const coerced = ast
      ? getVariableValues(this.schema, ast.variableDefinitions ?? [], operation.variables ?? {})
      : null;
    this.variables = coerced?.coerced ?? {};
    const type =
      ast?.operation === 'mutation'
        ? this.schema.getMutationType()
        : ast?.operation === 'subscription'
          ? this.schema.getSubscriptionType()
          : this.schema.getQueryType();
    this.root = ast && type ? { type, selectionSet: ast.selectionSet } : null;
    this.mutation = ast?.operation === 'mutation';
  }

  total(data: unknown): number {
    if (!this.root) return 0;
    const { type, selectionSet } = this.root;
    let cost = 0;
    for (const [key, nodes] of this.collect(type, [selectionSet])) {
      cost += this.field(type, key, nodes, data, true);
    }
    return cost;
  }

  /** What a field costs, under a parent whose returned value is `parent` when costing actuals. */
  private field(
    parentType: GraphQLObjectType,
    key: string,
    nodes: FieldNode[],
    parent: unknown,
    root = false,
  ): number {
    const node = nodes[0]!;
    const name = node.name.value;
    if (name === '__typename') return 0;
    if (name === '__schema' || name === '__type') return QUERY_COST.introspection;
    const field = parentType.getFields()[name];
    if (!field) return 0;
    const type = getNamedType(field.type);
    const mutation = root && this.mutation;
    const list = isListType(getNullableType(field.type));
    const pages = field.args.some((arg) => arg.name === 'first' || arg.name === 'last');
    // A connection holds its nodes, in `nodes` or `edges`, and is named so or paged.
    const connection =
      !list &&
      isObjectType(type) &&
      (type.name.endsWith('Connection') || pages) &&
      Object.keys(type.getFields()).some((name) => NODE_LISTS.has(name));
    const paged = list && pages;
    const base = mutation
      ? QUERY_COST.mutation
      : isLeafType(type)
        ? 0
        : connection || paged
          ? QUERY_COST.connection
          : QUERY_COST.object;

    let value: unknown;
    if (this.actual) {
      // A field missing from its parent's data never ran, as one on another type of a union's
      // fragment; but a root field that failed ran all the same.
      if (!isRecord(parent) || !(key in parent)) return root ? base : 0;
      value = parent[key];
      if (value === null || value === undefined) return base;
    }
    if (isLeafType(type) || !isCompositeType(type)) return base;

    const selections = nodes.flatMap((each) => (each.selectionSet ? [each.selectionSet] : []));
    if (connection) {
      return base + this.connection(type, selections, this.pageSize(field, node), value);
    }
    if (paged) {
      if (!this.actual) {
        const each = QUERY_COST.object + this.selection(type, selections, undefined);
        return base + this.pageSize(field, node) * each;
      }
      return flatten(value).reduce<number>(
        (cost, item) =>
          item === null ? cost : cost + QUERY_COST.object + this.selection(type, selections, item),
        base,
      );
    }
    if (list) {
      // A plain list is counted as one item: the costliest of those returned.
      const items = this.actual ? flatten(value) : [undefined];
      const each = items.map((item) => this.selection(type, selections, item));
      return base + Math.max(0, ...each);
    }
    return base + this.selection(type, selections, value);
  }

  /** What a connection's fields cost: its nodes, each, times the page, and the rest once. */
  private connection(
    type: GraphQLObjectType,
    selections: readonly SelectionSetNode[],
    size: number,
    value: unknown,
  ): number {
    let cost = 0;
    for (const [key, nodes] of this.collect(type, selections)) {
      const name = nodes[0]!.name.value;
      if (name === 'pageInfo') continue;
      const field = type.getFields()[name];
      const itemType = field && getNamedType(field.type);
      if (!NODE_LISTS.has(name) || !field || !itemType || !isCompositeType(itemType)) {
        cost += this.field(type, key, nodes, value);
        continue;
      }
      const inner = nodes.flatMap((each) => (each.selectionSet ? [each.selectionSet] : []));
      // An edge is free: its node is the object it holds. A node in `nodes` is that object.
      const own = name === 'nodes' ? QUERY_COST.object : 0;
      if (!this.actual) {
        cost += size * (own + this.selection(itemType, inner, undefined));
        continue;
      }
      for (const item of flatten(isRecord(value) ? value[key] : null)) {
        if (item !== null) cost += own + this.selection(itemType, inner, item);
      }
    }
    return cost;
  }

  /**
   * What selections on a composite type cost: on a union or an interface, those on the type the
   * data names in `__typename`, or else the costliest of its types.
   */
  private selection(
    type: GraphQLCompositeType,
    selections: readonly SelectionSetNode[],
    value: unknown,
  ): number {
    if (selections.length === 0) return 0;
    let candidates: readonly GraphQLObjectType[] = isAbstractType(type)
      ? this.schema.getPossibleTypes(type)
      : [type];
    if (this.actual && isAbstractType(type) && isRecord(value)) {
      const named = candidates.find((candidate) => candidate.name === value.__typename);
      if (named) candidates = [named];
    }
    let most = 0;
    for (const candidate of candidates) {
      let cost = 0;
      for (const [key, nodes] of this.collect(candidate, selections)) {
        cost += this.field(candidate, key, nodes, value);
      }
      most = Math.max(most, cost);
    }
    return most;
  }

  /** The page a connection or a paged list is asked for: `first`, `last`, or the default. */
  private pageSize(field: GraphQLField<unknown, unknown>, node: FieldNode): number {
    let args: Record<string, unknown> = {};
    try {
      args = getArgumentValues(field, node, this.variables);
    } catch {
      // Validated already; a value the server refuses fails the field, not the costing.
    }
    const size = args.first ?? args.last;
    return typeof size === 'number' && Number.isFinite(size)
      ? Math.max(1, Math.floor(size))
      : QUERY_COST.defaultPageSize;
  }

  /**
   * The fields selected on an object type, by response key, as the executor merges them:
   * fragments whose type conditions it meets, and nothing skipped.
   */
  private collect(
    type: GraphQLObjectType,
    selectionSets: readonly SelectionSetNode[],
    fields: FieldsByKey = new Map(),
    spread = new Set<string>(),
  ): FieldsByKey {
    for (const selectionSet of selectionSets) {
      for (const selection of selectionSet.selections) {
        if (!this.included(selection)) continue;
        switch (selection.kind) {
          case Kind.FIELD: {
            const key = selection.alias?.value ?? selection.name.value;
            const existing = fields.get(key);
            if (existing) existing.push(selection);
            else fields.set(key, [selection]);
            break;
          }
          case Kind.INLINE_FRAGMENT:
            if (
              selection.typeCondition &&
              !this.applies(selection.typeCondition.name.value, type)
            ) {
              break;
            }
            this.collect(type, [selection.selectionSet], fields, spread);
            break;
          case Kind.FRAGMENT_SPREAD: {
            const name = selection.name.value;
            const fragment = this.fragments.get(name);
            if (spread.has(name) || !fragment) break;
            spread.add(name);
            if (!this.applies(fragment.typeCondition.name.value, type)) break;
            this.collect(type, [fragment.selectionSet], fields, spread);
            break;
          }
        }
      }
    }
    return fields;
  }

  private applies(condition: string, type: GraphQLObjectType): boolean {
    if (condition === type.name) return true;
    const conditionType = this.schema.getType(condition);
    return (
      conditionType !== undefined &&
      isAbstractType(conditionType) &&
      this.schema.isSubType(conditionType, type)
    );
  }

  private included(node: FieldNode | FragmentSpreadNode | InlineFragmentNode): boolean {
    try {
      const skip = getDirectiveValues(GraphQLSkipDirective, node, this.variables);
      if (skip?.if === true) return false;
      const include = getDirectiveValues(GraphQLIncludeDirective, node, this.variables);
      return include?.if !== false;
    } catch {
      return true;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A list's items, however deeply nested; nothing for anything that is not a list. */
function flatten(value: unknown): unknown[] {
  return Array.isArray(value)
    ? value.flatMap((item) => (Array.isArray(item) ? flatten(item) : [item]))
    : [];
}
