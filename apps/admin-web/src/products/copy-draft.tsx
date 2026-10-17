import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { ProductCopyDraftMutation, ProductCopyDraftingQuery } from '../api/operations';
import type { CopyLanguage, ProductCopyDraftData, ProductCopyDraftingData } from '../api/types';
import { errorText } from '../i18n/errors';
import { useLocale } from '../i18n/locale';
import { SelectField } from '../settings/settings-form';
import { useAdminMutation, useAdminQuery } from '../shell/shop-context';
import { Button } from '../ui/button';
import { Alert } from '../ui/feedback';
import type { DetailsState } from './product-form';
import { parseTags } from './product-form';

/**
 * A drafted description's HTML as the form's plain text: paragraphs apart, each item of a list on
 * its own line after a bullet.
 */
export function plainTextOf(html: string): string {
  const document = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const blocks: string[] = [];
  for (const node of Array.from(document.body.childNodes)) {
    if (node instanceof HTMLElement && (node.tagName === 'UL' || node.tagName === 'OL')) {
      blocks.push(
        Array.from(node.querySelectorAll('li'))
          .map((item) => `• ${item.textContent?.trim() ?? ''}`)
          .join('\n'),
      );
    } else {
      const text = node.textContent?.trim();
      if (text) blocks.push(text);
    }
  }
  return blocks.join('\n\n');
}

/**
 * The product's title and description written with AI from what the form says of it (CAT-20,
 * ADR-472), in English, Urdu or Roman Urdu: put in the form, marked as AI's until the shop saves
 * it. Shown only where this Hatti drafts with AI.
 */
export function CopyDraft({
  details,
  onChange,
  productId,
  options = [],
}: {
  details: DetailsState;
  onChange: (details: DetailsState) => void;
  productId?: string;
  options?: { name: string; values: string[] }[];
}) {
  const { t } = useLocale();
  const drafting = useAdminQuery<ProductCopyDraftingData>(
    ['productCopyDrafting'],
    ProductCopyDraftingQuery,
  );
  const draft = useAdminMutation<ProductCopyDraftData, { input: Record<string, unknown> }>(
    ProductCopyDraftMutation,
  );
  const [language, setLanguage] = useState<CopyLanguage>('ENGLISH');
  const [problem, setProblem] = useState<string | null>(null);
  const [drafted, setDrafted] = useState(false);

  const state = drafting.data?.productCopyDrafting;
  if (!state?.available) return null;
  // The day's drafts, and the plan's AI credits this month where they are counted (ADR-533).
  const credits = state.creditsLeft ?? null;
  const left = Math.min(state.limitPerDay - state.usedToday, credits ?? Number.POSITIVE_INFINITY);
  const blank = !details.title.trim() && !details.description.trim();

  const onDraft = async () => {
    setProblem(null);
    try {
      const { productCopyDraft } = await draft.mutateAsync({
        input: {
          language,
          ...(productId && { productId }),
          title: details.title.trim() || null,
          productType: details.productType.trim() || null,
          vendor: details.vendor.trim() || null,
          tags: parseTags(details.tags),
          options: options.filter((option) => option.values.length > 0),
          description: details.description.trim() || null,
        },
      });
      if (!productCopyDraft.draft) {
        setProblem(productCopyDraft.userErrors[0]?.message ?? t('state.error'));
        return;
      }
      onChange({
        ...details,
        title: productCopyDraft.draft.title,
        description: plainTextOf(productCopyDraft.draft.descriptionHtml),
      });
      setDrafted(true);
    } catch (failure) {
      setProblem(errorText(failure, t));
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-control border border-line p-3">
      <div className="flex flex-wrap items-end gap-3">
        <SelectField<CopyLanguage>
          label={t('copyDraft.language')}
          value={language}
          options={[
            { value: 'ENGLISH', label: t('copyDraft.english') },
            { value: 'URDU', label: t('copyDraft.urdu') },
            { value: 'ROMAN_URDU', label: t('copyDraft.romanUrdu') },
          ]}
          onChange={setLanguage}
        />
        <Button
          variant="secondary"
          busy={draft.isPending}
          disabled={blank || left <= 0}
          icon={<Sparkles aria-hidden className="size-5" />}
          onClick={() => void onDraft()}
        >
          {t('copyDraft.write')}
        </Button>
      </div>
      <p className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
        {blank
          ? t('copyDraft.blank')
          : credits === 0
            ? t('ai.noCredits')
            : credits !== null
              ? t('copyDraft.credits', { count: credits, perMonth: state.creditsPerMonth ?? 0 })
              : t('copyDraft.left', { count: Math.max(left, 0) })}
      </p>
      {drafted && <Alert tone="info">{t('copyDraft.drafted')}</Alert>}
      {problem && <Alert tone="danger">{problem}</Alert>}
    </div>
  );
}
