import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { formatMoney, formatPhone } from './format';
import { LocaleProvider, interpolate, useLocale } from './locale';
import { messages } from './messages';

function Probe() {
  const { t, setLocale } = useLocale();
  return (
    <button type="button" onClick={() => setLocale('ur')}>
      {t('app.name')}
    </button>
  );
}

describe("The admin's languages", () => {
  afterEach(() => {
    document.documentElement.lang = '';
    document.documentElement.dir = '';
  });

  it('gives every English message in Urdu too', () => {
    expect(Object.keys(messages.ur).sort()).toEqual(Object.keys(messages.en).sort());
    for (const [key, text] of Object.entries(messages.ur)) expect(text, key).not.toBe('');
  });

  it('turns the page right to left in Urdu, and remembers the choice', () => {
    render(
      <LocaleProvider initial="en">
        <Probe />
      </LocaleProvider>,
    );
    expect(document.documentElement.dir).toBe('ltr');
    act(() => screen.getByRole('button').click());
    expect(screen.getByRole('button').textContent).toBe('ہٹی');
    expect(document.documentElement).toMatchObject({ lang: 'ur', dir: 'rtl' });
    expect(window.localStorage.getItem('hatti.locale')).toBe('ur');
  });

  it('fills placeholders, leaving one without a value as it is', () => {
    expect(interpolate('{count} orders for {name}', { count: 12 })).toBe('12 orders for {name}');
  });

  it('writes money and numbers as merchants read them', () => {
    expect(formatMoney('4850.00')).toBe('Rs 4,850');
    expect(formatMoney('4850.50')).toBe('Rs 4,850.50');
    expect(formatMoney('-250.00')).toBe('-Rs 250');
    expect(formatPhone('+923001234567')).toBe('0300 1234567');
    expect(formatPhone('+971501234567')).toBe('+971501234567');
  });
});
