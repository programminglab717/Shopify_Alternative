import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { fakeCore, renderAdmin, signedIn, type } from '../test-support';

const REVIEWS = {
  id: 'fext_2',
  appName: 'Reviews',
  kind: 'ACTION',
  title: 'Ask for a review',
  description: '',
  resource: 'ORDER',
  fields: [{ key: 'message', label: 'Message', type: 'TEXT', required: true }],
};

const RATED = {
  id: 'fext_1',
  appName: 'Reviews',
  kind: 'TRIGGER',
  title: 'Review posted',
  description: '',
  resource: 'ORDER',
  fields: [{ key: 'rating', label: 'Rating', type: 'NUMBER', required: true }],
};

function core(role: StaffRole = 'owner') {
  let workflows: Record<string, unknown>[] = [];
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'Workflows':
        return { workflows, flowExtensions: [RATED, REVIEWS] };
      case 'WorkflowRuns':
        return {
          workflowRuns: [
            {
              id: 'wrun_1',
              status: 'DONE',
              orderId: 'order_1',
              customerId: null,
              steps: [{ action: 'ADD_ORDER_TAGS', outcome: 'DONE', detail: 'big-cod' }],
              attempts: 1,
              createdAt: '2026-10-28T09:00:00Z',
            },
          ],
        };
      case 'WorkflowCreate': {
        const input = variables.input as Record<string, unknown>;
        if (String(input.name).length > 100) {
          return {
            workflowCreate: {
              workflow: null,
              userErrors: [
                { field: ['input', 'name'], code: 'TOO_LONG', message: 'Name is too long' },
              ],
            },
          };
        }
        const made = {
          ...input,
          id: 'wkfl_1',
          extension: null,
          lastRunStatus: 'DONE',
          lastRunAt: '2026-10-28T09:00:00Z',
        };
        workflows = [made];
        return { workflowCreate: { workflow: made, userErrors: [] } };
      }
      case 'WorkflowDelete':
        workflows = [];
        return { workflowDelete: { deletedWorkflowId: variables.id, userErrors: [] } };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

const sentOf = (fake: ReturnType<typeof core>, operation: string) =>
  fake.sent.filter((each) => each.operation === operation).map((each) => each.variables);

describe('Workflows (DEV-11, ADR-861)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('makes a workflow from a starting one, with an app action, and lists its runs', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings');

    fireEvent.click(await screen.findByRole('link', { name: /Workflows/ }));
    expect(await screen.findByText('No workflows yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Big cash-on-delivery orders' }));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(
      'Big cash-on-delivery orders',
    );
    expect((screen.getByLabelText('What condition 1 checks') as HTMLSelectElement).value).toBe(
      'order.payment_method',
    );
    expect((screen.getByLabelText('Value for condition 2') as HTMLInputElement).value).toBe(
      '10000',
    );
    type('Value for condition 2', '5000');
    type('Name', 'Big COD');

    // The second action becomes the app's, with its field.
    fireEvent.change(screen.getByLabelText('Action 2'), { target: { value: 'APP_ACTION:fext_2' } });
    type('Message', 'Thanks for {{order.name}}');
    type('Name', 'B'.repeat(101));
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }));
    expect(await screen.findByText(/Name is too long/)).toBeTruthy();
    type('Name', 'Big COD');
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() =>
      expect(sentOf(fake, 'WorkflowCreate').at(-1)).toEqual({
        input: {
          name: 'Big COD',
          trigger: 'ORDER_CREATED',
          extensionId: null,
          match: 'ALL',
          conditions: [
            { field: 'order.payment_method', operator: 'EQUALS', value: 'cash_on_delivery' },
            { field: 'order.total', operator: 'AT_LEAST', value: '5000' },
          ],
          actions: [
            {
              type: 'ADD_ORDER_TAGS',
              tags: ['big-cod'],
              title: null,
              message: null,
              extensionId: null,
              properties: [],
              hours: null,
              match: null,
              conditions: [],
            },
            {
              type: 'APP_ACTION',
              tags: [],
              title: null,
              message: null,
              extensionId: 'fext_2',
              properties: [{ key: 'message', value: 'Thanks for {{order.name}}' }],
              hours: null,
              match: null,
              conditions: [],
            },
          ],
          enabled: true,
        },
      }),
    );

    fireEvent.click(await screen.findByRole('button', { name: /^Big COD/ }));
    const runs = await screen.findByRole('heading', { name: 'Latest runs' });
    const card = runs.parentElement!;
    expect(await within(card).findByText('Add tags to the order: done (big-cod)')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Open the order' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete workflow' }));
    expect(await screen.findByText('No workflows yet.')).toBeTruthy();
    expect(sentOf(fake, 'WorkflowDelete')).toEqual([{ id: 'wkfl_1' }]);
  });

  it('waits, then goes on only if the order is still unconfirmed (ADR-886)', async () => {
    const fake = core();
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/settings/workflows');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Orders still unconfirmed after a day' }),
    );
    expect((screen.getByLabelText('Action 1') as HTMLSelectElement).value).toBe('WAIT');
    expect((screen.getByLabelText('Hours action 1 waits') as HTMLInputElement).value).toBe('24');
    expect((screen.getByLabelText('Action 2') as HTMLSelectElement).value).toBe('CONTINUE_IF');
    const checked = screen.getByLabelText('Action 2: What condition 1 checks') as HTMLSelectElement;
    expect(checked.value).toBe('order.confirmation_status');
    expect(
      (screen.getByLabelText('Action 2: Value for condition 1') as HTMLSelectElement).value,
    ).toBe('confirmed');
    // Two days, and also go on only while it is still to be confirmed.
    type('Hours action 1 waits', '48');
    fireEvent.click(screen.getByRole('button', { name: 'Action 2: Add a condition' }));
    fireEvent.change(screen.getByLabelText('Action 2: What condition 2 checks'), {
      target: { value: 'order.stage' },
    });
    fireEvent.change(screen.getByLabelText('Action 2: Value for condition 2'), {
      target: { value: 'needs_confirmation' },
    });
    // Then held for review, in place of its tag (ADR-904).
    fireEvent.change(screen.getByLabelText('Action 3'), { target: { value: 'HOLD_ORDER' } });
    expect(
      screen.getByText('It waits at To review until staff look at it and confirm it.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() => expect(sentOf(fake, 'WorkflowCreate')).toHaveLength(1));
    const { actions } = (sentOf(fake, 'WorkflowCreate')[0] as { input: { actions: unknown[] } })
      .input;
    expect(actions[2]).toEqual(expect.objectContaining({ type: 'HOLD_ORDER', tags: [] }));
    expect(actions.slice(0, 2)).toEqual([
      expect.objectContaining({ type: 'WAIT', hours: 48 }),
      expect.objectContaining({
        type: 'CONTINUE_IF',
        match: 'ALL',
        conditions: [
          { field: 'order.confirmation_status', operator: 'NOT_EQUALS', value: 'confirmed' },
          { field: 'order.stage', operator: 'EQUALS', value: 'needs_confirmation' },
        ],
      }),
    ]);
  });

  it("offers an app's trigger, its fields to check, and its order's", async () => {
    vi.stubGlobal('fetch', core().fetcher);
    renderAdmin('/shop_1/settings/workflows');
    fireEvent.click(await screen.findByRole('button', { name: 'New workflow' }));
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'APP:fext_1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a condition' }));
    const field = screen.getByLabelText('What condition 1 checks') as HTMLSelectElement;
    const options = [...field.options].map((each) => each.text);
    expect(options).toContain('Rating');
    expect(options).toContain('Order total (Rs)');
  });

  it("isn't offered to those who don't manage apps", async () => {
    vi.stubGlobal('fetch', core('marketer').fetcher);
    renderAdmin('/shop_1/settings');
    await screen.findByRole('heading', { name: 'Settings' }).catch(() => null);
    expect(screen.queryByRole('link', { name: /Workflows/ })).toBeNull();
  });
});
