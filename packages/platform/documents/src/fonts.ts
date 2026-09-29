// The families of @hatti/tokens. Pages are set in Inter, and Urdu letters that people typed,
// which Inter lacks, fall through to Nastaliq. Urdu wording is set in Nastaliq, larger and with
// room for its tall letters, in its own spans, so that lines without it stay compact.
export const TEXT_FONTS =
  'Inter, "Noto Nastaliq Urdu", "Jameel Noori Nastaleeq", system-ui, sans-serif';
export const URDU_FONTS = '"Noto Nastaliq Urdu", "Jameel Noori Nastaleeq", Inter, serif';

/** Both families from Google Fonts, shown in fallback fonts until they arrive. */
export const FONTS_URL =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700' +
  '&family=Noto+Nastaliq+Urdu:wght@400;700&display=swap';
