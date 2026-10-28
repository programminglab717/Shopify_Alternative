import { MemoryStore } from '@hatti/storefront-data';
import { describe, expect, it } from 'vitest';
import { AGENT_LIMITS, UCP_VERSION, mcpAnswer, ucpProfile, type AgentShop } from './agents.js';
import { sampleStore } from './fixtures.js';

const sample = sampleStore();
const lawn = sample.products.find(
  (product) =>
    product.variants.length > 1 && product.variants[0]!.available && product.variants[1]!.available,
)!;
const [first, second] = lawn.variants as [(typeof lawn.variants)[0], (typeof lawn.variants)[0]];

/** The sample shop, its search finding the lawn first, then every other product. */
function shop(found: string[] = sample.products.map((product) => product.id)): AgentShop {
  return {
    store: new MemoryStore(sample),
    search: () => Promise.resolve([lawn.id, ...found.filter((id) => id !== lawn.id)]),
    origin: 'https://zari.hatti.pk',
    name: 'Zari',
    currency: 'PKR',
  };
}

// Answers are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let next = 1;
/** Calls the tool `name` with `args`, and gives what it answered. */
async function call(name: string, args: Record<string, unknown>, at: AgentShop = shop()) {
  const answer = (await mcpAnswer(
    { jsonrpc: '2.0', id: next++, method: 'tools/call', params: { name, arguments: args } },
    at,
  )) as {
    result: { structuredContent?: Record<string, Json>; isError?: boolean; content: Json[] };
  };
  return answer.result;
}

describe('The shop for AI shopping agents (OS-23, ADR-847)', () => {
  it("publishes its UCP profile, naming its store MCP endpoint and its tools' capabilities", () => {
    const profile = ucpProfile('https://zari.hatti.pk');
    expect(profile.ucp.version).toBe(UCP_VERSION);
    expect(profile.ucp.services['dev.ucp.shopping']).toEqual([
      expect.objectContaining({ transport: 'mcp', endpoint: 'https://zari.hatti.pk/api/mcp' }),
    ]);
    expect(Object.keys(profile.ucp.capabilities)).toEqual([
      'dev.ucp.shopping.catalog.search',
      'dev.ucp.shopping.catalog.lookup',
      'dev.ucp.shopping.cart',
    ]);
  });

  it("speaks MCP's JSON-RPC: initialize, ping, its tools, and nothing it doesn't know", async () => {
    const init = await mcpAnswer(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      shop(),
    );
    expect(init).toMatchObject({
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'Zari on Hatti' },
      },
    });
    // A version it doesn't speak: its newest.
    expect(
      await mcpAnswer(
        { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
        shop(),
      ),
    ).toMatchObject({ result: { protocolVersion: '2025-11-25' } });
    expect(await mcpAnswer({ jsonrpc: '2.0', method: 'notifications/initialized' }, shop())).toBe(
      null,
    );
    expect(await mcpAnswer({ jsonrpc: '2.0', id: 3, method: 'ping' }, shop())).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: {},
    });
    const list = (await mcpAnswer({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, shop())) as {
      result: { tools: { name: string }[] };
    };
    expect(list.result.tools.map((tool) => tool.name)).toEqual([
      'search_catalog',
      'lookup_catalog',
      'get_product',
      'create_cart',
      'get_cart',
      'update_cart',
    ]);
    expect(
      await mcpAnswer({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, shop()),
    ).toMatchObject({ error: { code: -32601 } });
    expect(await mcpAnswer([{ jsonrpc: '2.0', id: 6, method: 'ping' }], shop())).toMatchObject({
      error: { code: -32600 },
    });
    expect(
      await mcpAnswer(
        { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'complete_checkout' } },
        shop(),
      ),
    ).toMatchObject({ error: { code: -32602 } });
  });

  it('searches the catalog a page at a time, its prices in paisa, and filters it', async () => {
    const found = await call('search_catalog', {
      catalog: { query: 'lawn', pagination: { limit: 2 } },
    });
    const result = found.structuredContent!;
    expect(result.ucp).toMatchObject({
      version: UCP_VERSION,
      capabilities: { 'dev.ucp.shopping.catalog.search': expect.any(Array) },
    });
    expect(result.products).toHaveLength(2);
    const [product] = result.products;
    expect(product).toMatchObject({
      id: `gid://hatti/Product/${lawn.id}`,
      title: lawn.title,
      url: `https://zari.hatti.pk/products/${lawn.handle}`,
      price_range: { min: { amount: expect.any(Number), currency: 'PKR' } },
    });
    expect(product.variants[0]).toMatchObject({
      id: `gid://hatti/ProductVariant/${lawn.id}/${first.id}`,
      price: { amount: first.price, currency: 'PKR' },
      availability: { available: first.available },
      checkout_url: `https://zari.hatti.pk/cart/${first.id}:1`,
      seller: { name: 'Zari', domain: 'zari.hatti.pk' },
    });
    // Its text as text, for the model.
    expect(JSON.parse(found.content[0].text)).toEqual(result);
    expect(result.pagination).toMatchObject({ has_next_page: true, cursor: expect.any(String) });
    const after = (
      await call('search_catalog', {
        catalog: { query: 'lawn', pagination: { limit: 2, cursor: result.pagination.cursor } },
      })
    ).structuredContent!;
    expect(after.products[0].id).not.toBe(product.id);
    // Filtered by price, in paisa.
    const cheap = (
      await call('search_catalog', {
        catalog: { query: 'lawn', filters: { price: { max: 1 } } },
      })
    ).structuredContent!;
    expect(cheap.products).toEqual([]);
    // Refused, said so to the agent.
    expect(await call('search_catalog', { catalog: {} })).toMatchObject({ isError: true });
    expect(
      await call('search_catalog', {
        catalog: { query: 'x'.repeat(AGENT_LIMITS.query + 1) },
      }),
    ).toMatchObject({ isError: true });
    expect(
      await call('search_catalog', { catalog: { query: 'lawn', pagination: { cursor: 'nope' } } }),
    ).toMatchObject({ isError: true });
  });

  it('looks products up by their IDs, their variants or their pages, and reads one in full', async () => {
    const looked = (
      await call('lookup_catalog', {
        catalog: {
          ids: [
            `gid://hatti/ProductVariant/${lawn.id}/${first.id}`,
            `https://zari.hatti.pk/products/${lawn.handle}`,
            'gid://hatti/Product/nothing',
            'https://elsewhere.pk/products/x',
          ],
          filters: { available: false },
        },
      })
    ).structuredContent!;
    expect(looked.products.map((product: { id: string }) => product.id)).toEqual([
      `gid://hatti/Product/${lawn.id}`,
    ]);
    expect(looked.messages.map((message: { code: string }) => message.code)).toEqual([
      'not_found',
      'not_found',
    ]);

    const read = (await call('get_product', { catalog: { id: `gid://hatti/Product/${lawn.id}` } }))
      .structuredContent!;
    expect(read.product.options[0]).toEqual({
      name: lawn.options[0]!.name,
      values: lawn.options[0]!.values.map((value) => ({
        label: value,
        available: lawn.variants.some((v) => v.options[0] === value && v.available),
        exists: lawn.variants.some((v) => v.options[0] === value),
      })),
    });
    const narrowed = (
      await call('get_product', {
        catalog: {
          id: `gid://hatti/Product/${lawn.id}`,
          selected: [{ name: lawn.options[0]!.name, label: first.options[0] }],
        },
      })
    ).structuredContent!;
    expect(
      narrowed.product.variants.every(
        (variant: { selected_options: { label: string }[] }) =>
          variant.selected_options[0]!.label === first.options[0],
      ),
    ).toBe(true);
    expect(
      await call('get_product', { catalog: { id: 'gid://hatti/Product/nothing' } }),
    ).toMatchObject({ isError: true });
  });

  it("makes carts the shop's checkout takes, kept in their IDs, at the prices now", async () => {
    const one = `gid://hatti/ProductVariant/${lawn.id}/${first.id}`;
    const two = `gid://hatti/ProductVariant/${lawn.id}/${second.id}`;
    const made = (
      await call('create_cart', {
        cart: {
          line_items: [
            { item: { id: one }, quantity: 2 },
            { item: { id: two }, quantity: 1 },
            { item: { id: one }, quantity: 1 },
          ],
        },
      })
    ).structuredContent!.cart;
    const lines = [
      { variant: first, quantity: 3 },
      { variant: second, quantity: 1 },
    ];
    expect(made.line_items.map((line: { quantity: number }) => line.quantity)).toEqual(
      lines.map((line) => line.quantity),
    );
    const subtotal = lines.reduce((sum, line) => sum + line.variant.price * line.quantity, 0);
    expect(made.totals).toEqual([
      { type: 'subtotal', amount: subtotal },
      { type: 'total', amount: subtotal },
    ]);
    expect(made.continue_url).toBe(
      `https://zari.hatti.pk/cart/${lines.map((l) => `${l.variant.id}:${l.quantity}`).join(',')}`,
    );
    // Its ID is the cart: read again, the same.
    const again = (await call('get_cart', { id: made.id })).structuredContent!.cart;
    expect(again).toEqual(made);
    const changed = (
      await call('update_cart', {
        id: made.id,
        cart: {
          line_items: [{ item: { id: one }, quantity: 5 }],
        },
      })
    ).structuredContent!.cart;
    expect(changed.line_items).toHaveLength(1);
    expect(changed.id).not.toBe(made.id);
    // Refused: no lines, a product's ID, too many, a cart not made here.
    for (const cart of [
      { line_items: [] },
      { line_items: [{ item: { id: `gid://hatti/Product/${lawn.id}` }, quantity: 1 }] },
      { line_items: [{ item: { id: one }, quantity: AGENT_LIMITS.quantity + 1 }] },
    ]) {
      expect(await call('create_cart', { cart })).toMatchObject({ isError: true });
    }
    expect(await call('get_cart', { id: 'gid://hatti/Cart/bm9wZQ' })).toMatchObject({
      isError: true,
    });
  });
});
