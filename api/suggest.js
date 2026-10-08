// AI budget suggestions. The app sends a numeric summary of the last months
// (category names, monthly spend, income, current budgets); this function checks
// the Google sign-in, applies a daily limit, and asks Claude for a budget per category.
//
// Environment variables (Vercel): ANTHROPIC_API_KEY, FIREBASE_SERVICE_ACCOUNT,
// optional ANTHROPIC_MODEL (default claude-opus-5-5) and AI_DAILY_LIMIT (default 10).
const admin = require('firebase-admin');
const { israelToday } = require('./_lib/notify');
const { askClaude, Refused, Anthropic } = require('./_lib/ai');

const DAILY_LIMIT = parseInt(process.env.AI_DAILY_LIMIT) || 10;

function app() {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  return admin;
}

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    tips: { type: 'array', items: { type: 'string' } },
    categories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          budget: { type: 'integer' },
          budgetRec: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['id', 'budget', 'budgetRec', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'tips', 'categories'],
  additionalProperties: false,
};

const num = v => Math.round(Number(v) || 0);

// Keep only the fields we expect, with sane sizes
function clean(body) {
  const cats = (Array.isArray(body?.cats) ? body.cats : []).slice(0, 40).map(c => ({
    id: num(c.id),
    name: String(c.name || '').slice(0, 40),
    budget: num(c.budget),
    budgetRec: num(c.budgetRec),
    variable: (Array.isArray(c.variable) ? c.variable : []).slice(0, 12).map(num),
    recurring: (Array.isArray(c.recurring) ? c.recurring : []).slice(0, 12).map(num),
  }));
  const months = (Array.isArray(body?.months) ? body.months : []).slice(0, 12).map(m => ({ label: String(m.label || '').slice(0, 20), income: num(m.income) }));
  return { cats, months };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'השירות עוד לא הוגדר (חסר ANTHROPIC_API_KEY בוורסל)' });

  // Only signed-in users of the app
  let user;
  try {
    user = await app().auth().verifyIdToken((req.headers.authorization || '').replace(/^Bearer /, ''));
  } catch {
    return res.status(401).json({ error: 'צריך להתחבר מחדש' });
  }
  if (!user.email || !user.email_verified) return res.status(401).json({ error: 'צריך להתחבר מחדש' });

  // Daily limit per account
  const day = israelToday().str;
  const ref = app().firestore().collection('aiUsage').doc(user.email.toLowerCase());
  const allowed = await app().firestore().runTransaction(async tx => {
    const d = (await tx.get(ref)).data() || {};
    const count = d.day === day ? d.count || 0 : 0;
    if (count >= DAILY_LIMIT) return false;
    tx.set(ref, { day, count: count + 1 });
    return true;
  });
  if (!allowed) return res.status(429).json({ error: `הגעת למגבלה של ${DAILY_LIMIT} ניתוחים ביום. נסה שוב מחר.` });

  const data = clean(req.body);
  if (!data.cats.length) return res.status(400).json({ error: 'אין קטגוריות לניתוח' });

  const prompt = `אתה יועץ כלכלי למשפחה ישראלית. לפניך סיכום ההוצאות של המשפחה ב-${data.months.length} החודשים האחרונים (החודש הראשון הוא הנוכחי, ייתכן שהוא חלקי).
לכל קטגוריה: התקציב הנוכחי להוצאות משתנות (budget) ולהוצאות קבועות (budgetRec), וסכום ההוצאות בכל חודש, משתנות (variable) וקבועות (recurring), באותו סדר חודשים.

${JSON.stringify(data)}

הצע תקציב חודשי ריאלי לכל קטגוריה (גם משתנה וגם קבוע, בשקלים שלמים, מעוגל ל-50), שמבוסס על ההוצאות בפועל, מתחשב במגמות ובחודשים חריגים, ומשאיר חיסכון של לפחות 15% מההכנסה הממוצעת אם אפשר.
אל תשנה בלי סיבה תקציב שמתאים להוצאות. קטגוריה בשם "צדקה" היא נתינה מתוך עיקרון, אל תציע לקצץ בה.
החזר לכל קטגוריה id, budget, budgetRec ונימוק קצר בעברית (עד 12 מילים). ב-summary כתוב משפט או שניים על המצב הכללי, וב-tips עד 3 טיפים מעשיים וקצרים. הכל בעברית.`;

  try {
    const out = await askClaude(prompt, SCHEMA);
    const ids = new Set(data.cats.map(c => c.id));
    out.categories = (out.categories || []).filter(c => ids.has(c.id)).map(c => ({ ...c, budget: Math.max(0, num(c.budget)), budgetRec: Math.max(0, num(c.budgetRec)) }));
    return res.status(200).json(out);
  } catch (e) {
    console.error('suggest', e);
    if (e instanceof Refused) return res.status(422).json({ error: 'לא ניתן היה לנתח את הנתונים הפעם' });
    if (e instanceof Anthropic.RateLimitError) return res.status(429).json({ error: 'השירות עמוס כרגע, נסה שוב בעוד דקה' });
    if (e instanceof Anthropic.AuthenticationError) return res.status(503).json({ error: 'מפתח ה-API לא תקין' });
    return res.status(502).json({ error: 'הניתוח נכשל, נסה שוב' });
  }
};
