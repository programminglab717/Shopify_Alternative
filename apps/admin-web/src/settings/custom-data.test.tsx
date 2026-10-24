import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, press, renderAdmin, signedIn, type } from '../test-support';
import { keyOf } from './custom-data-page';

const CARE = {
  id: 'mfd_1',
  ownerType: 'PRODUCT',
  namespace: 'custom',
  key: 'care',
  type: 'multi_line_text_field',
  name: 'Care instructions',
  description: null,
  metafieldsCount: 12,
};

describe('Custom data in settings (CAT-06, ADR-489)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    signedIn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('makes a key from a name', () => {
    expect(keyOf('Care instructions')).toBe('care_instructions');
    expect(keyOf('  Fabric (weight)  ')).toBe('fabric_weight');
  });

  it('renames a field and describes it, sending only what changed, or says why not (ADR-796)', async () => {
    let current: Omit<typeof CARE, 'description'> & { description: string | null } = { ...CARE };
    const core = fakeCore('owner', (operation, variables) => {
      switch (operation) {
        case 'MetafieldDefinitions':
          return { metafieldDefinitions: [current] };
        case 'MetafieldDefinitionUpdate': {
          const definition = variables.definition as { name?: string; description?: string | null };
          if (definition.name === 'x'.repeat(5)) {
            return {
              metafieldDefinitionUpdate: {
                updatedDefinition: null,
                userErrors: [
                  { field: ['name'], code: 'INVALID', message: 'Name must be 1 to 100 characters' },
                ],
              },
            };
          }
          current = { ...current, ...definition };
          return { metafieldDefinitionUpdate: { updatedDefinition: current, userErrors: [] } };
        }
        default:
          throw new Error(`unexpected ${operation}`);
      }
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/custom-data');

    await screen.findByText('Care instructions');
    await press('Change Care instructions');
    type('Its name', 'xxxxx');
    await press('Save');
    await screen.findByText(/Name must be 1 to 100 characters/);
    type('Its name', 'Care instructions');
    type('Its description', ' How to wash it ');
    await press('Save');
    await screen.findByText('Care instructions is saved.');
    expect(screen.getByText('How to wash it')).toBeTruthy();

    // Unchanged, nothing is sent; the description emptied, it is taken away.
    await press('Change Care instructions');
    await press('Save');
    await press('Change Care instructions');
    type('Its description', '');
    await press('Save');
    await waitFor(() => expect(screen.queryByText('How to wash it')).toBeNull());
    expect(
      core.sent
        .filter((each) => each.operation === 'MetafieldDefinitionUpdate')
        .map((each) => each.variables),
    ).toEqual([
      { id: 'mfd_1', definition: { name: 'xxxxx' } },
      { id: 'mfd_1', definition: { description: 'How to wash it' } },
      { id: 'mfd_1', definition: { description: null } },
    ]);
  });

  it("lists the shop's fields by what they are for, adds one keyed from its name, and deletes one", async () => {
    const core = fakeCore('owner', (operation) => {
      switch (operation) {
        case 'MetafieldDefinitions':
          return { metafieldDefinitions: [CARE] };
        case 'MetafieldDefinitionCreate':
          return { metafieldDefinitionCreate: { createdDefinition: CARE, userErrors: [] } };
        case 'MetafieldDefinitionDelete':
          return { metafieldDefinitionDelete: { deletedDefinitionId: 'mfd_1', userErrors: [] } };
        default:
          throw new Error(`unexpected ${operation}`);
      }
    });
    vi.stubGlobal('fetch', core.fetcher);
    renderAdmin('/shop_1/settings/custom-data');

    await screen.findByText('Care instructions');
    expect(screen.getByText(/filled on 12/)).toBeTruthy();
    expect(screen.getAllByText('None yet.')).toHaveLength(2);

    fireEvent.change(screen.getByLabelText('For'), { target: { value: 'COLLECTION' } });
    type('Name', 'Banner colour');
    expect((screen.getByLabelText('Key') as HTMLInputElement).value).toBe('banner_colour');
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'color' } });
    await press('Add the field');
    await screen.findByText('Banner colour is added.');
    expect(
      core.sent.find((each) => each.operation === 'MetafieldDefinitionCreate')?.variables,
    ).toEqual({
      definition: {
        ownerType: 'COLLECTION',
        namespace: 'custom',
        key: 'banner_colour',
        type: 'color',
        name: 'Banner colour',
        description: null,
      },
    });

    await press('Delete Care instructions');
    await press('Delete');
    await waitFor(() =>
      expect(
        core.sent.find((each) => each.operation === 'MetafieldDefinitionDelete')?.variables,
      ).toEqual({ id: 'mfd_1' }),
    );
    await screen.findByText('Care instructions is deleted, with its values.');
  });
});
