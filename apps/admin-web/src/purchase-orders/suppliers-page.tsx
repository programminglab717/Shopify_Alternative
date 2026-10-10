import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { SupplierCreateMutation, SupplierUpdateMutation, SuppliersQuery } from '../api/operations';
import type { Supplier, SuppliersData, UserError } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatPhone } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { useAttempt } from '../returns/parcel';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { EDITS_STOCK } from '../stock/stock-page';
import { Button } from '../ui/button';
import { Alert, Card, EmptyState, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

type Mutated = Record<string, { userErrors: UserError[] }>;

/** A supplier's name, number and note, to add one or change it. */
function SupplierForm({ supplier, onDone }: { supplier: Supplier | null; onDone: () => void }) {
  const { t } = useLocale();
  const create = useAdminMutation<Mutated, { input: Record<string, unknown> }>(
    SupplierCreateMutation,
  );
  const update = useAdminMutation<Mutated, { id: string; input: Record<string, unknown> }>(
    SupplierUpdateMutation,
  );
  const { problem, attempt } = useAttempt();
  const [name, setName] = useState(supplier?.name ?? '');
  const [phone, setPhone] = useState(supplier?.phone ? formatPhone(supplier.phone) : '');
  const [note, setNote] = useState(supplier?.note ?? '');

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const input = { name, phone: phone.trim() || null, note: note.trim() || null };
    const ok = await attempt(
      async () =>
        Object.values(
          supplier
            ? await update.mutateAsync({ id: supplier.id, input })
            : await create.mutateAsync({ input }),
        )[0]!,
    );
    if (ok) onDone();
  };

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
      <TextField
        label={t('po.supplierName')}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <TextField
        label={t('po.supplierPhone')}
        inputMode="tel"
        ltr
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
      />
      <TextField
        label={t('po.supplierNote')}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />
      {problem && <Alert tone="danger">{problem}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={create.isPending || update.isPending} disabled={!name.trim()}>
          {t(supplier ? 'po.supplierSave' : 'po.supplierAdd')}
        </Button>
        <Button variant="tertiary" onClick={onDone}>
          {t('returns.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** The shop's suppliers (INV-05): each with its number and note, changed in place, and its orders. */
export function SuppliersPage() {
  const { t } = useLocale();
  const { id: shopId, role } = useShop();
  const query = useAdminQuery<SuppliersData>(['suppliers'], SuppliersQuery);
  const [editing, setEditing] = useState<string | null>(null);
  const edits = EDITS_STOCK.includes(role);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Link
        to="/$shopId/purchase-orders"
        params={{ shopId }}
        className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
      >
        <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
        {t('po.title')}
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
          {t('po.suppliers')}
        </h1>
        {edits && editing === null && (
          <Button onClick={() => setEditing('+new')}>{t('po.supplierNew')}</Button>
        )}
      </div>
      {editing === '+new' && (
        <Card className="p-4">
          <SupplierForm supplier={null} onDone={() => setEditing(null)} />
        </Card>
      )}
      {query.isPending ? (
        <Loading label={t('state.loading')} />
      ) : query.isError ? (
        <ErrorState message={errorText(query.error, t)} />
      ) : query.data.suppliers.length === 0 ? (
        <EmptyState title={t('po.noSuppliers')} />
      ) : (
        <Card>
          <ul className="flex flex-col divide-y divide-line">
            {query.data.suppliers.map((supplier) => (
              <li key={supplier.id} className="flex flex-col gap-2 p-4">
                {editing === supplier.id ? (
                  <SupplierForm supplier={supplier} onDone={() => setEditing(null)} />
                ) : (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex min-w-0 flex-col">
                        <span className="font-medium" dir="auto">
                          {supplier.name}
                        </span>
                        {supplier.phone && (
                          <span className="text-secondary" dir="ltr">
                            {formatPhone(supplier.phone)}
                          </span>
                        )}
                        {supplier.note && (
                          <span className="text-secondary" dir="auto">
                            {supplier.note}
                          </span>
                        )}
                      </span>
                      <span className="flex flex-wrap gap-2">
                        <Link
                          to="/$shopId/purchase-orders"
                          params={{ shopId }}
                          search={{ supplier: supplier.id }}
                          aria-label={t('po.ordersFrom', { name: supplier.name })}
                          className="inline-flex min-h-10 items-center px-2 font-medium text-primary hover:underline"
                        >
                          {t('po.orders')}
                        </Link>
                        {edits && editing === null && (
                          <Button
                            variant="tertiary"
                            aria-label={t('po.supplierChange', { name: supplier.name })}
                            onClick={() => setEditing(supplier.id)}
                          >
                            {t('po.change')}
                          </Button>
                        )}
                      </span>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
