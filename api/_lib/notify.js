// Pure logic for the daily mail job: what is due today and the monthly summary.
// Kept free of Firebase/mail dependencies so it can be tested directly.

const MO = ["ינואר","פברואר","מרץ","אפריל","מאי","יוני","יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"];
const pad = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const lastDayOf = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const num = v => parseFloat(v) || 0;
const fm = n => Math.round(n).toLocaleString('he-IL');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Today's date in Israel as {y, m (0-based), d, str}
function israelToday(now = new Date()) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now).split('-').map(Number);
  return { y, m: m - 1, d, str: ymd(y, m - 1, d) };
}

function dueReminders(reminders, t) {
  const last = lastDayOf(t.y, t.m);
  return (reminders || []).filter(r => {
    if (!r || !r.text) return false;
    if (r.type === 'once') return r.date === t.str;
    const day = parseInt(r.day) || 0;
    return day === t.d || (day > last && t.d === last);
  });
}

// If today is the last day of a budget cycle, the cycle that just ended: {year, month, from, to}.
// A cycle with start day s runs from day s of month m to day s-1 of month m+1 (s=1: the calendar month).
function endingCycle(t, monthStart) {
  const s = parseInt(monthStart) || 1;
  if (s <= 1) {
    if (t.d !== lastDayOf(t.y, t.m)) return null;
    return { year: t.y, month: t.m, from: ymd(t.y, t.m, 1), to: t.str };
  }
  if (t.d !== s - 1) return null;
  const month = t.m === 0 ? 11 : t.m - 1, year = t.m === 0 ? t.y - 1 : t.y;
  return { year, month, from: ymd(year, month, Math.min(s, lastDayOf(year, month))), to: t.str };
}

function monthLabel(month, monthStart) {
  return (parseInt(monthStart) || 1) >= 15 ? MO[(month + 1) % 12] : MO[month];
}

// Payments of an event expense (same rule as the app): partial payments, plus the rest
// on the expense date once it is marked fully paid
function evPays(e) {
  const amt = num(e.amount), ps = (e.pays || []).map(p => ({ amt: num(p.amt), date: p.date }));
  const sum = ps.reduce((t, p) => t + p.amt, 0);
  if (e.paid && sum < amt) ps.push({ amt: amt - sum, date: e.date });
  return ps;
}

// Summary numbers for one cycle, from the year document ({cats, mData}) and events
function summarize(yearDoc, evts, cycle) {
  const cats = yearDoc?.cats || [];
  const md = yearDoc?.mData?.[cycle.month] || yearDoc?.mData?.[String(cycle.month)] || {};
  const income = (md.income || []).reduce((s, e) => s + num(e.amount), 0);
  const inCycle = p => p.date >= cycle.from && p.date <= cycle.to;
  const rows = cats.map(c => {
    const entries = md[c.id]?.entries || [];
    return {
      name: c.name,
      spent: entries.reduce((s, e) => s + num(e.amount), 0),
      budget: num(c.budget) + num(c.budgetRec),
      charity: c.builtin === 'charity' || (c.name || '').trim() === 'צדקה',
      // The single expenses, for Claude's analysis
      subs: (c.subs || []).map(sb => ({ name: sb.name, budget: num(sb.budget) })).filter(sb => sb.name),
      items: entries.map(e => ({ desc: e.desc || '', amount: num(e.amount), date: e.date || '', sub: (c.subs || []).find(sb => sb.id === e.subCat)?.name || '', rec: !!e.recurring })),
    };
  });
  const events = (evts || []).map(ev => ({
    name: ev.name || ev.title || 'אירוע',
    budget: num(ev.budget),
    spent: (ev.expenses || []).flatMap(evPays).filter(inCycle).reduce((s, p) => s + p.amt, 0),
    items: (ev.expenses || []).map(e => ({ desc: e.desc || '', amount: num(e.amount), paidNow: evPays(e).filter(inCycle).reduce((s, p) => s + p.amt, 0) })).filter(e => e.paidNow > 0),
  })).filter(e => e.spent > 0);
  const catTotal = rows.reduce((s, r) => s + r.spent, 0);
  const evtTotal = events.reduce((s, e) => s + e.spent, 0);
  const charity = rows.find(r => r.charity);
  const due = Math.round(income / 10), given = charity ? charity.spent : 0;
  return { income, rows, events, expenses: catTotal + evtTotal, balance: income - catTotal - evtTotal, maaser: { due, given, left: due - given } };
}

const box = 'font-family:Arial,sans-serif;direction:rtl;text-align:right;max-width:560px;margin:auto;color:#1e293b';

function summaryHtml(name, label, year, s, ai) {
  const tr = s.rows.filter(r => r.spent > 0 || r.budget > 0).map(r => {
    const over = r.budget > 0 && r.spent > r.budget;
    return `<tr><td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">${esc(r.name)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;color:${over ? '#ef4444' : '#1e293b'};font-weight:${over ? 700 : 400}">₪${fm(r.spent)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;color:#94a3b8">${r.budget > 0 ? '₪' + fm(r.budget) : '—'}</td></tr>`;
  }).join('') + s.events.map(e => `<tr><td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">🎉 ${esc(e.name)}</td><td style="padding:6px 8px;border-bottom:1px solid #f1f5f9">₪${fm(e.spent)}</td><td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;color:#94a3b8">—</td></tr>`).join('');
  const m = s.maaser;
  const maaserLine = m.due <= 0 ? '' : m.left > 0
    ? `<p style="background:#fdf2f8;color:#db2777;padding:10px 14px;border-radius:10px">🧮 מעשר: נשאר להשלים <b>₪${fm(m.left)}</b> (מתוך ₪${fm(m.due)})</p>`
    : `<p style="background:#f0fdf4;color:#059669;padding:10px 14px;border-radius:10px">🧮 המעשר הושלם ✔</p>`;
  return `<div style="${box}">
    <h2 style="margin:0 0 4px">סיכום חודש ${esc(label)} ${year}</h2>
    <div style="color:#64748b;margin-bottom:16px">שלום ${esc(name)}, הנה סיכום החודש שהסתיים:</div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;text-align:center"><tr>
      <td style="background:#f0fdf4;padding:10px;border-radius:10px"><div style="font-size:12px;color:#64748b">הכנסות</div><div style="font-size:18px;font-weight:700;color:#059669">₪${fm(s.income)}</div></td>
      <td style="background:#eef2ff;padding:10px;border-radius:10px"><div style="font-size:12px;color:#64748b">הוצאות</div><div style="font-size:18px;font-weight:700;color:#6366f1">₪${fm(s.expenses)}</div></td>
      <td style="background:${s.balance >= 0 ? '#f0fdf4' : '#fef2f2'};padding:10px;border-radius:10px"><div style="font-size:12px;color:#64748b">מאזן</div><div style="font-size:18px;font-weight:700;color:${s.balance >= 0 ? '#059669' : '#ef4444'}">${s.balance < 0 ? '-' : ''}₪${fm(Math.abs(s.balance))}</div></td>
    </tr></table>
    ${aiBoxHtml(ai)}
    ${tr ? `<table style="width:100%;border-collapse:collapse;font-size:14px"><tr style="color:#64748b;font-size:12px"><th style="text-align:right;padding:6px 8px">קטגוריה</th><th style="text-align:right;padding:6px 8px">הוצאה</th><th style="text-align:right;padding:6px 8px">תקציב</th></tr>${tr}</table>` : ''}
    ${maaserLine}
  </div>`;
}

function remindersHtml(name, list) {
  return `<div style="${box}"><h2 style="margin:0 0 8px">⏰ תזכורת</h2>
    <div style="color:#64748b;margin-bottom:12px">שלום ${esc(name)},</div>
    <ul style="padding-right:18px;font-size:16px">${list.map(r => `<li style="margin-bottom:6px">${esc(r.text)}</li>`).join('')}</ul></div>`;
}

// Date n days after t (n may be negative), as {y, m, d, str}
const addDays = (t, n) => { const d = new Date(Date.UTC(t.y, t.m, t.d + n)); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), str: ymd(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) }; };

// ---------- Claude analysis for the monthly summary ----------
const AI_SUMMARY_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' }, tips: { type: 'array', items: { type: 'string' } } },
  required: ['summary', 'tips'],
  additionalProperties: false,
};

const MAX_LINES = 800; // expense lines in the monthly prompt
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function monthlyPrompt(label, year, s) {
  const cats = s.rows.filter(r => r.spent > 0 || r.budget > 0);
  const perCat = Math.max(30, Math.floor(MAX_LINES / (cats.length || 1)));
  const data = {
    income: Math.round(s.income), expenses: Math.round(s.expenses), balance: Math.round(s.balance),
    categories: cats.map(r => {
      // Largest expenses first when there are too many lines
      const items = [...(r.items || [])].sort((a, b) => b.amount - a.amount);
      const out = { name: r.name, spent: Math.round(r.spent), budget: r.budget };
      if (r.subs?.length) out.subs = r.subs;
      if (items.length) out.items = items.slice(0, perCat).map(e => [clip(e.desc, 40), Math.round(e.amount), clip(e.date, 10), clip(e.sub, 30), e.rec ? 1 : 0]);
      if (items.length > perCat) out.itemsOmitted = items.length - perCat;
      return out;
    }),
    events: s.events.map(e => ({ name: e.name, budget: e.budget, spent: Math.round(e.spent), items: (e.items || []).slice(0, 40).map(x => [clip(x.desc, 40), Math.round(x.amount), Math.round(x.paidNow)]) })),
    maaser: s.maaser,
  };
  return `אתה יועץ כלכלי למשפחה ישראלית. הנה נתוני חודש ${label} ${year} שהסתיים: הכנסות, הוצאות ומאזן; לכל קטגוריה שמה, ההוצאה מול התקציב, תתי-הקטגוריות, וכל הוצאה בנפרד בפורמט [תיאור כפי שהמשפחה כתבה, סכום, תאריך, תת-קטגוריה, 1 אם היא הוצאה קבועה] (itemsOmitted: הוצאות קטנות שלא נכללו ברשימה אבל כן בסכום); אירועים מיוחדים עם התקציב שלהם וההוצאות ששולמו החודש [תיאור, סכום מלא, שולם החודש]; ומעשר.
${JSON.stringify(data)}
כתוב ב-summary שניים-שלושה משפטים על החודש: מה הלך טוב, איפה הייתה חריגה ובגלל אילו הוצאות ספציפיות, ומה המשמעות. ב-tips כתוב עד 3 הצעות מעשיות וקצרות לשיפור בחודש הבא, שמתייחסות להוצאות מהנתונים (מנויים, בתי עסק, הוצאות שחוזרות). קטגוריית "צדקה" היא נתינה מתוך עיקרון, אל תציע לקצץ בה. בעברית, בטון חם ולא שיפוטי.`;
}

function aiBoxHtml(ai) {
  if (!ai) return '';
  return `<div style="background:#f3f7f4;border:1px solid #d4e4d8;border-radius:12px;padding:12px 14px;margin:16px 0">
    <div style="font-weight:700;color:#3f7356;margin-bottom:6px">✨ ניתוח Claude</div>
    <div style="line-height:1.6">${esc(ai.summary)}</div>
    ${(ai.tips || []).length ? `<ul style="padding-right:18px;margin:8px 0 0;line-height:1.6;color:#5e554a">${ai.tips.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

module.exports = { MO, israelToday, dueReminders, endingCycle, monthLabel, summarize, summaryHtml, remindersHtml,
  monthlyPrompt, AI_SUMMARY_SCHEMA, addDays };
