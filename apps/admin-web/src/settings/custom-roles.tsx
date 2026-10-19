import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  CustomRoleCreateMutation,
  CustomRoleDeleteMutation,
  CustomRoleUpdateMutation,
  CustomRolesQuery,
} from '../api/operations';
import type {
  CustomRole,
  CustomRoleCreateData,
  CustomRoleDeleteData,
  CustomRoleInput,
  CustomRoleRef,
  CustomRolesData,
  CustomRoleUpdateData,
  RolePreset,
  StaffCapability,
  StaffMemberRole,
  UserError,
} from '../api/types';
import { useRecentAuthentication } from '../auth/confirm-identity';
import { errorText } from '../i18n/errors';
import { useLocale, type Translate } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { CheckField, SelectField } from './settings-form';
import { roleLabel } from './settings-page';

/** The shop's custom roles and the presets they are made from (ADR-578), cached under one key. */
export function useCustomRoles(enabled: boolean) {
  return useAdminQuery<CustomRolesData>(['customRoles'], CustomRolesQuery, undefined, { enabled });
}

/**
 * The roles a member may be given, as a select's options: the presets, and the shop's custom
 * roles apart under their own heading where it has any. A custom role's value is its ID.
 */
export function RoleOptions({
  presets,
  custom,
}: {
  presets: readonly StaffMemberRole[];
  custom: readonly CustomRoleRef[];
}) {
  const { t } = useLocale();
  const options = presets.map((each) => (
    <option key={each} value={each}>
      {t(roleLabel(each))}
    </option>
  ));
  if (custom.length === 0) return <>{options}</>;
  return (
    <>
      <optgroup label={t('roles.presets')}>{options}</optgroup>
      <optgroup label={t('roles.yours')}>
        {custom.map((role) => (
          <option key={role.id} value={role.id}>
            {role.name}
          </option>
        ))}
      </optgroup>
    </>
  );
}

/** A role by name: a custom role's own, "based on" its preset quietly after it; or a preset's. */
export function RoleName({
  role,
  customRole,
}: {
  role: StaffMemberRole;
  customRole: CustomRoleRef | null | undefined;
}) {
  const { t } = useLocale();
  if (!customRole) return <>{t(roleLabel(role))}</>;
  return (
    <>
      <span dir="auto">{customRole.name}</span>{' '}
      <span className="text-[length:var(--hatti-type-body-sm-size)] text-secondary">
        ({t('roles.basedOnQuiet', { role: t(roleLabel(customRole.basedOn)) })})
      </span>
    </>
  );
}

/** Capabilities in the merchant's words, grouped as they think of them. */
const CAPABILITY_GROUPS: readonly {
  label: MessageKey;
  capabilities: readonly StaffCapability[];
}[] = [
  {
    label: 'roles.group.numbers',
    capabilities: ['SEE_CUSTOMER_NUMBERS', 'REVEAL_CUSTOMER_NUMBERS'],
  },
  {
    label: 'roles.group.orders',
    capabilities: [
      'EXPORT_ORDERS',
      'MANAGE_EXPORT_SCHEDULES',
      'REFUND_ORDERS',
      'ASSIGN_ORDERS',
      'MODERATE_COMMENTS',
    ],
  },
  { label: 'roles.group.money', capabilities: ['RECONCILE_PAYMENTS', 'CLAIM_FROM_COURIERS'] },
  {
    label: 'roles.group.team',
    capabilities: [
      'SEE_STAFF_PERFORMANCE',
      'MANAGE_STAFF',
      'MANAGE_APPS',
      'SEE_BILLING',
      'SEE_VERIFICATION',
      'MANAGE_SUPPORT_ACCESS',
    ],
  },
];
const KNOWN_CAPABILITIES = new Set(CAPABILITY_GROUPS.flatMap((group) => group.capabilities));

function capabilityLabel(capability: StaffCapability, t: Translate): string {
  return KNOWN_CAPABILITIES.has(capability)
    ? t(`roles.capability.${capability}` as MessageKey)
    : capability;
}

/** The areas scopes reach (`read_<area>`, `write_<area>`), grouped as the shop is laid out. */
const AREA_GROUPS: readonly { label: MessageKey; areas: readonly string[] }[] = [
  { label: 'roles.areas.catalog', areas: ['products', 'inventory', 'locations'] },
  {
    label: 'roles.areas.sales',
    areas: [
      'orders',
      'customers',
      'segments',
      'store_credit_accounts',
      'store_credit_account_transactions',
      'gift_cards',
      'conversations',
    ],
  },
  { label: 'roles.areas.marketing', areas: ['discounts', 'pixels', 'marketing_events'] },
  {
    label: 'roles.areas.store',
    areas: [
      'themes',
      'online_store_navigation',
      'online_store_pages',
      'content',
      'domains',
      'legal_policies',
      'translations',
      'files',
    ],
  },
  { label: 'roles.areas.shop', areas: ['settings'] },
];
const KNOWN_AREAS = new Set(AREA_GROUPS.flatMap((group) => group.areas));

function areaLabel(area: string, t: Translate): string {
  return KNOWN_AREAS.has(area)
    ? t(`apps.resource.${area}` as MessageKey)
    : area.replaceAll('_', ' ');
}

/** How far a role reaches an area: a write is view and edit. */
type Level = 'none' | 'read' | 'write';

/** Each area `scopes` reach, in their order, and how far: edit where they write it. */
function levelsOf(scopes: readonly string[]): Map<string, Level> {
  const levels = new Map<string, Level>();
  for (const scope of scopes) {
    const [, access, area] = /^(read|write)_(.+)$/.exec(scope) ?? [];
    if (!area) continue;
    if (access === 'write' || !levels.has(area)) levels.set(area, access as Level);
  }
  return levels;
}

/** The scopes the areas' levels ask for, in the preset's order: the write alone for an edit. */
function scopesOf(preset: Map<string, Level>, chosen: Map<string, Level>): string[] {
  return [...preset.keys()].flatMap((area) => {
    const level = chosen.get(area) ?? 'none';
    return level === 'none' ? [] : [`${level}_${area}`];
  });
}

/** What a role holds of its preset's: the preset's own areas and capabilities, nothing beyond. */
function chosenOf(preset: RolePreset, scopes: readonly string[], capabilities: readonly string[]) {
  const reach = levelsOf(preset.scopes);
  const held = levelsOf(scopes);
  const levels = new Map<string, Level>();
  for (const [area, most] of reach) {
    const level = held.get(area) ?? 'none';
    levels.set(area, most === 'read' && level === 'write' ? 'read' : level);
  }
  return {
    levels,
    capabilities: new Set(preset.capabilities.filter((each) => capabilities.includes(each))),
  };
}

/** A refusal in the merchant's words: what it is about, by what was sent at its index. */
function problemsOf(
  errors: readonly UserError[],
  input: { scopes: string[]; capabilities: StaffCapability[] },
  t: Translate,
): { name: string | null; others: string[] } {
  let name: string | null = null;
  const others: string[] = [];
  for (const error of errors) {
    const [, field, index] = error.field ?? [];
    if (field === 'name') name = error.message;
    else if (field === 'scopes' && index !== undefined && input.scopes[Number(index)]) {
      const scope = input.scopes[Number(index)]!;
      const [, access = '', area = scope] = /^(read|write)_(.+)$/.exec(scope) ?? [];
      others.push(
        `${t('roles.areaAccess', {
          area: areaLabel(area, t),
          access: access === 'write' ? t('roles.editAccess') : t('roles.view'),
        })}: ${error.message}`,
      );
    } else if (
      field === 'capabilities' &&
      index !== undefined &&
      input.capabilities[Number(index)]
    ) {
      others.push(`${capabilityLabel(input.capabilities[Number(index)]!, t)}: ${error.message}`);
    } else if (field === 'basedOn') others.push(`${t('roles.basedOn')}: ${error.message}`);
    else others.push(error.message);
  }
  return { name, others };
}

/** An area's row: view, and edit where the preset edits it; edit takes view with it. */
function AreaRow({
  area,
  most,
  level,
  onChange,
}: {
  area: string;
  most: Level;
  level: Level;
  onChange: (level: Level) => void;
}) {
  const { t } = useLocale();
  const label = areaLabel(area, t);
  const box = (access: 'read' | 'write', checked: boolean, onTick: (ticked: boolean) => void) => (
    <label className="inline-flex min-h-12 cursor-pointer items-center gap-2 md:min-h-10">
      <input
        type="checkbox"
        checked={checked}
        aria-label={t('roles.areaAccess', {
          area: label,
          access: access === 'write' ? t('roles.editAccess') : t('roles.view'),
        })}
        onChange={(event) => onTick(event.target.checked)}
        className="size-5 shrink-0 accent-[var(--hatti-color-primary)]"
      />
      <span aria-hidden>{access === 'write' ? t('roles.editAccess') : t('roles.view')}</span>
    </label>
  );
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4">
      <span>{label}</span>
      <span className="flex gap-4">
        {box('read', level !== 'none', (ticked) =>
          onChange(ticked ? (level === 'none' ? 'read' : level) : 'none'),
        )}
        {most === 'write' &&
          box('write', level === 'write', (ticked) => onChange(ticked ? 'write' : 'read'))}
      </span>
    </li>
  );
}

/**
 * Making a role, or changing one's name and what it holds: its preset, chosen when it is made and
 * kept after, and checklists of the preset's capabilities and areas, everything the preset has
 * ticked to begin with. A role only narrows its preset, so nothing beyond it is offered.
 */
function RoleEditor({
  role,
  presets,
  onSaved,
  onCancel,
}: {
  role: CustomRole | null;
  presets: readonly RolePreset[];
  onSaved: (name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const create = useAdminMutation<CustomRoleCreateData, { input: CustomRoleInput }>(
    CustomRoleCreateMutation,
  );
  const update = useAdminMutation<
    CustomRoleUpdateData,
    { id: string; input: Omit<CustomRoleInput, 'basedOn'> }
  >(CustomRoleUpdateMutation);
  const { run, panel } = useRecentAuthentication();
  const [name, setName] = useState(role?.name ?? '');
  const [basedOn, setBasedOn] = useState<StaffMemberRole>(
    role?.basedOn ?? presets[0]?.role ?? 'PACKER',
  );
  const presetOf = (each: StaffMemberRole) => presets.find((preset) => preset.role === each);
  const preset: RolePreset = presetOf(basedOn) ?? {
    role: basedOn,
    scopes: [],
    capabilities: [],
    customizable: true,
  };
  const start = (from: RolePreset) =>
    role && role.basedOn === from.role
      ? chosenOf(from, role.scopes, role.capabilities)
      : chosenOf(from, from.scopes, from.capabilities);
  const [chosen, setChosen] = useState(() => start(preset));
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const reach = levelsOf(preset.scopes);

  const onBasedOn = (next: StaffMemberRole) => {
    setBasedOn(next);
    const from = presetOf(next);
    if (from) setChosen(start(from));
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setNameProblem(null);
    setProblems([]);
    const input = {
      name: name.trim(),
      scopes: scopesOf(reach, chosen.levels),
      capabilities: preset.capabilities.filter((each) => chosen.capabilities.has(each)),
    };
    const refused = (errors: UserError[]) => {
      const found = problemsOf(errors, input, t);
      setNameProblem(found.name);
      setProblems(found.others);
    };
    void run(
      async () => {
        if (role) {
          const { customRoleUpdate } = await update.mutateAsync({ id: role.id, input });
          if (customRoleUpdate.userErrors.length > 0) refused(customRoleUpdate.userErrors);
          else onSaved(customRoleUpdate.customRole?.name ?? input.name);
        } else {
          const { customRoleCreate } = await create.mutateAsync({
            input: {
              name: input.name,
              basedOn,
              scopes: input.scopes,
              capabilities: input.capabilities,
            },
          });
          if (customRoleCreate.userErrors.length > 0) refused(customRoleCreate.userErrors);
          else onSaved(customRoleCreate.customRole?.name ?? input.name);
        }
      },
      (failure) => setProblems([errorText(failure, t)]),
    );
  };

  const presetName = t(roleLabel(basedOn));
  const capabilityGroups = [
    ...CAPABILITY_GROUPS,
    {
      label: 'roles.group.other' as MessageKey,
      capabilities: preset.capabilities.filter((each) => !KNOWN_CAPABILITIES.has(each)),
    },
  ]
    .map((group) => ({
      label: group.label,
      capabilities: group.capabilities.filter((each) => preset.capabilities.includes(each)),
    }))
    .filter((group) => group.capabilities.length > 0);
  const areaGroups = [
    ...AREA_GROUPS,
    {
      label: 'roles.areas.other' as MessageKey,
      areas: [...reach.keys()].filter((area) => !KNOWN_AREAS.has(area)),
    },
  ]
    .map((group) => ({ label: group.label, areas: group.areas.filter((area) => reach.has(area)) }))
    .filter((group) => group.areas.length > 0);

  return (
    <>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <FormSection
          title={role ? t('roles.change', { name: role.name }) : t('roles.make')}
          hint={t('roles.narrowOnly', { role: presetName })}
        >
          <TextField
            label={t('roles.name')}
            hint={t('roles.nameHint')}
            dir="auto"
            maxLength={40}
            required
            value={name}
            error={nameProblem}
            onChange={(event) => setName(event.target.value)}
          />
          <div className="flex flex-col gap-1">
            <SelectField<StaffMemberRole>
              label={t('roles.basedOn')}
              value={basedOn}
              disabled={role !== null}
              options={(role ? [basedOn] : presets.map((each) => each.role)).map((each) => ({
                value: each,
                label: t(roleLabel(each)),
              }))}
              onChange={onBasedOn}
            />
            <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
              {role ? t('roles.basedOnFixed') : t(`role.${basedOn}.hint` as MessageKey)}
            </span>
          </div>
        </FormSection>

        <FormSection title={t('roles.permissions')} hint={t('roles.permissionsHint')}>
          {capabilityGroups.length === 0 ? (
            <p className="text-secondary">{t('roles.noPermissions', { role: presetName })}</p>
          ) : (
            capabilityGroups.map((group) => (
              <fieldset key={group.label} className="flex flex-col gap-1">
                <legend className="mb-1 font-medium">{t(group.label)}</legend>
                {group.capabilities.map((capability) => (
                  <CheckField
                    key={capability}
                    label={capabilityLabel(capability, t)}
                    checked={chosen.capabilities.has(capability)}
                    onChange={(checked) =>
                      setChosen((all) => {
                        const capabilities = new Set(all.capabilities);
                        if (checked) capabilities.add(capability);
                        else capabilities.delete(capability);
                        return { ...all, capabilities };
                      })
                    }
                  />
                ))}
              </fieldset>
            ))
          )}
        </FormSection>

        <FormSection title={t('roles.areas')} hint={t('roles.areasHint')}>
          {areaGroups.map((group) => (
            <fieldset key={group.label} className="flex flex-col gap-1">
              <legend className="mb-1 font-medium">{t(group.label)}</legend>
              <ul className="flex flex-col divide-y divide-line">
                {group.areas.map((area) => (
                  <AreaRow
                    key={area}
                    area={area}
                    most={reach.get(area) ?? 'none'}
                    level={chosen.levels.get(area) ?? 'none'}
                    onChange={(level) =>
                      setChosen((all) => ({
                        ...all,
                        levels: new Map(all.levels).set(area, level),
                      }))
                    }
                  />
                ))}
              </ul>
            </fieldset>
          ))}
        </FormSection>

        {problems.length > 0 && (
          <Alert tone="danger">
            <ul className="flex flex-col gap-1">
              {problems.map((problem, index) => (
                <li key={index}>{problem}</li>
              ))}
            </ul>
          </Alert>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={create.isPending || update.isPending}>
            {role ? t('roles.save') : t('roles.create')}
          </Button>
          <Button variant="tertiary" onClick={onCancel}>
            {t('action.back')}
          </Button>
        </div>
      </form>
      {panel}
    </>
  );
}

/**
 * The shop's own roles (ADM-01, ADR-578), for those who manage staff: each with its preset and
 * how many hold it; one made from a preset the member manages, changed, or deleted once nobody
 * holds it. Roles made from a preset above the member's are shown, not changed.
 */
export function RolesTab({ managed }: { managed: readonly StaffMemberRole[] }) {
  const { t } = useLocale();
  const query = useCustomRoles(true);
  const remove = useAdminMutation<CustomRoleDeleteData, { id: string }>(CustomRoleDeleteMutation);
  const { run, panel } = useRecentAuthentication();
  const [editing, setEditing] = useState<CustomRole | 'new' | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (query.isPending) return <Loading label={t('state.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  }
  const { customRoles: roles, rolePresets } = query.data;
  const presets = rolePresets.filter(
    (preset) => preset.customizable && managed.includes(preset.role),
  );

  const onDelete = (role: CustomRole) => {
    setProblem(null);
    setNotice(null);
    void run(
      async () => {
        const { customRoleDelete } = await remove.mutateAsync({ id: role.id });
        setDeleting(null);
        if (customRoleDelete.userErrors[0]) setProblem(customRoleDelete.userErrors[0].message);
        else setNotice(t('roles.deleted', { name: role.name }));
      },
      (failure) => setProblem(errorText(failure, t)),
    );
  };

  if (editing) {
    return (
      <RoleEditor
        key={editing === 'new' ? 'new' : editing.id}
        role={editing === 'new' ? null : editing}
        presets={editing === 'new' ? presets : rolePresets}
        onSaved={(name) => {
          setEditing(null);
          setNotice(t('roles.saved', { name }));
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <section aria-labelledby="staff-roles" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="staff-roles" className="font-semibold">
          {t('roles.title')}
        </h2>
        {presets.length > 0 && (
          <Button
            icon={<Plus aria-hidden className="size-5" />}
            onClick={() => {
              setNotice(null);
              setProblem(null);
              setEditing('new');
            }}
          >
            {t('roles.new')}
          </Button>
        )}
      </div>
      <p className="text-secondary">{t('roles.hint')}</p>
      {panel}
      {notice && <Alert tone="success">{notice}</Alert>}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {roles.length === 0 ? (
        <Card>
          <EmptyState title={t('roles.none')} body={t('roles.noneHint')} />
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {roles.map((role) => {
              const yours = managed.includes(role.basedOn);
              return (
                <li key={role.id} className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium" dir="auto">
                        {role.name}
                      </span>
                      <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                        {t('roles.basedOnRole', { role: t(roleLabel(role.basedOn)) })} ·{' '}
                        {t('roles.members', { count: role.staffMemberCount })}
                      </span>
                    </span>
                    {yours && deleting !== role.id && (
                      <span className="flex gap-1">
                        <Button
                          variant="secondary"
                          icon={<Pencil aria-hidden className="size-5" />}
                          aria-label={t('roles.edit', { name: role.name })}
                          onClick={() => {
                            setNotice(null);
                            setProblem(null);
                            setEditing(role);
                          }}
                        >
                          {t('roles.editButton')}
                        </Button>
                        <Button
                          variant="danger"
                          icon={<Trash2 aria-hidden className="size-5" />}
                          aria-label={t('roles.delete', { name: role.name })}
                          onClick={() => {
                            setNotice(null);
                            setProblem(null);
                            setDeleting(role.id);
                          }}
                        />
                      </span>
                    )}
                  </div>
                  {deleting === role.id && (
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{t('roles.deleteSure', { name: role.name })}</span>
                      <Button
                        variant="destructive"
                        busy={remove.isPending}
                        onClick={() => onDelete(role)}
                      >
                        {t('roles.deleteYes')}
                      </Button>
                      <Button variant="tertiary" onClick={() => setDeleting(null)}>
                        {t('action.back')}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </section>
  );
}
