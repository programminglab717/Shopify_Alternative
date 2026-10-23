/** Customers in cohorts by the month of their first order, and who came back (ANL-04, ADR-775). */
import { CustomerCohortsQuery } from '../api/operations';
import type { CustomerCohortsData } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatCount, formatMonth } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Card, ErrorState, Loading } from '../ui/feedback';

/** How many cohorts the table shows, this month's the last. */
const MONTHS = 12;

/** How many months after the first order it has columns for. */
const AFTER = 6;

/** `count` of `of` as a whole percentage: "25%"; a dash of none. */
function share(count: number, of: number): string {
  return of === 0 ? '–' : `${Math.round((count / of) * 100)}%`;
}

/**
 * Retention as a table (ADR-774): a row for each month's new customers, newest last, and in each
 * month after, the share of them who ordered again; blank where that month has not come yet.
 */
export function Cohorts() {
  const { t, locale } = useLocale();
  const query = useAdminQuery<CustomerCohortsData>(['customerCohorts'], CustomerCohortsQuery, {
    months: MONTHS,
  });

  let body;
  if (query.isPending) body = <Loading label={t('state.loading')} />;
  else if (query.isError) {
    body = (
      <ErrorState
        message={errorText(query.error, t)}
        action={<Button onClick={() => void query.refetch()}>{t('action.retry')}</Button>}
      />
    );
  } else {
    // Absent where an older core, or a fake one, leaves it out.
    const cohorts = query.data.customerCohorts ?? [];
    body = cohorts.every((cohort) => cohort.customers === 0) ? (
      <Card>
        <p className="p-4 text-secondary">{t('cohorts.none')}</p>
      </Card>
    ) : (
      <Card className="overflow-x-auto">
        <table className="w-full text-[length:var(--hatti-type-body-sm-size)]">
          <thead>
            <tr className="border-b border-line text-start text-secondary">
              <th scope="col" className="p-2 text-start font-medium">
                {t('cohorts.month')}
              </th>
              <th scope="col" className="p-2 text-end font-medium">
                {t('cohorts.customers')}
              </th>
              {Array.from({ length: AFTER }, (_, index) => (
                <th key={index} scope="col" className="p-2 text-end font-medium">
                  {t('cohorts.after', { n: index + 1 })}
                </th>
              ))}
              <th scope="col" className="p-2 text-end font-medium">
                {t('cohorts.again')}
              </th>
            </tr>
          </thead>
          <tbody>
            {cohorts.map((cohort) => (
              <tr key={cohort.month} className="border-b border-line last:border-0">
                <th scope="row" className="p-2 text-start font-medium whitespace-nowrap">
                  {formatMonth(cohort.month, locale)}
                </th>
                <td className="num p-2 text-end">{formatCount(cohort.customers)}</td>
                {Array.from({ length: AFTER }, (_, index) => (
                  <td key={index} className="num p-2 text-end text-secondary">
                    {index < cohort.returned.length
                      ? share(cohort.returned[index]!, cohort.customers)
                      : ''}
                  </td>
                ))}
                <td className="num p-2 text-end font-medium">
                  {share(cohort.orderedAgain, cohort.customers)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    );
  }

  return (
    <section aria-labelledby="analytics-cohorts" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="analytics-cohorts" className="font-semibold">
          {t('cohorts.title')}
        </h2>
        <p className="text-secondary">{t('cohorts.hint')}</p>
      </div>
      {body}
    </section>
  );
}
