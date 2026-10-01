/**
 * A file posted in a form, as the core reads the few forms that take one: what the browser said
 * of it, and its bytes, whole or cut off at the most the form takes.
 */
export interface FormFile {
  filename: string;
  /** What the browser said it is; the bytes say otherwise as often as not. */
  mimeType: string;
  data: Buffer;
  /** It was larger than the form takes: `data` holds only what fit. */
  truncated: boolean;
}

export function isFormFile(value: unknown): value is FormFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    Buffer.isBuffer((value as FormFile).data) &&
    typeof (value as FormFile).truncated === 'boolean'
  );
}
