import { Sparkles, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { StoreBuildMutation, StoreBuildPlanQuery } from '../api/operations';
import type { StoreBuildData, StoreBuildPlanData, StoreBuildPlanValue } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { FormSection, TextArea } from '../products/product-form';
import { useSessionStore } from '../auth/context';
import { useAdminMutation, useShop } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';

/** The fewest characters the store builder reads a shop from (ADR-502). */
const SHORTEST = 20;

/** A description's paragraphs, as its About us page has them: a blank line between each. */
function paragraphsOf(description: string): string[] {
  return description
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * The store builder (ONB-03, ADR-502): the owner says in a few lines what the shop sells, sees
 * what Hatti would make of them, the kind of shop, its theme's colour, its About us page and what
 * search engines see, and builds it in a tap. What the shop set already is left as it is.
 */
export function StoreBuilderTab() {
  const { t } = useLocale();
  const store = useSessionStore();
  const shop = useShop();
  const build = useAdminMutation<StoreBuildData, { input: { description: string } }>(
    StoreBuildMutation,
  );
  const [description, setDescription] = useState('');
  const [plan, setPlan] = useState<StoreBuildPlanValue | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<StoreBuildData['storeBuild'] | null>(null);
  const [asking, setAsking] = useState(false);
  const short = description.trim().length < SHORTEST;

  const preview = async () => {
    if (short) return setProblem(t('builder.short'));
    setProblem(null);
    setDone(null);
    setAsking(true);
    try {
      const answer = await store.graphql<StoreBuildPlanData>(shop.id, StoreBuildPlanQuery, {
        description: description.trim(),
      });
      setPlan(answer.storeBuildPlan);
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setAsking(false);
    }
  };

  const run = async () => {
    setProblem(null);
    try {
      const { storeBuild } = await build.mutateAsync({
        input: { description: description.trim() },
      });
      if (storeBuild.userErrors.length > 0) {
        setProblem(storeBuild.userErrors.map((error) => error.message).join(' '));
        return;
      }
      setDone(storeBuild);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <FormSection title={t('builder.title')} hint={t('builder.hint')}>
      <TextArea
        label={t('builder.description')}
        value={description}
        onChange={(next) => {
          setDescription(next);
          setPlan(null);
          setDone(null);
        }}
      />
      <Button
        variant="secondary"
        className="self-start"
        busy={asking}
        icon={<Sparkles aria-hidden className="size-5" />}
        onClick={() => void preview()}
      >
        {t('builder.preview')}
      </Button>
      {problem && <Alert tone="danger">{problem}</Alert>}
      {plan && !done && (
        <div className="flex flex-col gap-2 rounded-control border border-line p-3">
          <p>
            {plan.kit
              ? t('builder.kit', { kit: t(`builder.kit.${plan.kit}`) })
              : t('builder.noKit')}
          </p>
          <p>{t('builder.theme', { name: plan.themeName })}</p>
          <p className="flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block size-5 rounded-full border border-line"
              style={{ backgroundColor: plan.accentColour }}
            />
            {t('builder.accent', { colour: plan.accentColour })}
          </p>
          <p className="text-sm text-secondary">
            {t('builder.seo', { title: plan.seoTitle, description: plan.seoDescription })}
          </p>
          <p className="font-medium">{t('builder.about')}</p>
          {/* The page's paragraphs, as the core makes them of the owner's own words. */}
          <div className="flex flex-col gap-2 text-sm">
            {paragraphsOf(description).map((paragraph, at) => (
              <p key={at} dir="auto">
                {paragraph}
              </p>
            ))}
          </div>
          <Button
            className="self-start"
            busy={build.isPending}
            icon={<Wand2 aria-hidden className="size-5" />}
            onClick={() => void run()}
          >
            {t('builder.build')}
          </Button>
        </div>
      )}
      {done && (
        <Alert tone="success">
          <p>
            {t('builder.built', {
              collections: done.collectionsMade,
              charts: done.sizeChartsMade,
              links: done.menuLinksAdded,
            })}
          </p>
          <p>
            {done.aboutPage
              ? t('builder.aboutMade', { handle: done.aboutPage.handle })
              : t('builder.aboutKept')}
          </p>
          {done.theme && (
            <p>
              {t(done.theme.published ? 'builder.themePublished' : 'builder.themeWaiting', {
                name: done.theme.name,
              })}
            </p>
          )}
          {!done.seoSet && <p>{t('builder.seoKept')}</p>}
        </Alert>
      )}
    </FormSection>
  );
}
