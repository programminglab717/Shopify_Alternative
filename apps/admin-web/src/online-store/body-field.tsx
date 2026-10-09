import { useId, useState } from 'react';
import { useLocale } from '../i18n/locale';
import { htmlFromText, textFromHtml } from './page-body';

/** A body as the core keeps it, as the editor would send it back unchanged. */
export function normalized(html: string, rtl = false): string {
  const text = textFromHtml(html);
  return text === null ? html : htmlFromText(text, { rtl });
}

/**
 * A page's or policy's body being written: as plain text where it can be, else as its HTML; and
 * what it comes to as HTML, to send.
 */
export function useBody(initial: string, rtl = false) {
  const [state, setState] = useState(() => {
    const text = textFromHtml(initial);
    return { asHtml: text === null, value: text ?? initial };
  });
  return {
    ...state,
    html: state.asHtml ? state.value : htmlFromText(state.value, { rtl }),
    rtl,
    setValue: (value: string) => setState((now) => ({ ...now, value })),
    /** Another body in its place, such as Hatti's draft. */
    load: (html: string) => {
      const text = textFromHtml(html);
      setState({ asHtml: text === null, value: text ?? html });
    },
  };
}

export type Body = ReturnType<typeof useBody>;

/** The body's box: plain text with how to write headings and lists, or its HTML. */
export function BodyArea({ body, label }: { body: Body; label: string }) {
  const { t } = useLocale();
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {body.asHtml ? t('pages.bodyHtmlLabel', { label }) : label}
      </label>
      <p className="text-secondary">{t(body.asHtml ? 'pages.bodyHtmlHint' : 'pages.bodyHint')}</p>
      <textarea
        id={id}
        value={body.value}
        rows={14}
        dir={body.asHtml ? 'ltr' : body.rtl ? 'rtl' : 'auto'}
        lang={body.rtl ? 'ur' : undefined}
        onChange={(event) => body.setValue(event.target.value)}
        className={`rounded-control border border-line bg-surface px-3 py-2 text-text ${
          body.asHtml ? 'font-mono text-[length:var(--hatti-type-body-sm-size)]' : ''
        }`}
      />
    </div>
  );
}
