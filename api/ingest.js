// Receives payment notifications from the phone (MacroDroid on Android forwards the
// Max / Google Wallet notification) and puts them in the profile's "pending" inbox,
// where the app shows them for approval. The profile is found by its personal key,
// created in the app's settings. No AI is used, so each charge costs nothing.
//
// GET or POST /api/ingest?key=...&title=...&text=...  (also accepts JSON or form body)
const admin = require('firebase-admin');
const { parseCharge } = require('./_lib/charge');
const { israelToday } = require('./_lib/notify');

const MAX_ITEMS = 100;     // pending items kept per profile
const DAILY_LIMIT = 60;    // charges accepted per profile per day
const DUP_MS = 15 * 60e3;  // same amount within 15 minutes = the same charge (Wallet + Max)

function db() {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  return admin.firestore();
}

function params(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = Object.fromEntries(new URLSearchParams(b)); } }
  return { ...(req.query || {}), ...(b && typeof b === 'object' ? b : {}) };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const p = params(req);
  const key = String(p.key || '');
  if (!/^[A-Za-z0-9]{20,64}$/.test(key)) return res.status(401).json({ error: 'key' });

  const fdb = db();
  const qs = await fdb.collection('profiles').where('ingestKey', '==', key).limit(1).get();
  if (qs.empty) return res.status(401).json({ error: 'key' });
  const prof = qs.docs[0];

  const c = parseCharge(p.title, p.text);
  // Not a charge (an ad, a login code…): nothing to do
  if (!c) return res.status(200).json({ ok: true, ignored: true });

  const now = Date.now(), t = israelToday();
  const ref = prof.ref.collection('data').doc('inbox');
  const out = await fdb.runTransaction(async tx => {
    const items = ((await tx.get(ref)).data() || {}).items || [];
    if (items.filter(i => i.date === t.str).length >= DAILY_LIMIT) return { error: 'limit' };
    const dup = items.find(i => i.amount === c.amount && i.credit === c.credit && Math.abs(now - i.at) < DUP_MS);
    if (dup) {
      // Keep the business name from whichever notification had one
      if (!dup.merchant && c.merchant) { dup.merchant = c.merchant; tx.set(ref, { items }); }
      return { dup: true };
    }
    items.push({ id: now, at: now, date: t.str, ...c });
    tx.set(ref, { items: items.slice(-MAX_ITEMS) });
    return { added: true };
  });
  if (out.error) return res.status(429).json({ error: 'daily limit' });
  return res.status(200).json({ ok: true, ...out, amount: c.amount, merchant: c.merchant });
};
