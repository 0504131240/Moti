// AI budget suggestions. The app sends the last months' data (categories, budgets,
// monthly totals and income, each expense with its description, and events); this function checks
// the Google sign-in, applies a weekly limit, and asks Claude for a budget per category.
//
// Environment variables (Vercel): ANTHROPIC_API_KEY, FIREBASE_SERVICE_ACCOUNT,
// optional ANTHROPIC_MODEL (default claude-opus-5-5) and AI_WEEKLY_LIMIT (default 1).
// Once the week's analyses are used, the last analysis of that profile is returned instead.
const admin = require('firebase-admin');
const { israelToday, addDays } = require('./_lib/notify');
const { askClaude, Refused, Anthropic } = require('./_lib/ai');

const WEEKLY_LIMIT = parseInt(process.env.AI_WEEKLY_LIMIT) || 1;

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

const str = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const arr = v => (Array.isArray(v) ? v : []);
const MAX_ITEMS = 1500; // expense lines per request, to keep the prompt bounded

// Keep the largest `cap` items, in their original order; report how many were left out
function capItems(items, cap) {
  if (items.length <= cap) return { items, omitted: 0 };
  const keep = new Set(items.map((it, i) => [it, i]).sort((a, b) => b[0][2] - a[0][2]).slice(0, cap).map(x => x[1]));
  return { items: items.filter((_, i) => keep.has(i)), omitted: items.length - cap };
}

// Keep only the fields we expect, with sane sizes
function clean(body) {
  const raw = arr(body?.cats).slice(0, 40);
  const perCat = Math.max(30, Math.floor(MAX_ITEMS / (raw.length || 1)));
  const cats = raw.map(c => {
    // [month index, description, amount, sub-category?, 1 if recurring?]
    const items = arr(c.items).filter(Array.isArray).map(it => {
      const row = [Math.min(11, Math.max(0, num(it[0]))), str(it[1], 40), num(it[2])];
      if (it[3] || it[4]) row.push(str(it[3], 30));
      if (it[4]) row.push(1);
      return row;
    });
    const { items: kept, omitted } = capItems(items, perCat);
    const out = {
      id: num(c.id),
      name: str(c.name, 40),
      budget: num(c.budget),
      budgetRec: num(c.budgetRec),
      variable: arr(c.variable).slice(0, 12).map(num),
      recurring: arr(c.recurring).slice(0, 12).map(num),
    };
    const subs = arr(c.subs).slice(0, 20).map(s => ({ name: str(s?.name, 30), budget: num(s?.budget) })).filter(s => s.name);
    if (subs.length) out.subs = subs;
    if (kept.length) out.items = kept;
    if (omitted) out.itemsOmitted = omitted;
    return out;
  });
  const months = arr(body?.months).slice(0, 12).map(m => ({ label: str(m?.label, 20), income: num(m?.income) }));
  // Events: [description, amount, paid so far, date]
  const events = arr(body?.events).slice(0, 15).map(ev => ({
    name: str(ev?.name, 40),
    budget: num(ev?.budget),
    expenses: arr(ev?.expenses).filter(Array.isArray).slice(0, 40).map(e => [str(e[0], 40), num(e[1]), num(e[2]), str(e[3], 10)]),
  }));
  const data = { cats, months };
  if (events.length) data.events = events;
  return data;
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

  const data = clean(req.body);
  if (!data.cats.length) return res.status(400).json({ error: 'אין קטגוריות לניתוח' });
  const pid = String(req.body?.pid || '').slice(0, 40) || 'default';

  // Weekly limit per account (weeks start on Sunday, Israel time)
  const t = israelToday();
  const weekStart = addDays(t, -new Date(Date.UTC(t.y, t.m, t.d)).getUTCDay());
  const week = weekStart.str, nextWeek = addDays(weekStart, 7).str;
  const ref = app().firestore().collection('aiUsage').doc(user.email.toLowerCase());
  const gate = await app().firestore().runTransaction(async tx => {
    const d = (await tx.get(ref)).data() || {};
    const count = d.week === week ? d.count || 0 : 0;
    if (count >= WEEKLY_LIMIT) return { ok: false, last: (d.last || {})[pid] };
    tx.set(ref, { week, count: count + 1 }, { merge: true });
    return { ok: true };
  });
  if (!gate.ok) {
    if (gate.last) return res.status(200).json({ ...gate.last.out, cached: true, at: gate.last.at, next: nextWeek });
    return res.status(429).json({ error: 'ניצלת את הניתוח השבועי. ניתוח חדש יהיה אפשרי מיום ראשון.', next: nextWeek });
  }

  const prompt = `אתה יועץ כלכלי למשפחה ישראלית. לפניך נתוני ההוצאות של המשפחה ב-${data.months.length} החודשים האחרונים (months: החודש הראשון, אינדקס 0, הוא הנוכחי וייתכן שהוא חלקי; לכל חודש ההכנסה שלו).
לכל קטגוריה (cats):
- name: שם הקטגוריה; budget: התקציב הנוכחי להוצאות משתנות; budgetRec: התקציב הנוכחי להוצאות קבועות.
- variable / recurring: סכום ההוצאות המשתנות / הקבועות בכל חודש, באותו סדר של months.
- subs: תתי-הקטגוריות ותקציבן (אם יש).
- items: כל הוצאה בנפרד, בפורמט [אינדקס חודש, תיאור ההוצאה כפי שהמשפחה כתבה, סכום, תת-קטגוריה, 1 אם היא הוצאה קבועה]. itemsOmitted: מספר הוצאות קטנות שלא נכללו ברשימה (הן כן כלולות בסכומים).
events: אירועים מיוחדים (חתונה, חג וכו') עם תקציב משלהם, וההוצאות שלהם בפורמט [תיאור, סכום, שולם עד כה, תאריך]. הם לא חלק מתקציב הקטגוריות, אבל משפיעים על היכולת לחסוך.

${JSON.stringify(data)}

הצע תקציב חודשי ריאלי לכל קטגוריה (גם משתנה וגם קבוע, בשקלים שלמים, מעוגל ל-50), שמבוסס על ההוצאות בפועל, מתחשב במגמות ובחודשים חריגים, ומשאיר חיסכון של לפחות 15% מההכנסה הממוצעת אם אפשר.
השתמש בתיאורי ההוצאות כדי להבין על מה הכסף הולך בפועל: חשבונות ומנויים שחוזרים כל חודש, הוצאות חד-פעמיות שלא צפויות לחזור (ואל תבנה עליהן תקציב), סוגי הוצאה או בתי עסק שמתייקרים, והוצאות שנרשמו כנראה בקטגוריה לא מתאימה.
אל תשנה בלי סיבה תקציב שמתאים להוצאות. קטגוריה בשם "צדקה" היא נתינה מתוך עיקרון, אל תציע לקצץ בה.
החזר לכל קטגוריה id, budget, budgetRec ונימוק קצר בעברית (עד 12 מילים, ואפשר להזכיר בו הוצאה ספציפית). ב-summary כתוב משפט או שניים על המצב הכללי, וב-tips עד 3 טיפים מעשיים וקצרים שמתייחסים להוצאות ספציפיות מהנתונים. הכל בעברית.`;

  try {
    const out = await askClaude(prompt, SCHEMA);
    const ids = new Set(data.cats.map(c => c.id));
    out.categories = (out.categories || []).filter(c => ids.has(c.id)).map(c => ({ ...c, budget: Math.max(0, num(c.budget)), budgetRec: Math.max(0, num(c.budgetRec)) }));
    // Keep it so the window can show it again until next week
    await ref.set({ last: { [pid]: { out, at: t.str } } }, { merge: true });
    return res.status(200).json({ ...out, next: nextWeek });
  } catch (e) {
    console.error('suggest', e);
    // A failed analysis doesn't use up the week
    await ref.set({ count: app().firestore.FieldValue.increment(-1) }, { merge: true }).catch(() => {});
    if (e instanceof Refused) return res.status(422).json({ error: 'לא ניתן היה לנתח את הנתונים הפעם' });
    if (e instanceof Anthropic.RateLimitError) return res.status(429).json({ error: 'השירות עמוס כרגע, נסה שוב בעוד דקה' });
    if (e instanceof Anthropic.AuthenticationError) return res.status(503).json({ error: 'מפתח ה-API לא תקין' });
    return res.status(502).json({ error: 'הניתוח נכשל, נסה שוב' });
  }
};
