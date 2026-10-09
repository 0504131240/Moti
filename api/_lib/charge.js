// Reads a payment notification (Max, Google Wallet and similar) into {amount, merchant, cur, credit}.
// Pure text parsing, no AI, so each charge costs nothing.

const CUR = [
  [/ש["״']?ח|₪|ils|nis|שקל/i, 'ILS'],
  [/\$|usd|דולר/i, 'USD'],
  [/€|eur|יורו/i, 'EUR'],
];
const num = s => parseFloat(String(s).replace(/,/g, '')) || 0;
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function curOf(s) {
  for (const [re, c] of CUR) if (re.test(s)) return c;
  return '';
}

// Amount: "בסך 976.14 ש"ח", "₪45.90", "45.90 ₪", "ILS 45.90"
function amountOf(t) {
  const AMT = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)';
  const SYM = '(ש["״\']?ח|₪|ILS|NIS|\\$|USD|€|EUR|דולר|יורו)';
  const pats = [
    new RegExp('(?:בסך|על סך|בסכום(?: של)?|סכום)[:\\s]*' + AMT + '\\s*' + SYM + '?', 'i'),
    new RegExp(SYM + '\\s?' + AMT, 'i'),
    new RegExp(AMT + '\\s?' + SYM, 'i'),
  ];
  for (const re of pats) {
    const m = t.match(re);
    if (!m) continue;
    const [a, c] = re === pats[1] ? [m[2], m[1]] : [m[1], m[2]];
    const amount = num(a);
    if (amount > 0) return { amount, cur: curOf(c || '') || 'ILS', at: m.index + m[0].length };
  }
  return null;
}

// Business name after the amount: "...ש"ח ברמי לוי - רמת החייל בכרטיס המסתיים ב-4428"
const END = /(?=\s+(?:בכרטיס|כרטיס|באמצעות|עם\s|with\s|ב-?\s?\d|אושר|בוצע|בתאריך)|[.\n]|$)/.source;
const AFTER = new RegExp(String.raw`^\s*(?:ב-?\s?|אצל\s|at\s)(?!אמצעות|כרטיס)(.+?)` + END, 'i');
const AFTER_CREDIT = new RegExp(String.raw`^\s*(?:מ-?\s?|ב-?\s?|אצל\s|from\s)(?!אמצעות|כרטיס)(.+?)` + END, 'i');

function merchantFromText(t, after, credit) {
  const m = t.slice(after).match(credit ? AFTER_CREDIT : AFTER);
  if (m) return clip(m[1], 40);
  const b = t.match(/(?:בבית העסק|בבית עסק|אצל)\s*:?\s*(.+?)(?=\s+(?:בכרטיס|בסך|על סך|אושר)|[.,\n]|$)/);
  return b ? clip(b[1], 40) : '';
}

// Titles that are the app or a generic heading, not the business
const GENERIC = /^(max|מקס|google|wallet|google wallet|ארנק|כאל|cal|ישראכרט|isracard|לאומי|עסקה|חיוב|התראה|הודעה|תשלום)/i;

function parseCharge(title, text) {
  title = clip(title, 120); text = clip(text, 400);
  const full = [title, text].filter(Boolean).join(' · ');
  // Amount from the text first (Max), then the title
  let a = amountOf(text), src = text;
  if (!a) { a = amountOf(title); src = title; }
  if (!a) return null;
  const credit = /זיכוי|החזר|ביטול עסקה|refund/i.test(full);
  let merchant = merchantFromText(src, a.at, credit);
  // Google Wallet: the title is the business name and the text holds the amount
  if (!merchant && title && !GENERIC.test(title) && !amountOf(title)) merchant = clip(title, 40);
  return { amount: Math.round(a.amount * 100) / 100, cur: a.cur, merchant, credit, raw: clip(full, 300) };
}

module.exports = { parseCharge };
