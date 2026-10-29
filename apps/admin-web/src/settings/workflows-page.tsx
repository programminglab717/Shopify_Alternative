import { Link } from '@tanstack/react-router';
import { Plus, Trash2, Workflow as WorkflowIcon } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  WorkflowCreateMutation,
  WorkflowDeleteMutation,
  WorkflowRunsQuery,
  WorkflowUpdateMutation,
  WorkflowsQuery,
} from '../api/operations';
import type {
  FlowExtension,
  UserError,
  Workflow,
  WorkflowAction,
  WorkflowActionType,
  WorkflowCondition,
  WorkflowDeleteData,
  WorkflowInput,
  WorkflowSchedule,
  WorkflowPayloadData,
  WorkflowRunsData,
  WorkflowTriggerType,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { BackToSettings } from './settings-page';
import { CheckField, SelectField } from './settings-form';
import {
  MOST_ACTIONS,
  OPERATORS,
  TEMPLATES,
  DEFAULT_SCHEDULE,
  TRIGGERS,
  actionsOf,
  blankAction,
  fieldLabel,
  fieldsOf,
  valueLabel,
  type FactField,
} from './workflows';

/** A scheduled workflow's days and hour of the shop's own time (ADR-906). */
function ScheduleFields({
  schedule,
  onChange,
}: {
  schedule: WorkflowSchedule;
  onChange: (schedule: WorkflowSchedule) => void;
}) {
  const { t } = useLocale();
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="font-medium">{t('workflow.days')}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {[1, 2, 3, 4, 5, 6, 7].map((day) => (
          <CheckField
            key={day}
            label={t(`workflow.day.${day}` as MessageKey)}
            checked={schedule.days.includes(day)}
            onChange={(on) =>
              onChange({
                ...schedule,
                days: on
                  ? [...schedule.days, day].sort((a, b) => a - b)
                  : schedule.days.filter((each) => each !== day),
              })
            }
          />
        ))}
      </div>
      <SelectField
        label={t('workflow.hour')}
        value={String(schedule.hour)}
        options={Array.from({ length: 24 }, (_, hour) => ({
          value: String(hour),
          label: `${String(hour).padStart(2, '0')}:00`,
        }))}
        onChange={(hour) => onChange({ ...schedule, hour: Number(hour) })}
      />
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('workflow.scheduleHint')}
      </p>
    </fieldset>
  );
}

/** A workflow as it is edited: a new one has no ID. */
type Draft = WorkflowInput & { id: string | null };

const draftOf = (workflow: Workflow): Draft => ({
  id: workflow.id,
  name: workflow.name,
  trigger: workflow.trigger,
  extensionId: workflow.extension?.id ?? null,
  match: workflow.match,
  conditions: workflow.conditions,
  actions: workflow.actions,
  enabled: workflow.enabled,
  schedule: workflow.schedule,
});

/**
 * Workflows (DEV-11, ADR-861): the shop's own automations, as Shopify Flow's are. Each has a
 * trigger, conditions on the order or customer it is about, and actions done in turn: tags, a
 * push to the owner's and managers' phones, or an action an app offers. Made from scratch or
 * from one of the workflows a shop starts from; each one's latest runs are listed with it.
 */
export function WorkflowsPage() {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const query = useAdminQuery<{
    workflows: Workflow[];
    flowExtensions: FlowExtension[];
  }>(['workflows'], WorkflowsQuery);
  const [draft, setDraft] = useState<Draft | null>(null);

  const body = () => {
    if (query.isPending) return <Loading label={t('state.loading')} />;
    if (query.isError) {
      return (
        <ErrorState
          message={errorText(query.error, t)}
          action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
        />
      );
    }
    const { workflows, flowExtensions } = query.data;
    if (draft) {
      return (
        <WorkflowEditor
          key={draft.id ?? 'new'}
          initial={draft}
          extensions={flowExtensions}
          onDone={() => setDraft(null)}
        />
      );
    }
    return (
      <>
        {workflows.length === 0 ? (
          <p className="text-secondary">{t('workflow.none')}</p>
        ) : (
          <Card>
            <ul className="divide-y divide-line">
              {workflows.map((workflow) => (
                <li key={workflow.id}>
                  <button
                    type="button"
                    className="flex min-h-12 w-full flex-col items-start gap-1 px-4 py-3 text-start hover:bg-surface-subtle"
                    onClick={() => setDraft(draftOf(workflow))}
                  >
                    <span className="flex w-full flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium" dir="auto">
                        {workflow.name}
                      </span>
                      <span className="text-secondary">
                        {t(workflow.enabled ? 'workflow.on' : 'workflow.off')}
                      </span>
                    </span>
                    <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                      {workflow.trigger === 'APP'
                        ? workflow.extension
                          ? `${workflow.extension.appName}: ${workflow.extension.title}`
                          : t('workflow.triggerGone')
                        : t(`workflow.trigger.${workflow.trigger}` as MessageKey)}
                      {workflow.lastRunAt &&
                        ` · ${t('workflow.lastRun', {
                          date: formatDateTime(workflow.lastRunAt, timezone, locale),
                          status: t(`workflow.status.${workflow.lastRunStatus}` as MessageKey),
                        })}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        )}
        <Card className="flex flex-col gap-3 p-4">
          <h2 className="font-semibold">{t('workflow.start')}</h2>
          <div className="flex flex-wrap gap-2">
            {TEMPLATES.map((template) => (
              <Button
                key={template.id}
                variant="secondary"
                onClick={() => setDraft({ ...template.workflow, id: null })}
              >
                {t(template.label)}
              </Button>
            ))}
          </div>
          <Button
            className="self-start"
            icon={<Plus aria-hidden className="size-5" />}
            onClick={() =>
              setDraft({
                id: null,
                name: '',
                trigger: 'ORDER_CREATED',
                extensionId: null,
                match: 'ALL',
                conditions: [],
                actions: [blankAction('ADD_ORDER_TAGS')],
                enabled: true,
              })
            }
          >
            {t('workflow.new')}
          </Button>
        </Card>
      </>
    );
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <BackToSettings />
      <h1 className="flex items-center gap-2 text-[length:var(--hatti-type-display-size)] font-semibold">
        <WorkflowIcon aria-hidden className="size-7 text-secondary" />
        {t('settings.workflows')}
      </h1>
      <p className="text-secondary">{t('workflow.hint')}</p>
      {body()}
    </div>
  );
}

/**
 * Conditions on what a workflow is about, and whether all must hold or any: the workflow's own,
 * or a check's among its actions (ADR-886), whose labels name its action.
 */
function Conditions({
  fields,
  match,
  conditions,
  action,
  onChange,
}: {
  fields: FactField[];
  match: 'ALL' | 'ANY';
  conditions: WorkflowCondition[];
  /** The check's action number; none for the workflow's own conditions. */
  action?: number;
  onChange: (patch: { match?: 'ALL' | 'ANY'; conditions?: WorkflowCondition[] }) => void;
}) {
  const { t } = useLocale();
  const fieldName = (field: FactField) => field.label ?? t(fieldLabel(field.key));
  const label = (key: MessageKey, number?: number) =>
    action === undefined
      ? t(key, { number: number ?? 0 })
      : t('workflow.ofAction', { action, words: t(key, { number: number ?? 0 }) });
  const setCondition = (index: number, patch: Partial<WorkflowCondition>) =>
    onChange({
      conditions: conditions.map((each, at) => (at === index ? { ...each, ...patch } : each)),
    });
  return (
    <>
      {conditions.length === 0 && action === undefined && (
        <p className="text-secondary">{t('workflow.noConditions')}</p>
      )}
      {conditions.length > 1 && (
        <SelectField
          label={label('workflow.match')}
          value={match}
          options={[
            { value: 'ALL', label: t('workflow.matchAll') },
            { value: 'ANY', label: t('workflow.matchAny') },
          ]}
          onChange={(match) => onChange({ match })}
        />
      )}
      {conditions.map((condition, index) => {
        const field = fields.find((each) => each.key === condition.field) ?? fields[0];
        if (!field) return null;
        const number = index + 1;
        return (
          <fieldset key={index} className="flex flex-col gap-2 border-t border-line pt-3">
            <legend className="sr-only">{t('workflow.condition', { number })}</legend>
            <SelectField
              label={label('workflow.conditionField', number)}
              value={field.key}
              options={fields.map((each) => ({ value: each.key, label: fieldName(each) }))}
              onChange={(key) => {
                const next = fields.find((each) => each.key === key)!;
                setCondition(index, {
                  field: key,
                  operator: OPERATORS[next.type][0]!,
                  value: next.options?.[0] ?? (next.type === 'boolean' ? 'true' : ''),
                });
              }}
            />
            <SelectField
              label={label('workflow.conditionOperator', number)}
              value={condition.operator}
              options={OPERATORS[field.type].map((each) => ({
                value: each,
                label: t(`workflow.op.${each}` as MessageKey),
              }))}
              onChange={(operator) => setCondition(index, { operator })}
            />
            {field.type === 'choice' || field.type === 'boolean' ? (
              <SelectField
                label={label('workflow.conditionValue', number)}
                value={condition.value}
                options={(field.options ?? ['true', 'false']).map((each) => ({
                  value: each,
                  label: t(valueLabel(each)),
                }))}
                onChange={(value) => setCondition(index, { value })}
              />
            ) : (
              <TextField
                label={label('workflow.conditionValue', number)}
                inputMode={field.type === 'number' ? 'decimal' : undefined}
                value={condition.value}
                onChange={(event) => setCondition(index, { value: event.target.value })}
              />
            )}
            <Button
              variant="secondary"
              className="self-start"
              icon={<Trash2 aria-hidden className="size-5" />}
              onClick={() => onChange({ conditions: conditions.filter((_, at) => at !== index) })}
            >
              {label('workflow.removeCondition', number)}
            </Button>
          </fieldset>
        );
      })}
      {fields.length > 0 && (
        <Button
          variant="secondary"
          className="self-start"
          icon={<Plus aria-hidden className="size-5" />}
          onClick={() =>
            onChange({
              conditions: [
                ...conditions,
                {
                  field: fields[0]!.key,
                  operator: OPERATORS[fields[0]!.type][0]!,
                  value: fields[0]!.options?.[0] ?? '',
                },
              ],
            })
          }
        >
          {label('workflow.addCondition')}
        </Button>
      )}
    </>
  );
}

function WorkflowEditor({
  initial,
  extensions,
  onDone,
}: {
  initial: Draft;
  extensions: FlowExtension[];
  onDone: () => void;
}) {
  const { t } = useLocale();
  const [draft, setDraft] = useState<Draft>(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = useAdminMutation<WorkflowPayloadData, { input: WorkflowInput }>(
    WorkflowCreateMutation,
  );
  const update = useAdminMutation<WorkflowPayloadData, { id: string; input: WorkflowInput }>(
    WorkflowUpdateMutation,
  );
  const remove = useAdminMutation<WorkflowDeleteData, { id: string }>(WorkflowDeleteMutation);
  const triggers = extensions.filter((each) => each.kind === 'TRIGGER');
  const appActions = extensions.filter((each) => each.kind === 'ACTION');
  const extension = triggers.find((each) => each.id === draft.extensionId) ?? null;
  const fields = fieldsOf(draft.trigger, extension);
  const actionTypes: WorkflowActionType[] = [
    ...actionsOf(draft.trigger, extension),
    ...(appActions.length > 0 ? (['APP_ACTION'] as const) : []),
  ];
  const change = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const setAction = (index: number, patch: Partial<WorkflowAction>) =>
    change({
      actions: draft.actions.map((each, at) => (at === index ? { ...each, ...patch } : each)),
    });

  const show = (errors: UserError[]) => {
    if (errors[0]) setProblem(problemText(errors[0], t));
    return errors.length === 0;
  };

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setBusy(true);
    const { id, ...input } = draft;
    try {
      const done = id
        ? (await update.mutateAsync({ id, input })).workflowUpdate!
        : (await create.mutateAsync({ input })).workflowCreate!;
      if (show(done.userErrors)) onDone();
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
    setBusy(false);
  };

  const onDelete = async () => {
    if (!draft.id) return;
    try {
      if (show((await remove.mutateAsync({ id: draft.id })).workflowDelete.userErrors)) onDone();
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  const triggerOptions = TRIGGERS.flatMap((trigger) =>
    trigger === 'APP'
      ? triggers.map((each) => ({
          value: `APP:${each.id}`,
          label: `${each.appName}: ${each.title}`,
        }))
      : [{ value: trigger, label: t(`workflow.trigger.${trigger}` as MessageKey) }],
  );

  return (
    <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-4">
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Card className="flex flex-col gap-3 p-4">
        <TextField
          label={t('workflow.name')}
          value={draft.name}
          onChange={(event) => change({ name: event.target.value })}
          required
        />
        <SelectField
          label={t('workflow.when')}
          value={draft.trigger === 'APP' ? `APP:${draft.extensionId}` : draft.trigger}
          options={triggerOptions}
          onChange={(value) => {
            const [trigger, extensionId] = value.split(':') as [WorkflowTriggerType, string?];
            change({
              trigger,
              extensionId: extensionId ?? null,
              conditions: [],
              // Every day at nine, to start from (ADR-906).
              schedule: trigger === 'SCHEDULED' ? (draft.schedule ?? DEFAULT_SCHEDULE) : null,
            });
          }}
        />
        {draft.trigger === 'SCHEDULED' && draft.schedule && (
          <ScheduleFields schedule={draft.schedule} onChange={(schedule) => change({ schedule })} />
        )}
        <CheckField
          label={t('workflow.enabled')}
          checked={draft.enabled}
          onChange={(enabled) => change({ enabled })}
        />
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <h2 className="font-semibold">{t('workflow.conditions')}</h2>
        <Conditions
          fields={fields}
          match={draft.match}
          conditions={draft.conditions}
          onChange={(patch) => change(patch)}
        />
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <h2 className="font-semibold">{t('workflow.actions')}</h2>
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('workflow.placeholders')}
        </p>
        {draft.actions.map((action, index) => {
          const number = index + 1;
          const appAction = appActions.find((each) => each.id === action.extensionId);
          const propertyOf = (key: string) =>
            action.properties.find((each) => each.key === key)?.value ?? '';
          return (
            <fieldset key={index} className="flex flex-col gap-2 border-t border-line pt-3">
              <legend className="sr-only">{t('workflow.action', { number })}</legend>
              <SelectField
                label={t('workflow.actionType', { number })}
                value={
                  action.type === 'APP_ACTION' ? `APP_ACTION:${action.extensionId}` : action.type
                }
                options={actionTypes.flatMap((type) =>
                  type === 'APP_ACTION'
                    ? appActions.map((each) => ({
                        value: `APP_ACTION:${each.id}`,
                        label: `${each.appName}: ${each.title}`,
                      }))
                    : [{ value: type, label: t(`workflow.action.${type}` as MessageKey) }],
                )}
                onChange={(value) => {
                  const [type, extensionId] = value.split(':') as [WorkflowActionType, string?];
                  setAction(index, { ...blankAction(type), extensionId: extensionId ?? null });
                }}
              />
              {action.type.endsWith('_TAGS') && (
                <TextField
                  label={t('workflow.tags', { number })}
                  hint={t('workflow.tagsHint')}
                  value={action.tags.join(', ')}
                  onChange={(event) =>
                    setAction(index, {
                      tags: event.target.value.split(',').map((each) => each.trimStart()),
                    })
                  }
                />
              )}
              {action.type === 'HOLD_ORDER' && (
                <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                  {t('workflow.holdHint')}
                </p>
              )}
              {action.type === 'NOTIFY_STAFF' && (
                <>
                  <TextField
                    label={t('workflow.pushTitle', { number })}
                    value={action.title ?? ''}
                    onChange={(event) => setAction(index, { title: event.target.value })}
                  />
                  <TextField
                    label={t('workflow.pushMessage', { number })}
                    hint={t('workflow.pushHint')}
                    value={action.message ?? ''}
                    onChange={(event) => setAction(index, { message: event.target.value })}
                  />
                </>
              )}
              {action.type === 'WAIT' && (
                <TextField
                  label={t('workflow.hours', { number })}
                  hint={t('workflow.hoursHint')}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={168}
                  value={action.hours ?? ''}
                  onChange={(event) =>
                    setAction(index, {
                      hours: event.target.value === '' ? null : Number(event.target.value),
                    })
                  }
                />
              )}
              {action.type === 'CONTINUE_IF' && (
                <>
                  <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                    {t('workflow.checkHint')}
                  </p>
                  <Conditions
                    fields={fields}
                    match={action.match ?? 'ALL'}
                    conditions={action.conditions}
                    action={number}
                    onChange={(patch) => setAction(index, patch)}
                  />
                </>
              )}
              {appAction?.fields.map((field) => (
                <TextField
                  key={field.key}
                  label={field.label}
                  value={propertyOf(field.key)}
                  required={field.required}
                  onChange={(event) =>
                    setAction(index, {
                      properties: [
                        ...action.properties.filter((each) => each.key !== field.key),
                        { key: field.key, value: event.target.value },
                      ],
                    })
                  }
                />
              ))}
              {draft.actions.length > 1 && (
                <Button
                  variant="secondary"
                  className="self-start"
                  icon={<Trash2 aria-hidden className="size-5" />}
                  onClick={() => change({ actions: draft.actions.filter((_, at) => at !== index) })}
                >
                  {t('workflow.removeAction', { number })}
                </Button>
              )}
            </fieldset>
          );
        })}
        {draft.actions.length < MOST_ACTIONS && (
          <Button
            variant="secondary"
            className="self-start"
            icon={<Plus aria-hidden className="size-5" />}
            onClick={() => change({ actions: [...draft.actions, blankAction('NOTIFY_STAFF')] })}
          >
            {t('workflow.addAction')}
          </Button>
        )}
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={busy}>
          {t('workflow.save')}
        </Button>
        <Button variant="secondary" onClick={onDone}>
          {t('action.back')}
        </Button>
        {draft.id && (
          <Button
            variant="danger"
            icon={<Trash2 aria-hidden className="size-5" />}
            onClick={() => void onDelete()}
          >
            {t('workflow.delete')}
          </Button>
        )}
      </div>
      {draft.id && <WorkflowRuns workflowId={draft.id} />}
    </form>
  );
}

/** A workflow's latest runs, each action's outcome with it. */
function WorkflowRuns({ workflowId }: { workflowId: string }) {
  const { t, locale } = useLocale();
  const timezone = useShopTimezone();
  const shop = useShop();
  const query = useAdminQuery<WorkflowRunsData>(['workflowRuns', workflowId], WorkflowRunsQuery, {
    workflowId,
  });
  const runs = query.data?.workflowRuns ?? [];
  return (
    <Card className="flex flex-col gap-2 p-4">
      <h2 className="font-semibold">{t('workflow.runs')}</h2>
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : runs.length === 0 ? (
        <p className="text-secondary">{t('workflow.noRuns')}</p>
      ) : (
        <ul className="divide-y divide-line">
          {runs.map((run) => (
            <li key={run.id} className="flex flex-col gap-1 py-2">
              <span className="flex flex-wrap justify-between gap-2">
                <span>{formatDateTime(run.createdAt, timezone, locale)}</span>
                <span className="font-medium">
                  {t(`workflow.status.${run.status}` as MessageKey)}
                </span>
              </span>
              {run.orderId && (
                <Link
                  to="/$shopId/orders/$orderId"
                  params={{ shopId: shop.id, orderId: run.orderId }}
                  className="self-start text-text underline"
                >
                  {t('workflow.openOrder')}
                </Link>
              )}
              {run.steps.map((step, index) => (
                <span
                  key={index}
                  className="text-secondary text-[length:var(--hatti-type-body-sm-size)]"
                >
                  {t('workflow.step', {
                    action: t(`workflow.action.${step.action}` as MessageKey),
                    outcome: t(`workflow.outcome.${step.outcome}` as MessageKey),
                  })}
                  {step.detail && ` (${step.detail})`}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
