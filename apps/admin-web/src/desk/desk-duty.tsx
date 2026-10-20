import { useState } from 'react';
import {
  ConfirmationDeskDutyEndMutation,
  ConfirmationDeskDutyQuery,
  ConfirmationDeskDutyStartMutation,
} from '../api/operations';
import type {
  ConfirmationDeskDutyData,
  ConfirmationDeskDutyEndData,
  ConfirmationDeskDutyStartData,
} from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount, formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, Card } from '../ui/feedback';

/** How long a shift may be, in hours (ADR-654). */
const SHIFTS = ['4', '8', '12'] as const;

/**
 * Who is on duty at the desk, and the caller going on or off it (ADR-654): where the shop shares
 * new orders out, each one that needs a call goes to whoever on duty has the fewest waiting.
 */
export function DeskDutyCard({ timezone }: { timezone: string }) {
  const { t, locale } = useLocale();
  const duty = useAdminQuery<ConfirmationDeskDutyData>(
    ['confirmationDeskDuty'],
    ConfirmationDeskDutyQuery,
  );
  const start = useAdminMutation<ConfirmationDeskDutyStartData, { hours: number }>(
    ConfirmationDeskDutyStartMutation,
  );
  const end = useAdminMutation<ConfirmationDeskDutyEndData, { handOver?: boolean }>(
    ConfirmationDeskDutyEndMutation,
  );
  const [hours, setHours] = useState<(typeof SHIFTS)[number]>('8');
  const [problem, setProblem] = useState<string | null>(null);
  const [handedOver, setHandedOver] = useState(0);

  if (!duty.data) return null;
  const onDuty = duty.data.confirmationDeskDuty;
  const you = onDuty.find((each) => each.isYou);
  // Whoever else is on duty takes what still waits on the caller, if they ask (ADR-656).
  const canHandOver = you !== undefined && you.waiting > 0 && onDuty.length > 1;

  const act = async (run: () => Promise<{ userErrors: { message: string }[] }>) => {
    setProblem(null);
    setHandedOver(0);
    try {
      const { userErrors } = await run();
      if (userErrors.length > 0) setProblem(userErrors.map((error) => error.message).join(' '));
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <section aria-labelledby="desk-duty" className="flex flex-col gap-2">
      <h2 id="desk-duty" className="font-semibold">
        {t('desk.duty.title')}
      </h2>
      <Card>
        <div className="flex flex-col gap-3 p-4">
          {onDuty.length === 0 ? (
            <p className="text-secondary">{t('desk.duty.none')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {onDuty.map((each) => (
                <li key={each.staffMemberId}>
                  {t(each.isYou ? 'desk.duty.you' : 'desk.duty.someone', {
                    name: each.name,
                    waiting: formatCount(each.waiting),
                    time: formatDateTime(each.endsAt, timezone, locale),
                  })}
                </li>
              ))}
            </ul>
          )}
          {problem && <Alert tone="danger">{problem}</Alert>}
          {handedOver > 0 && (
            <Alert tone="success">
              {t('desk.duty.handedOver', { count: formatCount(handedOver) })}
            </Alert>
          )}
          {you ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                busy={end.isPending && !end.variables?.handOver}
                disabled={end.isPending}
                onClick={() =>
                  void act(async () => (await end.mutateAsync({})).confirmationDeskDutyEnd)
                }
              >
                {t('desk.duty.end')}
              </Button>
              {canHandOver && (
                <Button
                  variant="secondary"
                  busy={end.isPending && end.variables?.handOver === true}
                  disabled={end.isPending}
                  onClick={() =>
                    void act(async () => {
                      const ended = (await end.mutateAsync({ handOver: true }))
                        .confirmationDeskDutyEnd;
                      setHandedOver(ended.handedOver);
                      return ended;
                    })
                  }
                >
                  {t('desk.duty.handOver', { count: formatCount(you.waiting) })}
                </Button>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <SelectField<(typeof SHIFTS)[number]>
                label={t('desk.duty.hours')}
                value={hours}
                options={SHIFTS.map((each) => ({
                  value: each,
                  label: t('desk.duty.hoursOption', { hours: each }),
                }))}
                onChange={setHours}
              />
              <Button
                busy={start.isPending}
                onClick={() =>
                  void act(
                    async () =>
                      (await start.mutateAsync({ hours: Number(hours) })).confirmationDeskDutyStart,
                  )
                }
              >
                {t('desk.duty.start')}
              </Button>
            </div>
          )}
        </div>
      </Card>
    </section>
  );
}
