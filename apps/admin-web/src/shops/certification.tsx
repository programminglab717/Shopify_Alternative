import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSessionStore } from '../auth/context';
import { errorText } from '../i18n/errors';
import { formatDate } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import { Button } from '../ui/button';
import { Alert, Card } from '../ui/feedback';

interface Words {
  en: string;
  ur: string;
}

interface Course {
  version: string;
  lessons: { id: string; title: Words; body: Words }[];
  questions: { id: string; prompt: Words; options: Words[] }[];
  passMark: number;
}

interface Certificate {
  courseVersion: string;
  score: number;
  passedAt: string;
  expiresAt: string;
}

interface Result {
  score: number;
  passed: boolean;
  wrong: string[];
  certificate: Certificate | null;
}

const KEY = ['partner', 'certification'] as const;

/**
 * Hatti's course for partners (PRT-04, ADR-858): its lessons, in the admin's language, then its
 * ten questions, scored by Hatti. Eight right certify the partner for a year, which shops see on
 * their expert profile; three tries a day.
 */
export function Certification() {
  const { t, locale } = useLocale();
  const store = useSessionStore();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: KEY,
    queryFn: () =>
      store.auth<{ course: Course; certificate: Certificate | null; triesLeft: number }>(
        '/auth/partner/certification',
      ),
  });
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const said = (words: Words) => words[locale];

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const answered = await store.auth<Result>('/auth/partner/certification', {
        body: { answers },
      });
      setResult(answered);
      await queryClient.invalidateQueries({ queryKey: KEY });
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  if (!query.data) return null;
  const { course, certificate, triesLeft } = query.data;
  const all = course.questions.every((question) => answers[question.id] !== undefined);
  return (
    <section aria-labelledby="certification" className="flex flex-col gap-2">
      <h2 id="certification" className="font-semibold">
        {t('certification.title')}
      </h2>
      {certificate ? (
        <Alert tone="success">
          <span className="inline-flex items-center gap-1">
            <BadgeCheck aria-hidden className="size-5" />
            {t('certification.certified', {
              date: formatDate(certificate.expiresAt, 'Asia/Karachi', locale),
            })}
          </span>
        </Alert>
      ) : (
        <p className="text-secondary">{t('certification.hint', { mark: course.passMark })}</p>
      )}
      {course.lessons.map((lesson) => (
        <details key={lesson.id} className="rounded-control border border-line p-3">
          <summary className="cursor-pointer font-medium">{said(lesson.title)}</summary>
          <p className="pt-2">{said(lesson.body)}</p>
        </details>
      ))}
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-3 pt-2">
        {course.questions.map((question, index) => (
          <Card key={question.id} className="p-3">
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 font-medium">
                {index + 1}. {said(question.prompt)}
              </legend>
              {question.options.map((option, choice) => (
                <label key={choice} className="flex min-h-10 items-start gap-2 py-1">
                  <input
                    type="radio"
                    name={question.id}
                    checked={answers[question.id] === choice}
                    onChange={() => setAnswers({ ...answers, [question.id]: choice })}
                    className="mt-0.5 size-5 shrink-0 accent-[var(--hatti-color-primary)]"
                  />
                  <span>{said(option)}</span>
                </label>
              ))}
              {result?.wrong.includes(question.id) && (
                <span className="text-danger">{t('certification.wrong')}</span>
              )}
            </fieldset>
          </Card>
        ))}
        {result && (
          <Alert tone={result.passed ? 'success' : 'warning'}>
            {t(result.passed ? 'certification.passed' : 'certification.failed', {
              score: result.score,
              total: course.questions.length,
              mark: course.passMark,
            })}
          </Alert>
        )}
        {problem && <Alert tone="danger">{problem}</Alert>}
        <p className="text-secondary">{t('certification.tries', { count: triesLeft })}</p>
        <Button type="submit" className="self-start" busy={busy} disabled={!all || triesLeft === 0}>
          {t('certification.submit')}
        </Button>
      </form>
    </section>
  );
}
