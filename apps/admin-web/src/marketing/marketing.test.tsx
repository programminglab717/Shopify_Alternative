import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StaffRole } from '../auth/session';
import { sectionsOf } from '../shell/shell';
import { fakeCore, LATER, renderAdmin, signedIn } from '../test-support';
import { templateNameOf } from './templates-page';

function template(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: 'eid_sale',
    language: 'EN',
    header: null,
    body: 'Eid Mubarak {{1}}! 20% off everything this week.',
    footer: null,
    buttonText: null,
    buttonUrl: null,
    status: 'APPROVED',
    rejectedReason: null,
    createdAt: LATER,
    updatedAt: LATER,
    ...extra,
  };
}

const COUNTS = { pending: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 };

function broadcast(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: 'Eid sale',
    templateId: 'wtm_1',
    templateName: 'eid_sale',
    templateLanguage: 'EN',
    templateBody: 'Eid Mubarak {{1}}!',
    segmentId: 'seg_1',
    segmentName: 'VIPs',
    sendAt: LATER,
    status: 'SCHEDULED',
    error: null,
    recipients: 0,
    counts: COUNTS,
    startedAt: null,
    finishedAt: null,
    createdAt: LATER,
    ...extra,
  };
}

const MONEY = (amount: string) => ({ amount, currencyCode: 'PKR' });

function core(role: StaffRole, options: { templates?: unknown[]; broadcasts?: unknown[][] } = {}) {
  let templates = options.templates ?? [
    template('wtm_1'),
    template('wtm_2', { name: 'new_lawn', status: 'PENDING' }),
  ];
  const pages = options.broadcasts ?? [
    [
      broadcast('bdc_1'),
      broadcast('bdc_2', {
        name: 'Summer lawn',
        status: 'SENT',
        segmentId: null,
        segmentName: null,
        recipients: 120,
        counts: { ...COUNTS, sent: 10, delivered: 70, read: 30, failed: 10 },
      }),
      broadcast('bdc_3', {
        name: 'Old offer',
        status: 'FAILED',
        error: 'Its segment was deleted',
      }),
    ],
  ];
  // The shop's automations (ADR-425): off until set.
  let automations: {
    kind: string;
    enabled: boolean;
    afterDays: number | null;
    [key: string]: unknown;
  }[] = [
    { kind: 'WELCOME', enabled: false, template: null, afterDays: null, updatedAt: null },
    { kind: 'WIN_BACK', enabled: false, template: null, afterDays: 60, updatedAt: null },
    { kind: 'BACK_IN_STOCK', enabled: false, template: null, afterDays: null, updatedAt: null },
  ];
  return fakeCore(role, (operation, variables) => {
    switch (operation) {
      case 'WhatsAppTemplates':
        return { whatsAppTemplates: templates };
      case 'WhatsAppTemplateCreate': {
        const input = variables.input as Record<string, unknown>;
        if (input.name === 'taken') {
          return {
            whatsAppTemplateCreate: {
              whatsAppTemplate: null,
              userErrors: [
                {
                  field: ['input', 'name'],
                  code: 'TAKEN',
                  message: 'A template of the number already has this name and language',
                },
              ],
            },
          };
        }
        const made = template('wtm_9', { ...input, status: 'PENDING' });
        templates = [made, ...templates];
        return { whatsAppTemplateCreate: { whatsAppTemplate: made, userErrors: [] } };
      }
      case 'WhatsAppTemplateDelete':
        templates = templates.filter((each) => (each as { id: string }).id !== variables.id);
        return {
          whatsAppTemplateDelete: { deletedWhatsAppTemplateId: variables.id, userErrors: [] },
        };
      case 'WhatsAppTemplatesSync':
        templates = templates.map((each) => ({ ...(each as object), status: 'APPROVED' }));
        return { whatsAppTemplatesSync: { whatsAppTemplates: templates, userErrors: [] } };
      case 'Segments':
        return {
          segments: {
            nodes: [
              { id: 'seg_1', name: 'VIPs', query: "customer_tags CONTAINS 'vip'", memberCount: 3 },
            ],
          },
        };
      case 'BroadcastEstimate':
        return {
          broadcastEstimate: variables.segmentId
            ? { recipients: 1, pricePerMessage: MONEY('14.58'), cost: MONEY('14.58') }
            : { recipients: 2400, pricePerMessage: MONEY('14.58'), cost: MONEY('34992.00') },
        };
      case 'Broadcasts': {
        const index = variables.after ? 1 : 0;
        return {
          broadcasts: {
            nodes: pages[index] ?? [],
            pageInfo: {
              hasNextPage: index + 1 < pages.length,
              endCursor: index + 1 < pages.length ? 'cursor_1' : null,
            },
          },
        };
      }
      case 'BroadcastCreate':
        return {
          broadcastCreate: {
            broadcast: broadcast('bdc_9', variables.input as Record<string, unknown>),
            userErrors: [],
          },
        };
      case 'MarketingAutomations':
        return { marketingAutomations: automations, whatsAppTemplates: templates };
      case 'MarketingAutomationUpdate': {
        const input = variables.input as {
          enabled: boolean;
          templateId: string | null;
          afterDays?: number;
        };
        const chosen = (templates as { id: string; status: string }[]).find(
          (each) => each.id === input.templateId,
        );
        if (input.enabled && variables.kind !== 'BACK_IN_STOCK' && chosen?.status !== 'APPROVED') {
          return {
            marketingAutomationUpdate: {
              marketingAutomation: null,
              userErrors: [
                {
                  field: ['input', 'templateId'],
                  code: 'INVALID',
                  message: "Meta hasn't approved this template",
                },
              ],
            },
          };
        }
        automations = automations.map((each) =>
          each.kind === variables.kind
            ? {
                ...each,
                enabled: input.enabled,
                template: chosen ?? null,
                afterDays: input.afterDays ?? each.afterDays,
                updatedAt: LATER,
              }
            : each,
        );
        return {
          marketingAutomationUpdate: {
            marketingAutomation: automations.find((each) => each.kind === variables.kind),
            userErrors: [],
          },
        };
      }
      case 'BroadcastCancel':
        return {
          broadcastCancel: {
            broadcast: broadcast(variables.id as string, { status: 'CANCELLED' }),
            userErrors: [],
          },
        };
      default:
        throw new Error(`unexpected ${operation}`);
    }
  });
}

describe('Marketing: WhatsApp broadcasts and templates (MKT-01, ADR-424)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('is a section for the owner, managers and marketers alone', () => {
    for (const role of ['owner', 'manager', 'marketer'] as const) {
      expect(sectionsOf(role).some((item) => item.to === '/$shopId/marketing')).toBe(true);
    }
    for (const role of ['confirmation_agent', 'packer', 'accountant'] as const) {
      expect(sectionsOf(role).some((item) => item.to === '/$shopId/marketing')).toBe(false);
    }
  });

  it('estimates a broadcast as its segment is chosen, and schedules it with an approved template', async () => {
    const fake = core('marketer');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/marketing');

    expect(
      await screen.findByText(
        'Reaches 2,400 customers who agreed to hear from you on WhatsApp, for about Rs 34,992 from your message credit (Rs 14.58 a message).',
      ),
    ).toBeTruthy();
    // The template waiting for Meta is not offered.
    const templateField = screen.getByLabelText('Template') as HTMLSelectElement;
    expect([...templateField.options].map((option) => option.text)).toEqual(['eid_sale · English']);
    expect(screen.getByText('Eid Mubarak {{1}}! 20% off everything this week.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('To'), { target: { value: 'seg_1' } });
    expect(await screen.findByText(/Reaches 1 customers/)).toBeTruthy();
    const schedule = screen.getByRole('button', {
      name: 'Schedule broadcast',
    }) as HTMLButtonElement;
    expect(schedule.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Eid sale' } });
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'later' } });
    expect(schedule.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Date and time'), {
      target: { value: '2026-10-20T11:30' },
    });
    fireEvent.click(schedule);
    await waitFor(() =>
      expect(fake.sent.find((each) => each.operation === 'BroadcastCreate')?.variables).toEqual({
        input: {
          name: 'Eid sale',
          templateId: 'wtm_1',
          segmentId: 'seg_1',
          sendAt: new Date('2026-10-20T11:30').toISOString(),
        },
      }),
    );
    expect(
      await screen.findByText('Scheduled. Its messages go from your number at the time chosen.'),
    ).toBeTruthy();
  });

  it('lists broadcasts with how their messages went, and cancels one once asked again', async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/marketing');

    const [scheduled, sent, failed] = await screen.findAllByRole('listitem');
    expect(within(scheduled!).getByText('eid_sale to VIPs')).toBeTruthy();
    expect(within(scheduled!).getByText('Scheduled')).toBeTruthy();
    expect(
      within(sent!).getByText('eid_sale to Everyone who agreed to hear on WhatsApp'),
    ).toBeTruthy();
    expect(
      within(sent!).getByText('120 customers · 110 sent · 100 delivered · 30 read · 10 failed'),
    ).toBeTruthy();
    expect(within(sent!).queryByRole('button', { name: 'Cancel broadcast' })).toBeNull();
    expect(within(failed!).getByText('Its segment was deleted')).toBeTruthy();

    fireEvent.click(within(scheduled!).getByRole('button', { name: 'Cancel broadcast' }));
    expect(within(scheduled!).getByText(/Cancel Eid sale\?/)).toBeTruthy();
    fireEvent.click(within(scheduled!).getByRole('button', { name: 'Yes, cancel' }));
    await waitFor(() =>
      expect(fake.sent.find((each) => each.operation === 'BroadcastCancel')?.variables).toEqual({
        id: 'bdc_1',
      }),
    );
  });

  it('pages through older broadcasts', async () => {
    const fake = core('owner', {
      broadcasts: [[broadcast('bdc_1')], [broadcast('bdc_0', { name: 'Last year' })]],
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/marketing');

    fireEvent.click(await screen.findByRole('button', { name: 'Older' }));
    expect(await screen.findByText('Last year')).toBeTruthy();
    expect(fake.sent.filter((each) => each.operation === 'Broadcasts').at(-1)!.variables).toEqual({
      first: 20,
      after: 'cursor_1',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Newer' }));
    expect(await screen.findByText('Eid sale')).toBeTruthy();
  });

  it('sends to the templates page without an approved template, and says who connects the number', async () => {
    vi.stubGlobal('fetch', core('marketer', { templates: [] }).fetcher);
    renderAdmin('/shop_1/marketing');

    expect(
      await screen.findByText('A broadcast sends a template Meta has approved, and none is yet.'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Templates live on your shop's own WhatsApp number, which the owner or a manager connects in settings.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Write a template' }).getAttribute('href')).toBe(
      '/shop_1/marketing/templates',
    );
    expect(screen.queryByRole('button', { name: 'Schedule broadcast' })).toBeNull();
  });

  it('writes a template and sends it to Meta, saying why one was refused', async () => {
    const fake = core('manager');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/marketing/templates');

    const send = (await screen.findByRole('button', { name: 'Send to Meta' })) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Summer Lawn-2026' } });
    expect(screen.getByText('Sent to Meta as summer_lawn_2026')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'UR' } });
    fireEvent.change(screen.getByLabelText('Words'), {
      target: { value: 'سمر لان آ گیا {{1}}!' },
    });
    fireEvent.change(screen.getByLabelText('Button (optional)'), { target: { value: 'Shop now' } });
    fireEvent.change(screen.getByLabelText("Button's link"), {
      target: { value: 'https://zari.hatti.pk/collections/lawn' },
    });
    fireEvent.click(send);
    await waitFor(() =>
      expect(
        fake.sent.find((each) => each.operation === 'WhatsAppTemplateCreate')?.variables,
      ).toEqual({
        input: {
          name: 'summer_lawn_2026',
          language: 'UR',
          body: 'سمر لان آ گیا {{1}}!',
          header: null,
          footer: null,
          buttonText: 'Shop now',
          buttonUrl: 'https://zari.hatti.pk/collections/lawn',
        },
      }),
    );
    expect(
      await screen.findByText('Sent to Meta. It shows as approved here once Meta has checked it.'),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'taken' } });
    fireEvent.change(screen.getByLabelText('Words'), { target: { value: 'Hello {{1}}' } });
    fireEvent.click(send);
    expect(
      await screen.findByText(/A template of the number already has this name and language/),
    ).toBeTruthy();
  });

  it('shows each template with what Meta made of it, asks Meta again, and deletes one', async () => {
    const fake = core('owner', {
      templates: [
        template('wtm_1'),
        template('wtm_3', {
          name: 'flash_sale',
          status: 'REJECTED',
          rejectedReason: 'INVALID_FORMAT',
        }),
      ],
    });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/marketing/templates');

    const [approved, rejected] = await screen.findAllByRole('listitem');
    expect(within(approved!).getByText('Approved')).toBeTruthy();
    expect(within(rejected!).getByText('Rejected')).toBeTruthy();
    expect(within(rejected!).getByText("Meta's reason: INVALID_FORMAT")).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Check with Meta' }));
    await waitFor(() =>
      expect(fake.sent.some((each) => each.operation === 'WhatsAppTemplatesSync')).toBe(true),
    );

    fireEvent.click(within(rejected!).getByRole('button', { name: 'Delete flash_sale' }));
    fireEvent.click(within(rejected!).getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() =>
      expect(
        fake.sent.find((each) => each.operation === 'WhatsAppTemplateDelete')?.variables,
      ).toEqual({ id: 'wtm_3' }),
    );
  });

  it('names a template as Meta takes it', () => {
    expect(templateNameOf('  Eid Sale-2026! ')).toBe('eid_sale_2026');
    expect(templateNameOf('عید')).toBe('');
  });
});

describe('Marketing: automations (MKT-04, ADR-428)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('turns the welcome on with an approved template, from Marketing', async () => {
    const fake = core('marketer');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/marketing');

    fireEvent.click(await screen.findByRole('link', { name: /Automations/ }));
    await screen.findByRole('heading', { name: 'Win-back' });
    const [welcome, winBack] = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.closest('form')!);
    expect(within(welcome!).getByText('Off')).toBeTruthy();
    // Approved templates alone to choose from.
    const which = within(welcome!).getByLabelText('Template') as HTMLSelectElement;
    expect([...which.options].map((option) => option.text)).toEqual([
      'Choose a template',
      'eid_sale (en)',
    ]);
    fireEvent.change(which, { target: { value: 'wtm_1' } });
    fireEvent.click(within(welcome!).getByLabelText('Send it'));
    fireEvent.click(within(welcome!).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(
        fake.sent.find((each) => each.operation === 'MarketingAutomationUpdate')?.variables,
      ).toEqual({ kind: 'WELCOME', input: { enabled: true, templateId: 'wtm_1' } }),
    );
    expect(await screen.findByText('On')).toBeTruthy();
    expect(within(winBack!).getByLabelText('Days after their last order')).toBeTruthy();
  });

  it("sets a win-back's days within their bounds, and says why the core refused", async () => {
    const fake = core('owner');
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/marketing/automations');

    const days = (await screen.findByLabelText('Days after their last order')) as HTMLInputElement;
    expect(days.value).toBe('60');
    const form = days.closest('form')!;
    fireEvent.change(days, { target: { value: '7' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Give days from 14 to 365')).toBeTruthy();
    expect(fake.sent.some((each) => each.operation === 'MarketingAutomationUpdate')).toBe(false);

    fireEvent.change(days, { target: { value: '90' } });
    fireEvent.click(within(form).getByLabelText('Send it'));
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    // On with no template: the core says why.
    expect(await within(form).findByText(/Meta hasn't approved this template/)).toBeTruthy();
    expect(
      fake.sent.filter((each) => each.operation === 'MarketingAutomationUpdate').at(-1)!.variables,
    ).toEqual({ kind: 'WIN_BACK', input: { enabled: true, templateId: null, afterDays: 90 } });
  });

  it('sends to the templates page while none is approved', async () => {
    vi.stubGlobal(
      'fetch',
      core('manager', { templates: [template('wtm_2', { status: 'PENDING' })] }).fetcher,
    );
    renderAdmin('/shop_1/marketing/automations');

    expect(
      await screen.findByText(/An automation sends a template Meta approved\. You have none yet\./),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'WhatsApp templates' }).getAttribute('href')).toBe(
      '/shop_1/marketing/templates',
    );
  });

  it("turns back in stock on with no template, as it sends Hatti's own (ADR-430)", async () => {
    const fake = core('marketer', { templates: [] });
    vi.stubGlobal('fetch', fake.fetcher);
    renderAdmin('/shop_1/marketing/automations');

    const form = (await screen.findByRole('heading', { name: 'Back in stock' })).closest('form')!;
    expect(within(form).queryByLabelText('Template')).toBeNull();
    expect(within(form).getByText(/Sent from Hatti's WhatsApp number/)).toBeTruthy();
    fireEvent.click(within(form).getByLabelText('Send it'));
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(
        fake.sent.find((each) => each.operation === 'MarketingAutomationUpdate')?.variables,
      ).toEqual({ kind: 'BACK_IN_STOCK', input: { enabled: true } }),
    );
    // Saved, the card comes again as the core keeps it.
    await waitFor(() =>
      expect(
        within(screen.getByRole('heading', { name: 'Back in stock' }).closest('form')!).getByText(
          'On',
        ),
      ).toBeTruthy(),
    );
  });
});
