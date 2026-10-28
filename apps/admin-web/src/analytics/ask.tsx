import { MessageCircleQuestion } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ReportQuestionAskMutation, ReportQuestionsQuery } from '../api/operations';
import type { ReportQuestionAskData, ReportQuestionsData } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { FormSection } from '../products/product-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import { TextField } from '../ui/field';
import { ReportTable } from './custom-reports';

/**
 * Asking of the shop's numbers (ANL-08, ADR-844), in English, Urdu or Roman Urdu: the report that
 * answers, as Hatti ran it, with what the question was taken to ask, for the merchant to judge it
 * by. Shown only where Hatti's AI is set up.
 */
export function AskNumbers() {
  const { t } = useLocale();
  const status = useAdminQuery<ReportQuestionsData>(['reportQuestions'], ReportQuestionsQuery);
  const ask = useAdminMutation<ReportQuestionAskData, { question: string }>(
    ReportQuestionAskMutation,
  );
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<ReportQuestionAskData['reportQuestionAsk']['answer']>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (!status.data?.reportQuestions.available) return null;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setAnswer(null);
    try {
      const { reportQuestionAsk } = await ask.mutateAsync({ question: question.trim() });
      const error = reportQuestionAsk.userErrors[0];
      if (error) setProblem(error.message);
      else setAnswer(reportQuestionAsk.answer);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('ask.title')} hint={t('ask.hint')}>
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-2">
        <TextField
          label={t('ask.question')}
          value={question}
          maxLength={300}
          dir="auto"
          placeholder={t('ask.example')}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <Button
          type="submit"
          className="self-start"
          busy={ask.isPending}
          disabled={!question.trim()}
          icon={<MessageCircleQuestion aria-hidden className="size-5" />}
        >
          {t('ask.submit')}
        </Button>
      </form>
      {problem && <Alert tone="warning">{problem}</Alert>}
      {answer && (
        <div className="flex flex-col gap-2">
          <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
            {t('ask.readAs', {
              rows: t(`reports.breakdown.${answer.breakdown}` as MessageKey),
              period: t(`reports.period.${answer.period}` as MessageKey),
            })}
          </p>
          <ReportTable result={answer.report} />
        </div>
      )}
    </FormSection>
  );
}
