import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, UserPlus } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { CustomerCreateMutation } from '../api/operations';
import type { CustomerCreateData, MarketingChannel } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection, parseTags, TextArea } from '../products/product-form';
import { CheckField, parseList, Problems, settingProblem } from '../settings/settings-form';
import { useAdminMutation, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { TextField } from '../ui/field';
import { CHANNELS } from './care';

const LABELS: Partial<Record<string, MessageKey>> = {
  phone: 'newCustomer.phone',
  otherPhones: 'newCustomer.otherPhones',
  name: 'newCustomer.name',
  email: 'newCustomer.email',
  note: 'newCustomer.note',
  tags: 'newCustomer.tags',
  wording: 'care.wording',
};

/**
 * A customer added by hand (CUS-01), before they order: their mobile, which orders find them by,
 * other numbers, name, email, a note and tags, and the marketing they agreed to, in their words.
 */
export function NewCustomerPage() {
  const { t } = useLocale();
  const shop = useShop();
  const navigate = useNavigate();
  const create = useAdminMutation<CustomerCreateData, { input: Record<string, unknown> }>(
    CustomerCreateMutation,
  );
  const [phone, setPhone] = useState('');
  const [otherPhones, setOtherPhones] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [agreed, setAgreed] = useState<MarketingChannel[]>([]);
  const [wording, setWording] = useState('');
  const [problems, setProblems] = useState<string[]>([]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (agreed.length > 0 && !wording.trim()) {
      setProblems([t('care.wordingNeeded')]);
      return;
    }
    setProblems([]);
    try {
      const { customerCreate } = await create.mutateAsync({
        input: {
          phone: phone.trim(),
          ...(parseList(otherPhones).length > 0 && { otherPhones: parseList(otherPhones) }),
          ...(name.trim() && { name: name.trim() }),
          ...(email.trim() && { email: email.trim() }),
          ...(note.trim() && { note: note.trim() }),
          ...(parseTags(tags).length > 0 && { tags: parseTags(tags) }),
          ...(agreed.length > 0 && {
            marketingConsent: agreed.map((channel) => ({
              channel,
              marketingState: 'SUBSCRIBED',
              wording: wording.trim(),
            })),
          }),
        },
      });
      const created = customerCreate.customer;
      if (customerCreate.userErrors.length > 0 || !created) {
        setProblems(
          customerCreate.userErrors.map((error) => settingProblem(error, t, LABELS, () => null)),
        );
        return;
      }
      await navigate({
        to: '/$shopId/customers/$customerId',
        params: { shopId: shop.id, customerId: created.id },
      });
    } catch (failure) {
      setProblems([errorText(failure, t)]);
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <Link
        to="/$shopId/customers"
        params={{ shopId: shop.id }}
        className="inline-flex min-h-10 items-center gap-1 self-start text-secondary hover:text-text"
      >
        <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />
        {t('customers.title')}
      </Link>
      <h1 className="text-[length:var(--hatti-type-display-size)] font-semibold">
        {t('newCustomer.title')}
      </h1>
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
        <FormSection title={t('newCustomer.who')}>
          <TextField
            label={t('newCustomer.phone')}
            hint={t('newCustomer.phoneHint')}
            type="tel"
            inputMode="tel"
            placeholder="0300 1234567"
            autoComplete="off"
            required
            ltr
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
          <TextField
            label={t('newCustomer.otherPhones')}
            hint={t('newCustomer.otherPhonesHint')}
            inputMode="tel"
            autoComplete="off"
            ltr
            value={otherPhones}
            onChange={(event) => setOtherPhones(event.target.value)}
          />
          <TextField
            label={t('newCustomer.name')}
            dir="auto"
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <TextField
            label={t('newCustomer.email')}
            type="email"
            autoComplete="off"
            ltr
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </FormSection>
        <FormSection title={t('newCustomer.notes')}>
          <TextArea label={t('newCustomer.note')} value={note} onChange={setNote} />
          <TextField
            label={t('newCustomer.tags')}
            hint={t('newCustomer.tagsHint')}
            dir="auto"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
          />
        </FormSection>
        <FormSection title={t('care.consent')} hint={t('care.consentHint')}>
          {CHANNELS.map((channel) => (
            <CheckField
              key={channel}
              label={t(`care.channel.${channel}` as MessageKey)}
              checked={agreed.includes(channel)}
              onChange={(on) =>
                setAgreed((all) =>
                  on ? [...all, channel] : all.filter((each) => each !== channel),
                )
              }
            />
          ))}
          {agreed.length > 0 && (
            <TextField
              label={t('care.wording')}
              hint={t('care.wordingHint')}
              dir="auto"
              value={wording}
              onChange={(event) => setWording(event.target.value)}
            />
          )}
        </FormSection>
        <Problems problems={problems} />
        <Button
          type="submit"
          className="self-start"
          busy={create.isPending}
          icon={<UserPlus aria-hidden className="size-5" />}
        >
          {t('newCustomer.add')}
        </Button>
      </form>
    </div>
  );
}
