import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { StaffRole } from '@hatti/api';
import {
  WebhookSender,
  WorkflowService,
  signWebhook,
  type WebhookOutcome,
  type WebhookRequest,
} from '@hatti/apps/public';
import { CustomerService } from '@hatti/customers/public';
import { SecretBox, base32Decode, totp } from '@hatti/crypto';
import { Database } from '@hatti/db';
import { createTestDatabase, testDatabaseServer, type TestDatabase } from '@hatti/db/testing';
import type { DomainEvent } from '@hatti/events';
import { fromPublicId, newId, toPublicId } from '@hatti/ids';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApi, type TestApi } from '../testing/api.js';
import { workerOrders } from '../worker/unreachable-orders.js';
import { WorkflowRuns, WorkflowTriggers } from '../worker/workflows.js';
import { ADMIN_GRAPHQL_PATH } from './constants.js';

const server = testDatabaseServer();

// Responses are checked with matchers rather than static types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const PASSWORD = 'correct horse battery staple';
const EXTENSION = 'id kind handle title resource url fields { key label type required }';
const SET_EXTENSION = `mutation ($input: FlowExtensionInput!) {
  flowExtensionSet(input: $input) { flowExtension { ${EXTENSION} } userErrors { field message } } }`;
const WORKFLOW = `id name trigger enabled match lastRunStatus
  extension { handle }
  conditions { field operator value }
  actions { type tags title message extensionId properties { key value }
    hours match conditions { field operator value } }`;
const CREATE = `mutation ($input: WorkflowInput!) {
  workflowCreate(input: $input) { workflow { ${WORKFLOW} } userErrors { field code message } } }`;
const RUNS = `query ($id: ID!) {
  workflowRuns(workflowId: $id) { status orderId steps { action outcome detail } attempts } }`;
const RECEIVE = `mutation ($orderId: ID, $properties: [FlowPropertyInput!]) {
  flowTriggerReceive(handle: "review-posted", orderId: $orderId, properties: $properties) {
    userErrors { field code message } } }`;

/** Posts nothing: keeps what it was asked to post, and answers as told. */
class FakeSender extends WebhookSender {
  readonly sent: WebhookRequest[] = [];
  answer: WebhookOutcome = { status: 200, error: null };

  send(request: WebhookRequest): Promise<WebhookOutcome> {
    this.sent.push(request);
    return Promise.resolve(this.answer);
  }
}

describe.skipIf(!server)('Workflows: triggers, conditions and actions (DEV-11, ADR-861)', () => {
  let testDb: TestDatabase;
  let admin: pg.Client;
  let api: TestApi;
  let worker: Database;
  let triggers: WorkflowTriggers;
  let runs: WorkflowRuns;
  const sender = new FakeSender();
  const shop = newId();
  let heard = new Set<string>();

  const post = (url: string, payload: object, token?: string) =>
    api.app.inject({
      method: 'POST',
      url,
      payload,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  async function account(role: StaffRole): Promise<string> {
    const body = (
      await post('/auth/sign-up', {
        email: `flows-${randomBytes(4).toString('hex')}@example.pk`,
        password: PASSWORD,
        name: 'Hina Akhtar',
      })
    ).json() as { accessToken: string; user: { id: string } };
    await admin.query(
      'INSERT INTO identity.memberships (user_id, shop_id, role) VALUES ($1, $2, $3)',
      [fromPublicId(body.user.id, 'user'), shop, role],
    );
    const { secret } = (await post('/auth/two-step/totp/setup', {}, body.accessToken)).json() as {
      secret: string;
    };
    await post(
      '/auth/two-step/totp/confirm',
      { code: totp(base32Decode(secret), Date.now()) },
      body.accessToken,
    );
    return body.accessToken;
  }

  async function gql(token: string, query: string, variables?: object) {
    const response = await api.app.inject({
      method: 'POST',
      url: ADMIN_GRAPHQL_PATH,
      headers: token.startsWith('hat_')
        ? { 'x-hatti-access-token': token, 'idempotency-key': randomUUID() }
        : {
            authorization: `Bearer ${token}`,
            'x-hatti-shop-id': toPublicId('shop', shop),
            'idempotency-key': randomUUID(),
          },
      payload: { query, variables },
    });
    return response.json() as { data?: Record<string, Json> | null; errors?: Json[] };
  }

  async function data(token: string, query: string, variables?: object) {
    const body = await gql(token, query, variables);
    expect(body.errors).toBeUndefined();
    return Object.values(body.data ?? {})[0] as Json;
  }

  /** The shop's events of `types` not yet heard, heard by the worker, in order. */
  async function hear(...types: string[]): Promise<number> {
    const { rows } = await admin.query<{
      id: string;
      shop_id: string;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      occurred_at: Date;
    }>(
      `SELECT id, shop_id, aggregate_type, aggregate_id, event_type, payload, occurred_at
         FROM platform.outbox_events WHERE shop_id = $1 AND event_type = ANY ($2) ORDER BY id`,
      [shop, types],
    );
    let heardNow = 0;
    for (const row of rows.filter((each) => !heard.has(each.id))) {
      heard = new Set([...heard, row.id]);
      await triggers.handle({
        id: row.id,
        type: row.event_type,
        shopId: row.shop_id,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        payload: row.payload,
        occurredAt: row.occurred_at.toISOString(),
      } as DomainEvent);
      heardNow += 1;
    }
    return heardNow;
  }

  beforeAll(async () => {
    testDb = await createTestDatabase(server);
    admin = new pg.Client({ connectionString: testDb.adminUrl });
    await admin.connect();
    await admin.query(`INSERT INTO control.shops (id, name, handle) VALUES ($1, 'Zari', 'zari')`, [
      shop,
    ]);
    // On Growth, which includes custom apps (ADR-523).
    await admin.query(
      `INSERT INTO billing.subscriptions (shop_id, plan, billing_interval, period_start, period_end)
       SELECT id, 'growth', 'monthly', now(), now() + interval '1 month' FROM control.shops`,
    );
    api = await startTestApi(testDb);
    worker = new Database({
      appUrl: testDb.appUrl,
      systemUrl: testDb.systemUrl,
      applicationName: 'workflows-test',
    });
    // The API's key, as the worker opens what the API sealed.
    const workflows = new WorkflowService(
      worker,
      new SecretBox([{ id: 'test', key: Buffer.alloc(32, 9) }]),
    );
    triggers = new WorkflowTriggers(workflows);
    runs = new WorkflowRuns(
      workflows,
      workerOrders(worker),
      new CustomerService(worker),
      worker,
      sender,
    );
  });

  afterAll(async () => {
    await api?.close();
    await worker?.close();
    await admin?.end();
    await testDb?.drop();
  });

  it("tags a big cash-on-delivery order and its customer, and posts an app's action signed", async () => {
    const owner = await account('owner');
    const agent = await account('confirmation_agent');
    const made = await data(
      owner,
      `mutation ($input: CustomAppInput!) {
        customAppCreate(input: $input) { accessToken webhookSecret userErrors { message } } }`,
      { input: { name: 'Reviews', scopes: ['read_orders'] } },
    );
    const app = made.accessToken as string;

    // The app offers an action about orders, and a trigger; staff cannot offer them for it.
    expect((await gql(owner, SET_EXTENSION, { input: {} })).errors).toBeDefined();
    const action = await data(app, SET_EXTENSION, {
      input: {
        kind: 'ACTION',
        handle: 'ask-for-review',
        title: 'Ask for a review',
        resource: 'ORDER',
        url: 'https://reviews.example.pk/flow',
        fields: [{ key: 'message', label: 'Message', type: 'TEXT', required: true }],
      },
    });
    expect(action.userErrors).toEqual([]);
    const customerAction = await data(app, SET_EXTENSION, {
      input: {
        kind: 'ACTION',
        handle: 'sync-customer',
        title: 'Sync the customer',
        resource: 'CUSTOMER',
        url: 'https://reviews.example.pk/customers',
      },
    });
    expect(customerAction.userErrors).toEqual([
      {
        field: ['input', 'resource'],
        message: "The app can't read customers: give it the read_customers scope first",
      },
    ]);
    const trigger = await data(app, SET_EXTENSION, {
      input: {
        kind: 'TRIGGER',
        handle: 'review-posted',
        title: 'Review posted',
        resource: 'ORDER',
        fields: [{ key: 'rating', label: 'Rating', type: 'NUMBER', required: true }],
      },
    });
    expect(trigger.flowExtension).toMatchObject({ kind: 'TRIGGER', url: null });
    expect((await data(owner, `{ flowExtensions { handle appName } }`)).length).toBe(2);

    // Only the owner and managers make workflows; what they make is checked.
    expect((await gql(agent, `{ workflows { id } }`)).errors?.[0]?.message).toContain(
      'The owner and managers make workflows',
    );
    const wrong = await data(owner, CREATE, {
      input: {
        name: 'Welcome',
        trigger: 'CUSTOMER_CREATED',
        conditions: [{ field: 'order.total', operator: 'AT_LEAST', value: '2000' }],
        actions: [
          { type: 'ADD_ORDER_TAGS', tags: ['new'] },
          { type: 'NOTIFY_STAFF', title: 'New {{customer.nickname}}', message: 'Say hello' },
        ],
      },
    });
    expect(wrong.userErrors).toEqual([
      {
        field: ['input', 'conditions', '0', 'field'],
        code: 'INVALID',
        message: "Field isn't something this trigger tells of",
      },
      {
        field: ['input', 'actions', '0', 'type'],
        code: 'INVALID',
        message: 'This trigger tells of no order to change',
      },
      {
        field: ['input', 'actions', '1', 'title'],
        code: 'INVALID',
        message: "{{customer.nickname}} isn't something this trigger tells of",
      },
    ]);

    const big = await data(owner, CREATE, {
      input: {
        name: 'Big COD orders',
        trigger: 'ORDER_CREATED',
        conditions: [
          { field: 'order.total', operator: 'AT_LEAST', value: '2000' },
          { field: 'order.payment_method', operator: 'EQUALS', value: 'cash_on_delivery' },
        ],
        actions: [
          { type: 'ADD_ORDER_TAGS', tags: ['big-cod'] },
          { type: 'ADD_CUSTOMER_TAGS', tags: ['cod-buyer'] },
          {
            type: 'APP_ACTION',
            extensionId: action.flowExtension.id,
            properties: [{ key: 'message', value: 'Thanks for order {{order.name}}' }],
          },
        ],
      },
    });
    expect(big.userErrors).toEqual([]);
    expect(big.workflow).toMatchObject({ enabled: true, match: 'ALL', lastRunStatus: null });

    const product = await data(
      owner,
      `mutation {
        productCreate(input: { title: "Kurta", status: ACTIVE, variants: [{ price: "2,499" }] }) {
          product { variants { id } } } }`,
    );
    const place = (quantity: number) =>
      data(
        owner,
        `mutation ($variantId: ID!, $quantity: Int!) {
          orderCreate(input: {
            lineItems: [{ variantId: $variantId, quantity: $quantity }],
            shippingAddress: { name: "Ayesha Khan", phone: "0300 1234567",
                               address1: "House 12, Street 4", city: "Lahore" },
            paymentMethod: CASH_ON_DELIVERY
          }) { order { id name customer { id } } userErrors { message } } }`,
        { variantId: product.product.variants[0].id, quantity },
      );
    const placed = (await place(1)).order;
    expect(await hear('order.created')).toBe(1);
    expect(await runs.sweep()).toEqual({ done: 1, skipped: 0, failed: 0, retrying: 0, waiting: 0 });

    const order = await data(
      owner,
      `query ($id: ID!) { order(id: $id) { tags customer { tags } } }`,
      { id: placed.id },
    );
    expect(order).toEqual({ tags: ['big-cod'], customer: { tags: ['cod-buyer'] } });
    const [posted] = sender.sent;
    expect(posted!.url).toBe('https://reviews.example.pk/flow');
    expect(posted!.headers['x-hatti-topic']).toBe('flow/action');
    expect(posted!.headers['x-hatti-hmac-sha256']).toBe(
      signWebhook(made.webhookSecret, posted!.body),
    );
    expect(JSON.parse(posted!.body)).toMatchObject({
      action: 'ask-for-review',
      workflow_id: big.workflow.id,
      order_id: placed.id,
      properties: { message: `Thanks for order ${placed.name}` },
    });
    expect(await data(owner, RUNS, { id: big.workflow.id })).toEqual([
      {
        status: 'DONE',
        orderId: placed.id,
        attempts: 1,
        steps: [
          { action: 'ADD_ORDER_TAGS', outcome: 'DONE', detail: 'big-cod' },
          { action: 'ADD_CUSTOMER_TAGS', outcome: 'DONE', detail: 'cod-buyer' },
          { action: 'APP_ACTION', outcome: 'DONE', detail: null },
        ],
      },
    ]);
    const { rows: timeline } = await admin.query(
      `SELECT message FROM orders.order_events WHERE order_id = $1 AND kind = 'updated'`,
      [fromPublicId(placed.id, 'order')],
    );
    expect(timeline).toEqual([{ message: 'Workflow “Big COD orders” changed the tags' }]);

    // Heard again, an event runs nothing again; a workflow's conditions not holding skip it.
    heard = new Set();
    expect(await hear('order.created')).toBe(1);
    expect(await runs.sweep()).toEqual({ done: 0, skipped: 0, failed: 0, retrying: 0, waiting: 0 });
    await admin.query(
      `UPDATE apps.workflows SET conditions = jsonb_set(conditions, '{0,value}', '"5000"')`,
    );
    const small = (await place(1)).order;
    await hear('order.created');
    expect(await runs.sweep()).toEqual({ done: 0, skipped: 1, failed: 0, retrying: 0, waiting: 0 });
    expect((await data(owner, RUNS, { id: big.workflow.id }))[0]).toMatchObject({
      status: 'SKIPPED',
      orderId: small.id,
      steps: [],
    });

    // An app that does not answer is tried again, from its action on, for a day.
    sender.answer = { status: 503, error: 'The app answered 503' };
    const later = (await place(3)).order;
    await hear('order.created');
    expect(await runs.sweep()).toEqual({ done: 0, skipped: 0, failed: 0, retrying: 1, waiting: 0 });
    sender.answer = { status: 200, error: null };
    expect(await runs.sweep(new Date(Date.now() + 2 * 60_000))).toEqual({
      done: 1,
      skipped: 0,
      failed: 0,
      retrying: 0,
      waiting: 0,
    });
    expect((await data(owner, RUNS, { id: big.workflow.id }))[0]).toMatchObject({
      status: 'DONE',
      orderId: later.id,
      attempts: 2,
      steps: [
        { action: 'ADD_ORDER_TAGS', outcome: 'DONE' },
        { action: 'ADD_CUSTOMER_TAGS', outcome: 'DONE' },
        { action: 'APP_ACTION', outcome: 'DONE' },
      ],
    });

    // The app's trigger, fired with what its fields say, runs a workflow on it.
    const low = await data(owner, CREATE, {
      input: {
        name: 'Low ratings',
        trigger: 'APP',
        extensionId: trigger.flowExtension.id,
        conditions: [{ field: 'trigger.rating', operator: 'LESS_THAN', value: '3' }],
        actions: [
          { type: 'ADD_ORDER_TAGS', tags: ['low-rating'] },
          { type: 'NOTIFY_STAFF', title: 'Rated {{trigger.rating}}', message: '{{order.name}}' },
        ],
      },
    });
    expect(low.workflow).toMatchObject({ trigger: 'APP', extension: { handle: 'review-posted' } });
    expect((await data(app, RECEIVE, { orderId: placed.id, properties: [] })).userErrors).toEqual([
      { field: ['properties'], code: 'BLANK', message: "Rating can't be blank" },
    ]);
    expect(
      (
        await data(app, RECEIVE, {
          orderId: placed.id,
          properties: [{ key: 'rating', value: '2' }],
        })
      ).userErrors,
    ).toEqual([]);
    expect(await hear('flow.trigger_received')).toBe(1);
    expect(await runs.sweep()).toEqual({ done: 1, skipped: 0, failed: 0, retrying: 0, waiting: 0 });
    expect(await data(owner, RUNS, { id: low.workflow.id })).toEqual([
      {
        status: 'DONE',
        orderId: placed.id,
        attempts: 1,
        steps: [
          { action: 'ADD_ORDER_TAGS', outcome: 'DONE', detail: 'low-rating' },
          // No keys for pushes on this server.
          {
            action: 'NOTIFY_STAFF',
            outcome: 'SKIPPED',
            detail: 'This server sends no pushes: it has no keys',
          },
        ],
      },
    ]);
    expect(
      (await data(owner, `query ($id: ID!) { order(id: $id) { tags } }`, { id: placed.id })).tags,
    ).toEqual(['big-cod', 'low-rating']);

    // The app takes its trigger back: the workflow is left, telling of none.
    await data(
      app,
      `mutation { flowExtensionDelete(kind: TRIGGER, handle: "review-posted") { userErrors { message } } }`,
    );
    const [, kept] = await data(owner, `{ workflows { name extension { handle } } }`);
    expect(kept).toEqual({ name: 'Low ratings', extension: null });
    expect(
      (
        await data(
          owner,
          `mutation ($id: ID!) { workflowDelete(id: $id) { deletedWorkflowId userErrors { message } } }`,
          { id: low.workflow.id },
        )
      ).deletedWorkflowId,
    ).toBe(low.workflow.id);
  });
  it('waits, then goes on only where the order is still waiting to be confirmed (ADR-886)', async () => {
    // The shop has its owner; managers make workflows too.
    const owner = await account('manager');
    await admin.query('UPDATE apps.workflows SET enabled = false WHERE shop_id = $1', [shop]);
    const pending = { field: 'order.confirmation_status', operator: 'EQUALS', value: 'pending' };
    const wrong = await data(owner, CREATE, {
      input: {
        name: 'Unconfirmed',
        trigger: 'ORDER_CREATED',
        actions: [
          { type: 'WAIT', hours: 0 },
          { type: 'CONTINUE_IF', conditions: [] },
          { type: 'WAIT', hours: 24 },
        ],
      },
    });
    expect(wrong.userErrors).toEqual([
      {
        field: ['input', 'actions', '0', 'hours'],
        code: 'INVALID',
        message: 'A wait is a whole number of hours, 1 to 168',
      },
      {
        field: ['input', 'actions', '1', 'conditions'],
        code: 'BLANK',
        message: 'Give a condition to check',
      },
      {
        field: ['input', 'actions', '2', 'type'],
        code: 'INVALID',
        message: 'A wait needs an action after it',
      },
    ]);
    const made = await data(owner, CREATE, {
      input: {
        name: 'Unconfirmed after a day',
        trigger: 'ORDER_CREATED',
        actions: [
          { type: 'WAIT', hours: 24 },
          { type: 'CONTINUE_IF', match: 'ALL', conditions: [pending] },
          { type: 'ADD_ORDER_TAGS', tags: ['call-again'] },
        ],
      },
    });
    expect(made.userErrors).toEqual([]);
    expect(made.workflow.actions).toEqual([
      expect.objectContaining({ type: 'WAIT', hours: 24, match: null, conditions: [] }),
      expect.objectContaining({
        type: 'CONTINUE_IF',
        hours: null,
        match: 'ALL',
        conditions: [{ ...pending, operator: 'EQUALS' }],
      }),
      expect.objectContaining({ type: 'ADD_ORDER_TAGS', tags: ['call-again'] }),
    ]);

    const product = await data(
      owner,
      `mutation {
        productCreate(input: { title: "Shawl", status: ACTIVE, variants: [{ price: "1,500" }] }) {
          product { variants { id } } } }`,
    );
    const place = async () =>
      (
        await data(
          owner,
          `mutation ($variantId: ID!) {
            orderCreate(input: {
              lineItems: [{ variantId: $variantId, quantity: 1 }],
              shippingAddress: { name: "Sana Malik", phone: "0301 2345678",
                                 address1: "Flat 3, Block B", city: "Karachi" },
              paymentMethod: CASH_ON_DELIVERY
            }) { order { id } userErrors { message } } }`,
          { variantId: product.product.variants[0].id },
        )
      ).order.id as string;
    const [waiting, confirmed] = [await place(), await place()];
    await hear('order.created');
    expect(await runs.sweep()).toEqual({ done: 0, skipped: 0, failed: 0, retrying: 0, waiting: 2 });
    // Nothing more until the day is up.
    expect(await runs.sweep(new Date(Date.now() + 23 * 3_600_000))).toMatchObject({
      done: 0,
      waiting: 0,
    });
    // One is confirmed in the meantime; the other still waits for it.
    const statusOf = (id: string, status: string) =>
      admin.query('UPDATE orders.orders SET confirmation_status = $2 WHERE id = $1', [
        fromPublicId(id, 'order'),
        status,
      ]);
    await statusOf(waiting, 'pending');
    await statusOf(confirmed, 'confirmed');
    expect(await runs.sweep(new Date(Date.now() + 25 * 3_600_000))).toEqual({
      done: 2,
      skipped: 0,
      failed: 0,
      retrying: 0,
      waiting: 0,
    });
    const ran = await data(owner, RUNS, { id: made.workflow.id });
    const runOf = (id: string) => ran.find((run: Json) => run.orderId === id);
    expect(runOf(waiting)).toMatchObject({
      status: 'DONE',
      steps: [
        { action: 'WAIT', outcome: 'DONE' },
        { action: 'CONTINUE_IF', outcome: 'DONE', detail: null },
        { action: 'ADD_ORDER_TAGS', outcome: 'DONE', detail: 'call-again' },
      ],
    });
    expect(runOf(waiting).steps[0].detail).toMatch(/^Until \d{4}-/);
    expect(runOf(confirmed)).toMatchObject({
      status: 'DONE',
      steps: [
        { action: 'WAIT', outcome: 'DONE' },
        {
          action: 'CONTINUE_IF',
          outcome: 'SKIPPED',
          detail: "Its conditions didn't hold: the rest was left",
        },
      ],
    });
    const tagsOf = async (id: string) =>
      (await data(owner, `query ($id: ID!) { order(id: $id) { tags } }`, { id })).tags;
    expect(await tagsOf(waiting)).toEqual(['call-again']);
    expect(await tagsOf(confirmed)).toEqual([]);
  });

  it('holds an order for review until staff confirm it (ADR-904)', async () => {
    const owner = await account('manager');
    await admin.query('UPDATE apps.workflows SET enabled = false WHERE shop_id = $1', [shop]);
    const wrong = await data(owner, CREATE, {
      input: {
        name: 'Hold new customers',
        trigger: 'CUSTOMER_CREATED',
        actions: [{ type: 'HOLD_ORDER' }],
      },
    });
    expect(wrong.userErrors).toEqual([
      {
        field: ['input', 'actions', '0', 'type'],
        code: 'INVALID',
        message: 'This trigger tells of no order to change',
      },
    ]);
    const made = await data(owner, CREATE, {
      input: {
        name: 'Hold big orders',
        trigger: 'ORDER_CREATED',
        actions: [{ type: 'HOLD_ORDER' }, { type: 'HOLD_ORDER' }],
      },
    });
    expect(made.userErrors).toEqual([]);
    expect(made.workflow.actions.map((each: Json) => each.type)).toEqual([
      'HOLD_ORDER',
      'HOLD_ORDER',
    ]);

    const product = await data(
      owner,
      `mutation {
        productCreate(input: { title: "Chador", status: ACTIVE, variants: [{ price: "2,500" }] }) {
          product { variants { id } } } }`,
    );
    const placed = await data(
      owner,
      `mutation ($variantId: ID!) {
        orderCreate(input: {
          lineItems: [{ variantId: $variantId, quantity: 1 }],
          shippingAddress: { name: "Sana Malik", phone: "0301 2345678",
                             address1: "Flat 3, Block B", city: "Karachi" },
          paymentMethod: CASH_ON_DELIVERY
        }) { order { id stage } userErrors { message } } }`,
      { variantId: product.product.variants[0].id },
    );
    expect(placed.order.stage).toBe('NEEDS_CONFIRMATION');
    await hear('order.created');
    expect(await runs.sweep()).toMatchObject({ done: 1, failed: 0 });
    const [run] = await data(owner, RUNS, { id: made.workflow.id });
    expect(run.steps).toEqual([
      { action: 'HOLD_ORDER', outcome: 'DONE', detail: 'Held for review' },
      { action: 'HOLD_ORDER', outcome: 'SKIPPED', detail: 'It is held for review already' },
    ]);
    const order = await data(
      owner,
      `query ($id: ID!) { order(id: $id) { stage events(first: 10) { nodes { message } } } }`,
      { id: placed.order.id },
    );
    expect(order.stage).toBe('NEEDS_REVIEW');
    expect(order.events.nodes.map((each: Json) => each.message)).toContain(
      'Held for review by the workflow “Hold big orders”',
    );
  });

  it("runs on a variant's stock, checking what its alert tells (ADR-905)", async () => {
    const owner = await account('manager');
    await admin.query('UPDATE apps.workflows SET enabled = false WHERE shop_id = $1', [shop]);
    const made = await data(owner, CREATE, {
      input: {
        name: 'Lawn running low',
        trigger: 'STOCK_LOW',
        conditions: [{ field: 'trigger.product', operator: 'CONTAINS', value: 'lawn' }],
        actions: [
          {
            type: 'CONTINUE_IF',
            conditions: [{ field: 'trigger.available', operator: 'AT_MOST', value: '2' }],
          },
          {
            type: 'NOTIFY_STAFF',
            title: '{{trigger.product}} ({{trigger.variant}}) is low',
            message: '{{trigger.available}} left of {{trigger.threshold}}',
          },
        ],
      },
    });
    expect(made.userErrors).toEqual([]);
    // Its order's actions are not this trigger's.
    const wrong = await data(owner, CREATE, {
      input: {
        name: 'Tag it',
        trigger: 'STOCK_OUT',
        actions: [{ type: 'ADD_ORDER_TAGS', tags: ['x'] }],
      },
    });
    expect(wrong.userErrors[0]).toMatchObject({
      message: 'This trigger tells of no order to change',
    });

    // The shop's low-stock alert, as the inventory module records it.
    const alert = (productTitle: string, available: number) =>
      admin.query(
        `INSERT INTO platform.outbox_events (id, shop_id, aggregate_type, aggregate_id, event_type, payload)
         VALUES ($1, $2, 'variant', $3, 'stock.alerted', $4)`,
        [
          randomUUID(),
          shop,
          randomUUID(),
          {
            productId: randomUUID(),
            state: 'low',
            available,
            threshold: 5,
            productTitle,
            variantTitle: 'Maroon',
            sku: null,
          },
        ],
      );
    await alert('Lawn suit', 2);
    await alert('Lawn suit', 4);
    await alert('Khaddar shawl', 1);
    await hear('stock.alerted');
    expect(await runs.sweep()).toMatchObject({ done: 2, skipped: 1, failed: 0 });
    const ran = await data(owner, RUNS, { id: made.workflow.id });
    expect(ran.map((run: Json) => run.status).sort()).toEqual(['DONE', 'DONE', 'SKIPPED']);
    expect(ran.map((run: Json) => run.steps.map((step: Json) => step.outcome))).toContainEqual([
      'DONE',
      'SKIPPED',
    ]);
    expect(ran.map((run: Json) => run.steps.map((step: Json) => step.outcome))).toContainEqual([
      'SKIPPED',
    ]);
  });
});
