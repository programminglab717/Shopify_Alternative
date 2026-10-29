import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSessionStore } from '../auth/context';
import { EXPERT_SERVICES, type Expert } from '../help/experts-page';
import { errorText } from '../i18n/errors';
import { formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/locale';
import type { MessageKey } from '../i18n/messages';
import { TextArea } from '../products/product-form';
import { CheckField } from '../settings/settings-form';
import { Button } from '../ui/button';
import { Alert, Card } from '../ui/feedback';
import { TextField } from '../ui/field';

/** An enquiry a shop sent the expert (ADR-855). */
interface Enquiry {
  id: string;
  shop: { name: string; handle: string };
  sender: { name: string; email: string | null };
  service: string;
  message: string;
  createdAt: string;
}

const KEY = ['partner', 'expert'] as const;
const serviceKey = (service: string) => `experts.service.${service}` as MessageKey;

/**
 * The partner's expert profile (PRT-03, ADR-855), which shops see once Hatti has looked at it,
 * and the enquiries shops sent them, each with the shop's handle to ask for access by and the
 * address to answer.
 */
export function ExpertProfile() {
  const { t, locale } = useLocale();
  const store = useSessionStore();
  const queryClient = useQueryClient();
  const profile = useQuery({
    queryKey: KEY,
    queryFn: () =>
      store.auth<{
        expert: Expert | null;
        /** What the shops that hired them said (ADR-917); absent from older cores. */
        reviews?: { shopName: string; rating: number; body: string; updatedAt: string }[];
      }>('/auth/partner/expert'),
  });
  const enquiries = useQuery({
    queryKey: ['partner', 'enquiries'],
    queryFn: () => store.auth<{ enquiries: Enquiry[] }>('/auth/partner/enquiries'),
  });
  const expert = profile.data?.expert ?? null;
  return (
    <section aria-labelledby="expert-profile" className="flex flex-col gap-2">
      <h2 id="expert-profile" className="font-semibold">
        {t('expertProfile.title')}
      </h2>
      <p className="text-secondary">{t('expertProfile.hint')}</p>
      {expert && (
        <p className="font-medium">
          {t(expert.listed ? 'expertProfile.listed' : 'expertProfile.waiting')}
        </p>
      )}
      {profile.isSuccess && (
        <ProfileForm
          expert={expert}
          onSaved={() => void queryClient.invalidateQueries({ queryKey: KEY })}
        />
      )}
      {(profile.data?.reviews ?? []).length > 0 && (
        <>
          <h3 className="pt-2 font-semibold">{t('expertProfile.reviews')}</h3>
          <ul className="flex flex-col gap-2">
            {profile.data!.reviews!.map((review) => (
              <li key={`${review.shopName}-${review.updatedAt}`}>
                <Card className="flex flex-col gap-1 p-3">
                  <span className="font-medium" dir="auto">
                    {t('expertProfile.review', { shop: review.shopName, rating: review.rating })}
                  </span>
                  {review.body && (
                    <p className="whitespace-pre-line" dir="auto">
                      {review.body}
                    </p>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3 className="pt-2 font-semibold">{t('expertProfile.enquiries')}</h3>
      {(enquiries.data?.enquiries ?? []).length === 0 ? (
        <p className="text-secondary">{t('expertProfile.noEnquiries')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {enquiries.data!.enquiries.map((enquiry) => (
            <li key={enquiry.id}>
              <Card className="flex flex-col gap-1 p-3">
                <span className="font-medium" dir="auto">
                  {t('expertProfile.enquiry', {
                    sender: enquiry.sender.name,
                    shop: enquiry.shop.name,
                    handle: enquiry.shop.handle,
                    service: t(serviceKey(enquiry.service)),
                  })}
                </span>
                <span className="text-secondary text-[length:var(--hatti-type-body-sm-size)]">
                  {formatDateTime(enquiry.createdAt, 'Asia/Karachi', locale)}
                </span>
                <p className="whitespace-pre-line" dir="auto">
                  {enquiry.message}
                </p>
                {enquiry.sender.email && (
                  <a href={`mailto:${enquiry.sender.email}`} className="self-start underline">
                    {t('expertProfile.reply')}
                  </a>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProfileForm({ expert, onSaved }: { expert: Expert | null; onSaved: () => void }) {
  const { t } = useLocale();
  const store = useSessionStore();
  const [headline, setHeadline] = useState(expert?.headline ?? '');
  const [about, setAbout] = useState(expert?.about ?? '');
  const [services, setServices] = useState<string[]>(expert?.services ?? []);
  const [cities, setCities] = useState(expert?.cities.join(', ') ?? '');
  const [languages, setLanguages] = useState<string[]>(expert?.languages ?? ['ur']);
  const [price, setPrice] = useState(String(expert?.startingPrice ?? 0));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const toggle = (list: string[], value: string, on: boolean) =>
    on ? [...list, value] : list.filter((each) => each !== value);

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setSaved(false);
    setProblem(null);
    try {
      await store.auth('/auth/partner/expert', {
        body: {
          headline: headline.trim(),
          about: about.trim(),
          services,
          cities: cities
            .split(',')
            .map((city) => city.trim())
            .filter(Boolean),
          languages,
          startingPrice: Number.parseInt(price, 10) || 0,
        },
      });
      setSaved(true);
      onSaved();
    } catch (failure) {
      setProblem(errorText(failure, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void onSave(event)} className="flex flex-col gap-3">
      <TextField
        label={t('expertProfile.headline')}
        dir="auto"
        maxLength={120}
        value={headline}
        onChange={(event) => setHeadline(event.target.value)}
        required
      />
      <TextArea label={t('expertProfile.about')} value={about} onChange={setAbout} />
      <fieldset className="flex flex-col">
        <legend className="font-medium">{t('expertProfile.services')}</legend>
        {EXPERT_SERVICES.map((service) => (
          <CheckField
            key={service}
            label={t(serviceKey(service))}
            checked={services.includes(service)}
            onChange={(on) => setServices(toggle(services, service, on))}
          />
        ))}
      </fieldset>
      <TextField
        label={t('expertProfile.cities')}
        dir="auto"
        value={cities}
        onChange={(event) => setCities(event.target.value)}
      />
      <fieldset className="flex flex-col">
        <legend className="font-medium">{t('expertProfile.languages')}</legend>
        <CheckField
          label={t('experts.urdu')}
          checked={languages.includes('ur')}
          onChange={(on) => setLanguages(toggle(languages, 'ur', on))}
        />
        <CheckField
          label={t('experts.english')}
          checked={languages.includes('en')}
          onChange={(on) => setLanguages(toggle(languages, 'en', on))}
        />
      </fieldset>
      <TextField
        label={t('expertProfile.price')}
        inputMode="numeric"
        dir="ltr"
        value={price}
        onChange={(event) => setPrice(event.target.value)}
      />
      {saved && <Alert tone="success">{t('expertProfile.saved')}</Alert>}
      {problem && <Alert tone="danger">{problem}</Alert>}
      <Button type="submit" className="self-start" busy={busy}>
        {t('expertProfile.save')}
      </Button>
    </form>
  );
}
