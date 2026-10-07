// Daily mail job, run by Vercel Cron (see vercel.json).
// Sends each profile's due reminders and, on the last day of its budget cycle,
// a monthly summary — to every email listed on the profile.
//
// Environment variables (Vercel → Project → Settings → Environment Variables):
//   FIREBASE_SERVICE_ACCOUNT  JSON key of a Firebase service account
//   GMAIL_USER                Gmail address the mails are sent from
//   GMAIL_APP_PASSWORD        Google "app password" for that address
//   CRON_SECRET               any random string; Vercel sends it with cron calls
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const N = require('./_lib/notify');

function db() {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  return admin.firestore();
}

module.exports = async (req, res) => {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const fdb = db();
  const mail = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
  const from = `"תקציב משפחתי" <${process.env.GMAIL_USER}>`;
  const t = N.israelToday();
  const log = [];

  const profiles = await fdb.collection('profiles').get();
  for (const doc of profiles.docs) {
    const p = doc.data();
    const to = (p.emails || []).join(',');
    if (!to || p.lastMailDay === t.str) continue; // already handled today
    let sent = 0;
    try {
      const due = N.dueReminders(p.reminders, t);
      if (due.length) {
        await mail.sendMail({ from, to, subject: `⏰ תזכורת: ${due.map(r => r.text).join(', ').slice(0, 80)}`, html: N.remindersHtml(p.name, due) });
        sent++;
      }
      const cycle = p.mailSummary ? N.endingCycle(t, p.monthStart) : null;
      if (cycle) {
        const [yDoc, eDoc] = await Promise.all([
          doc.ref.collection('data').doc('y' + cycle.year).get(),
          doc.ref.collection('data').doc('evt').get(),
        ]);
        const s = N.summarize(yDoc.exists ? yDoc.data() : null, eDoc.exists ? eDoc.data().events : [], cycle);
        const label = N.monthLabel(cycle.month, p.monthStart);
        await mail.sendMail({ from, to, subject: `📊 סיכום חודש ${label} ${cycle.year}`, html: N.summaryHtml(p.name, label, cycle.year, s) });
        sent++;
      }
      if (sent) await doc.ref.update({ lastMailDay: t.str });
      log.push({ profile: doc.id, sent });
    } catch (e) {
      console.error('profile', doc.id, e);
      log.push({ profile: doc.id, error: String(e.message || e) });
    }
  }
  res.status(200).json({ day: t.str, log });
};
