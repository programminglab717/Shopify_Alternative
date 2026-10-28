import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { consoleCall, errorText } from './api';
import { DecisionForm, REASONS, ShowAll } from './decide';
import type { StoreReport } from './types';
import { Alert, Card, when } from './ui';

/** Shoppers' reports of stores (ADR-460), each due a decision within 48 hours. */
export function ReportsPage() {
  const [all, setAll] = useState(false);
  const reports = useQuery({
    queryKey: ['reports', all],
    queryFn: () => consoleCall<{ reports: StoreReport[] }>(`/reports${all ? '?all=1' : ''}`),
  });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Reports</h1>
        <ShowAll all={all} onChange={setAll} />
      </div>
      {reports.isPending ? (
        <p>Loading…</p>
      ) : reports.isError ? (
        <Alert tone="danger">{errorText(reports.error)}</Alert>
      ) : reports.data.reports.length === 0 ? (
        <p className="text-secondary">{all ? 'No report yet.' : 'No report is open.'}</p>
      ) : (
        reports.data.reports.map((report) => (
          <Card key={report.id} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-semibold">
                {report.shop.name} <span className="text-secondary">({report.shop.handle})</span>
              </h2>
              <span className={report.overdue ? 'font-semibold text-danger' : 'text-secondary'}>
                {report.status !== 'open'
                  ? `${report.status} by ${report.decidedBy ?? '?'}`
                  : report.overdue
                    ? `Overdue: was due ${when(report.dueAt)}`
                    : `Due ${when(report.dueAt)}`}
              </span>
            </div>
            <p className="font-medium">
              {REASONS[report.reason] ?? report.reason}
              {report.openOfShop > 1 && ` · ${report.openOfShop} reports of this store are open`}
            </p>
            <p lang={report.language} className="whitespace-pre-wrap">
              {report.details}
            </p>
            <p className="text-secondary">
              {[
                report.orderName && `Order ${report.orderName}`,
                report.phone && `Reach them on ${report.phone}`,
                report.pageUrl,
                `reported ${when(report.createdAt)}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {report.status === 'open' ? (
              <>
                <DecisionForm
                  label="What was done, or why not"
                  name="note"
                  actions={[
                    {
                      label: 'Uphold',
                      path: `/reports/${report.id}/decide`,
                      extra: { status: 'upheld' },
                      refresh: [['reports']],
                      done: 'Upheld.',
                    },
                    {
                      label: 'Dismiss',
                      path: `/reports/${report.id}/decide`,
                      extra: { status: 'dismissed' },
                      refresh: [['reports']],
                      done: 'Dismissed.',
                      variant: 'secondary',
                    },
                  ]}
                />
                <Link
                  to="/stores"
                  search={{ shop: report.shop.handle, reason: report.reason }}
                  className="self-start text-danger underline"
                >
                  Take {report.shop.name} down
                </Link>
              </>
            ) : (
              report.decision && <p>{report.decision}</p>
            )}
          </Card>
        ))
      )}
    </div>
  );
}
