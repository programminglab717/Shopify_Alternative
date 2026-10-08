import { ApiError } from '../api/client';
import type { Translate } from './locale';
import { messages, type MessageKey } from './messages';

/**
 * What to tell the merchant of `error`, in their language where the admin knows the code; a field's
 * own words from the API otherwise, and a plain "something went wrong" for the rest.
 */
export function errorText(error: unknown, t: Translate): string {
  if (error instanceof ApiError) {
    const key = `error.${error.code}`;
    if (key in messages.en) return t(key as MessageKey);
    if (error.fields[0]) return error.fields[0].message;
    if (error.status >= 400 && error.status < 500 && error.message) return error.message;
  }
  return t('state.error');
}
