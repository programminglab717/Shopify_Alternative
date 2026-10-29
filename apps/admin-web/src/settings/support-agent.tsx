import { Plus, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  SupportAgentFaqsSetMutation,
  SupportAgentQuery,
  SupportAgentUpdateMutation,
  SupportAgentVoiceSetMutation,
} from '../api/operations';
import type {
  SupportAgentData,
  SupportAgentFaqsSetData,
  SupportAgentUpdateData,
  SupportAgentValue,
  SupportAgentVoiceSetData,
  SupportFaqValue,
} from '../api/types';
import { permits } from '../auth/permissions';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { FormSection, TextArea, problemText } from '../products/product-form';
import { useAdminMutation, useAdminQuery, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert, ErrorState, Loading } from '../ui/feedback';
import { TextField } from '../ui/field';
import { CheckField, SelectField } from './settings-form';
import { SETS_SETTINGS } from './settings-page';

/**
 * The AI answering the shop's customers (MSG-07, ADR-849), on WhatsApp and in its web chat: on or
 * off, for owners and managers, with how many it answered today. It answers from the shop's
 * policies and the customer's own orders, and leaves a conversation to staff once they take it.
 */
export function SupportAgentCard() {
  const { t } = useLocale();
  const shop = useShop();
  const query = useAdminQuery<SupportAgentData>(['supportAgent'], SupportAgentQuery);
  const update = useAdminMutation<SupportAgentUpdateData, { enabled: boolean }>(
    SupportAgentUpdateMutation,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const may = permits(shop, SETS_SETTINGS);

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
    const agent = query.data.supportAgent;
    const onChange = async (enabled: boolean) => {
      setProblem(null);
      try {
        const { supportAgentUpdate } = await update.mutateAsync({ enabled });
        const error = supportAgentUpdate.userErrors[0];
        if (error) setProblem(problemText(error, t));
      } catch (failure) {
        setProblem(errorText(failure, t));
      }
    };
    body = !agent.available ? (
      <p className="text-secondary">{t('supportAgent.unavailable')}</p>
    ) : (
      <div className="flex flex-col gap-3">
        <CheckField
          label={t('supportAgent.on')}
          checked={agent.enabled}
          onChange={(enabled) => may && !update.isPending && void onChange(enabled)}
        />
        <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
          {t('supportAgent.how')}
        </p>
        {agent.enabled && (
          <p className="num text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            {t('supportAgent.today', { count: agent.answeredToday, limit: agent.limitPerDay })}
          </p>
        )}
        {problem && <Alert tone="danger">{problem}</Alert>}
        <VoiceForm saved={agent} may={may} />
        <FaqsForm saved={agent.faqs} may={may} />
      </div>
    );
  }
  return (
    <FormSection title={t('supportAgent.title')} hint={t('supportAgent.hint')}>
      {body}
    </FormSection>
  );
}

/** The name the shop gives its assistant, and whether it writes warmly or formally (ADR-923). */
function VoiceForm({ saved, may }: { saved: SupportAgentValue; may: boolean }) {
  const { t } = useLocale();
  const save = useAdminMutation<
    SupportAgentVoiceSetData,
    { name: string | null; tone: SupportAgentValue['tone'] }
  >(SupportAgentVoiceSetMutation);
  const [name, setName] = useState(saved.name ?? '');
  const [tone, setTone] = useState(saved.tone);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setDone(false);
    try {
      const { supportAgentVoiceSet } = await save.mutateAsync({ name: name.trim() || null, tone });
      const error = supportAgentVoiceSet.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else setDone(true);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <form className="flex flex-col gap-3 border-t border-line pt-3" onSubmit={onSubmit}>
      <h3 className="font-medium">{t('supportAgent.voice')}</h3>
      <fieldset className="flex flex-col gap-3" disabled={!may}>
        <TextField
          label={t('supportAgent.name')}
          hint={t('supportAgent.nameHint')}
          value={name}
          maxLength={40}
          dir="auto"
          onChange={(event) => {
            setDone(false);
            setName(event.target.value);
          }}
        />
        <SelectField
          label={t('supportAgent.tone')}
          value={tone}
          options={[
            { value: 'warm', label: t('supportAgent.tone.warm') },
            { value: 'formal', label: t('supportAgent.tone.formal') },
          ]}
          onChange={(next) => {
            setDone(false);
            setTone(next);
          }}
        />
      </fieldset>
      {may && (
        <div>
          <Button
            type="submit"
            busy={save.isPending}
            icon={<Save aria-hidden className="size-5" />}
          >
            {t('supportAgent.saveVoice')}
          </Button>
        </div>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {done && <Alert tone="success">{t('supportAgent.saved')}</Alert>}
    </form>
  );
}

/**
 * The shop's answers to its customers' common questions (ADR-911), which the AI answers from as
 * it does from the shop's policies: written, changed, removed and saved together, in order.
 */
function FaqsForm({ saved, may }: { saved: SupportFaqValue[]; may: boolean }) {
  const { t } = useLocale();
  const save = useAdminMutation<SupportAgentFaqsSetData, { faqs: SupportFaqValue[] }>(
    SupportAgentFaqsSetMutation,
  );
  const [faqs, setFaqs] = useState<SupportFaqValue[]>(saved);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const change = (at: number, faq: Partial<SupportFaqValue>) => {
    setDone(false);
    setFaqs(faqs.map((each, index) => (index === at ? { ...each, ...faq } : each)));
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setDone(false);
    if (faqs.some((faq) => !faq.question.trim() || !faq.answer.trim())) {
      setProblem(t('supportAgent.incomplete'));
      return;
    }
    try {
      const { supportAgentFaqsSet } = await save.mutateAsync({ faqs });
      const error = supportAgentFaqsSet.userErrors[0];
      if (error) setProblem(problemText(error, t));
      else setDone(true);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <form className="flex flex-col gap-3 border-t border-line pt-3" onSubmit={onSubmit}>
      <h3 className="font-medium">{t('supportAgent.faqs')}</h3>
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {t('supportAgent.faqsHint')}
      </p>
      {faqs.map((faq, at) => (
        <fieldset key={at} className="flex flex-col gap-2" disabled={!may}>
          <div className="flex items-end gap-2">
            <TextField
              className="grow"
              label={t('supportAgent.question', { number: at + 1 })}
              value={faq.question}
              maxLength={200}
              dir="auto"
              onChange={(event) => change(at, { question: event.target.value })}
            />
            <Button
              variant="danger"
              icon={<Trash2 aria-hidden className="size-5" />}
              aria-label={t('supportAgent.remove', { number: at + 1 })}
              onClick={() => {
                setDone(false);
                setFaqs(faqs.filter((_, index) => index !== at));
              }}
            />
          </div>
          <TextArea
            label={t('supportAgent.answer', { number: at + 1 })}
            value={faq.answer}
            onChange={(answer) => change(at, { answer })}
          />
        </fieldset>
      ))}
      {may && (
        <div className="flex flex-wrap gap-2">
          {faqs.length < 30 && (
            <Button
              variant="secondary"
              icon={<Plus aria-hidden className="size-5" />}
              onClick={() => {
                setDone(false);
                setFaqs([...faqs, { question: '', answer: '' }]);
              }}
            >
              {t('supportAgent.add')}
            </Button>
          )}
          <Button
            type="submit"
            busy={save.isPending}
            icon={<Save aria-hidden className="size-5" />}
          >
            {t('supportAgent.saveFaqs')}
          </Button>
        </div>
      )}
      {problem && <Alert tone="danger">{problem}</Alert>}
      {done && <Alert tone="success">{t('supportAgent.saved')}</Alert>}
    </form>
  );
}
