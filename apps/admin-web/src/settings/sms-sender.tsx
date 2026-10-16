import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  SmsSenderQuery,
  SmsSenderRequestMutation,
  SmsSenderWithdrawMutation,
} from '../api/operations';
import type { SmsSenderData, SmsSenderRequestData, SmsSenderWithdrawData } from '../api/types';
import { errorText } from '../i18n/errors';
import { formatDate } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection, problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop, useShopTimezone } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';

/** A name as operators register it (ADR-469): 3 to 11 letters, digits and spaces, a letter too. */
export function senderNameOf(value: string): string | null {
  const name = value.trim().replace(/\s+/g, ' ');
  return name.length >= 3 &&
    name.length <= 11 &&
    /^[A-Za-z0-9 ]+$/.test(name) &&
    /[A-Za-z]/.test(name)
    ? name
    : null;
}

/**
 * The name the shop's SMS to its customers go from (MKT-02, ADR-469): Hatti's shared one until
 * Hatti's people approve one of its own; the request waiting, which it may withdraw; why the last
 * was refused or taken back; and the form to ask, for owners and managers.
 */
export function SmsSenderCard() {
  const { t, locale } = useLocale();
  const { role } = useShop();
  const timezone = useShopTimezone();
  const query = useAdminQuery<SmsSenderData>(['smsSender'], SmsSenderQuery);
  const ask = useAdminMutation<SmsSenderRequestData, { name: string }>(SmsSenderRequestMutation);
  const withdraw = useAdminMutation<SmsSenderWithdrawData, Record<string, never>>(
    SmsSenderWithdrawMutation,
  );
  const [typed, setTyped] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const mayAsk = role === 'owner' || role === 'manager';

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
    const { name, requests } = query.data.smsSender;
    const waiting = requests.find((request) => request.status === 'WAITING');
    const last = requests.find((request) => request.status !== 'WITHDRAWN');
    const valid = senderNameOf(typed) !== null;
    const onSubmit = async (event: FormEvent) => {
      event.preventDefault();
      if (!valid) return;
      setProblems([]);
      try {
        const { smsSenderRequest } = await ask.mutateAsync({ name: typed });
        if (smsSenderRequest.userErrors.length > 0) {
          setProblems(smsSenderRequest.userErrors.map((each) => problemText(each, t)));
        } else {
          setTyped('');
        }
      } catch (failure) {
        setProblems([errorText(failure, t)]);
      }
    };
    body = (
      <>
        <p className="font-semibold" dir="auto">
          {name ? t('smsSender.own', { name }) : t('smsSender.shared')}
        </p>
        {waiting ? (
          <Alert tone="info">
            <span className="flex flex-wrap items-center justify-between gap-2">
              {t('smsSender.waiting', {
                name: waiting.name,
                date: formatDate(waiting.createdAt, timezone, locale),
              })}
              {mayAsk && (
                <Button
                  variant="secondary"
                  busy={withdraw.isPending}
                  onClick={() => void withdraw.mutateAsync({})}
                >
                  {t('smsSender.withdraw')}
                </Button>
              )}
            </span>
          </Alert>
        ) : (
          last &&
          (last.status === 'REFUSED' || last.status === 'REVOKED') && (
            <Alert tone="warning">
              {t(`smsSender.${last.status}` as MessageKey, {
                name: last.name,
                answer: last.answer ?? '',
              })}
            </Alert>
          )
        )}
        {!waiting &&
          (mayAsk ? (
            <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3">
              <TextField
                label={t('smsSender.name')}
                hint={t(
                  typed.trim() === '' || valid ? 'smsSender.nameHint' : 'smsSender.nameInvalid',
                )}
                ltr
                maxLength={11}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
              {problems.length > 0 && <Alert tone="danger">{problems.join(' ')}</Alert>}
              <Button type="submit" className="self-start" busy={ask.isPending} disabled={!valid}>
                {t('smsSender.ask')}
              </Button>
            </form>
          ) : (
            <p className="text-secondary">{t('smsSender.ownersOnly')}</p>
          ))}
      </>
    );
  }
  return (
    <FormSection title={t('smsSender.title')} hint={t('smsSender.hint')}>
      {body}
    </FormSection>
  );
}
