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

// Summary numbers for one cycle, from the year document ({cats, mData}) and events
function summarize(yearDoc, evts, cycle) {
  const cats = yearDoc?.cats || [];
  const md = yearDoc?.mData?.[cycle.month] || yearDoc?.mData?.[String(cycle.month)] || {};
  const income = (md.income || []).reduce((s, e) => s + num(e.amount), 0);
  const rows = cats.map(c => ({
    name: c.name,
    spent: (md[c.id]?.entries || []).reduce((s, e) => s + num(e.amount), 0),
    budget: num(c.budget) + num(c.budgetRec),
    charity: c.builtin === 'charity' || (c.name || '').trim() === 'צדקה',
  }));
  const events = (evts || []).map(ev => ({
    name: ev.name || ev.title || 'אירוע',
    spent: (ev.expenses || []).filter(e => e.paid && e.date >= cycle.from && e.date <= cycle.to).reduce((s, e) => s + num(e.amount), 0),
  })).filter(e => e.spent > 0);
  const catTotal = rows.reduce((s, r) => s + r.spent, 0);
  const evtTotal = events.reduce((s, e) => s + e.spent, 0);
  const charity = rows.find(r => r.charity);
  const due = Math.round(income / 10), given = charity ? charity.spent : 0;
  return { income, rows, events, expenses: catTotal + evtTotal, balance: income - catTotal - evtTotal, maaser: { due, given, left: due - given } };
}

const box = 'font-family:Arial,sans-serif;direction:rtl;text-align:right;max-width:560px;margin:auto;color:#1e293b';

function summaryHtml(name, label, year, s) {
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
    ${tr ? `<table style="width:100%;border-collapse:collapse;font-size:14px"><tr style="color:#64748b;font-size:12px"><th style="text-align:right;padding:6px 8px">קטגוריה</th><th style="text-align:right;padding:6px 8px">הוצאה</th><th style="text-align:right;padding:6px 8px">תקציב</th></tr>${tr}</table>` : ''}
    ${maaserLine}
  </div>`;
}

function remindersHtml(name, list) {
  return `<div style="${box}"><h2 style="margin:0 0 8px">⏰ תזכורת</h2>
    <div style="color:#64748b;margin-bottom:12px">שלום ${esc(name)},</div>
    <ul style="padding-right:18px;font-size:16px">${list.map(r => `<li style="margin-bottom:6px">${esc(r.text)}</li>`).join('')}</ul></div>`;
}

module.exports = { MO, israelToday, dueReminders, endingCycle, monthLabel, summarize, summaryHtml, remindersHtml };
