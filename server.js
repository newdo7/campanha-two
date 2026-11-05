require('dotenv').config();
const express = require('express'), path = require('path'), fs = require('fs'), crypto = require('crypto');
const Database = require('better-sqlite3'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser'), QR = require('qrcode'), multer = require('multer'), rateLimit = require('express-rate-limit');

const E = process.env, DATA = E.DATA_DIR || path.join(__dirname, 'data'), UP = path.join(DATA, 'uploads');
fs.mkdirSync(UP, { recursive: true });
const db = new Database(path.join(DATA, 'campanha.db'));
db.exec(`CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS donations(id INTEGER PRIMARY KEY, mp_id TEXT UNIQUE, amount REAL, name TEXT, status TEXT DEFAULT 'pending', created TEXT DEFAULT CURRENT_TIMESTAMP, paid TEXT);
CREATE TABLE IF NOT EXISTS media(id INTEGER PRIMARY KEY, file TEXT, kind TEXT, pos INTEGER DEFAULT 0, is_main INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS updates(id INTEGER PRIMARY KEY, section TEXT, title TEXT, body TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP);`);
const defaults = { title: 'Campanha solidária', subtitle: 'Cada contribuição nos aproxima da cura.', goal: '300000', story: 'Conte aqui a história da campanha pelo painel administrativo.', purpose: 'Explique aqui a finalidade dos valores arrecadados.', thanks: '', pix_key: '', pix_name: '', pix_city: '' };
for (const [k, v] of Object.entries(defaults)) db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run(k, v);
const S = () => Object.fromEntries(db.prepare('SELECT * FROM settings').all().map(r => [r.k, r.v]));

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }), cookieParser());
app.use((q, r, n) => { r.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' }); n(); });
app.use('/uploads', express.static(UP));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Pix direto na chave (sem gateway) ----------
const MANUAL = () => !E.MP_ACCESS_TOKEN;
const f = (id, v) => id + String(v.length).padStart(2, '0') + v;
const clean = (s, n) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ]/g, '').toUpperCase().slice(0, n);
function normKey(k) { k = String(k).trim(); if (/^[\d\s()+-]+$/.test(k)) { const d = k.replace(/\D/g, ''); return d.length === 11 && !k.includes('+') && !/^\d{3}\.?\d{3}/.test(k) ? '+55' + d : '+' + (d.length <= 11 ? '55' + d : d); } return k; }
function crc(s) { let c = 0xFFFF; for (const ch of Buffer.from(s)) { c ^= ch << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1; c &= 0xFFFF; } return c.toString(16).toUpperCase().padStart(4, '0'); }
function brcode(key, name, city, amount) {
  const p = f('00', '01') + f('01', '12') + f('26', f('00', 'br.gov.bcb.pix') + f('01', key)) + f('52', '0000') + f('53', '986') + f('54', amount.toFixed(2)) + f('58', 'BR') + f('59', clean(name, 25) || 'DOACAO') + f('60', clean(city, 15) || 'BRASIL') + f('62', f('05', '***')) + '6304';
  return p + crc(p);
}

// ---------- Pix (Mercado Pago) ----------
const MP = 'https://api.mercadopago.com';
const mp = (p, o = {}) => fetch(MP + p, { ...o, headers: { Authorization: 'Bearer ' + E.MP_ACCESS_TOKEN, 'Content-Type': 'application/json', ...(o.headers || {}) } }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(j.message || 'Erro no gateway'); return j; });
const isTest = () => (E.MP_ACCESS_TOKEN || '').startsWith('TEST-');
async function sync(mpId) { // valida SEMPRE no servidor, direto no gateway
  const p = await mp('/v1/payments/' + mpId);
  const st = p.status === 'approved' ? 'confirmed' : ['rejected', 'cancelled', 'expired'].includes(p.status) ? 'failed' : 'pending';
  db.prepare("UPDATE donations SET status=?, paid=CASE WHEN ?='confirmed' THEN COALESCE(paid,CURRENT_TIMESTAMP) ELSE paid END WHERE mp_id=?").run(st, st, String(mpId));
  return st;
}
app.post('/api/donate', rateLimit({ windowMs: 60000, max: 10 }), async (q, r) => {
  try {
    const amount = Math.round(Number(q.body.amount) * 100) / 100, name = String(q.body.name || '').slice(0, 60);
    if (!(amount >= 5 && amount <= 50000)) return r.status(400).json({ error: 'Valor deve ser entre R$ 5 e R$ 50.000.' });
    if (MANUAL()) {
      const s = S(); if (!s.pix_key) return r.status(503).json({ error: 'Chave Pix ainda não configurada no painel.' });
      const code = brcode(normKey(s.pix_key), s.pix_name, s.pix_city, amount), id = 'M' + crypto.randomUUID();
      db.prepare('INSERT INTO donations(mp_id,amount,name) VALUES(?,?,?)').run(id, amount, name);
      return r.json({ id, qr: code, qr64: (await QR.toDataURL(code, { margin: 1, width: 440 })).split(',')[1], manual: true });
    }
    const p = await mp('/v1/payments', { method: 'POST', headers: { 'X-Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({
      transaction_amount: amount, description: 'Doação - ' + S().title, payment_method_id: 'pix',
      payer: { email: 'doador@' + new URL(E.BASE_URL).hostname, first_name: name || 'Doador' },
      notification_url: E.BASE_URL + '/api/webhook', date_of_expiration: new Date(Date.now() + 30 * 60000).toISOString().replace('Z', '-00:00') }) });
    db.prepare('INSERT INTO donations(mp_id,amount,name) VALUES(?,?,?)').run(String(p.id), amount, name);
    const t = p.point_of_interaction.transaction_data;
    r.json({ id: p.id, qr: t.qr_code, qr64: t.qr_code_base64, test: isTest() });
  } catch (e) { console.error(e.message); r.status(502).json({ error: 'Não foi possível gerar o Pix agora. Tente novamente.' }); }
});
app.get('/api/donate/:id', async (q, r) => {
  const d = db.prepare('SELECT status FROM donations WHERE mp_id=?').get(q.params.id);
  if (!d) return r.status(404).end();
  if (d.status === 'pending' && !String(q.params.id).startsWith('M')) try { d.status = await sync(q.params.id); } catch {}
  r.json({ status: d.status });
});
app.post('/api/webhook', async (q, r) => {
  try {
    const id = q.body?.data?.id || q.query['data.id'];
    if (E.MP_WEBHOOK_SECRET) { // valida assinatura x-signature
      const sig = Object.fromEntries((q.get('x-signature') || '').split(',').map(s => s.trim().split('=')));
      const mac = crypto.createHmac('sha256', E.MP_WEBHOOK_SECRET).update(`id:${id};request-id:${q.get('x-request-id')};ts:${sig.ts};`).digest('hex');
      if (!sig.v1 || sig.v1.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(sig.v1), Buffer.from(mac))) return r.sendStatus(401);
    }
    if (id && db.prepare('SELECT 1 FROM donations WHERE mp_id=?').get(String(id))) await sync(id);
    r.sendStatus(200);
  } catch (e) { console.error(e.message); r.sendStatus(500); }
});

// ---------- Público ----------
app.get('/api/public', (q, r) => {
  const t = db.prepare("SELECT COALESCE(SUM(amount),0) total, COUNT(*) n FROM donations WHERE status='confirmed'").get();
  const { pix_key, pix_name, pix_city, ...pub } = S();
  r.json({ ...pub, manual: MANUAL(), total: t.total, donors: t.n, test: isTest(),
    media: db.prepare('SELECT id,file,kind,is_main FROM media ORDER BY is_main DESC,pos,id').all(),
    updates: db.prepare('SELECT * FROM updates ORDER BY created DESC,id DESC').all() });
});

// ---------- Admin ----------
const hash = bcrypt.hashSync(E.ADMIN_PASSWORD || crypto.randomUUID(), 10), SECRET = E.JWT_SECRET || crypto.randomBytes(32).toString('hex');
app.post('/api/admin/login', rateLimit({ windowMs: 900000, max: 10 }), (q, r) => {
  if (q.body.user === E.ADMIN_USER && bcrypt.compareSync(String(q.body.password || ''), hash)) {
    r.cookie('adm', jwt.sign({ a: 1 }, SECRET, { expiresIn: '7d' }), { httpOnly: true, sameSite: 'strict', secure: q.secure, maxAge: 6048e5 });
    return r.json({ ok: 1 });
  }
  r.status(401).json({ error: 'Usuário ou senha incorretos.' });
});
const auth = (q, r, n) => { try { jwt.verify(q.cookies.adm, SECRET); n(); } catch { r.status(401).json({ error: 'Sessão expirada.' }); } };
const admin = express.Router(); admin.use(auth); app.use('/api/admin', admin);
admin.get('/me', (q, r) => r.json({ ok: 1 }));
admin.put('/settings', (q, r) => { for (const k of Object.keys(defaults)) if (k in q.body) db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(k, String(q.body[k]).slice(0, 20000)); r.json({ ok: 1 }); });
const ok = { 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'image/heic': 'image', 'video/mp4': 'video', 'video/quicktime': 'video', 'video/webm': 'video' };
const up = multer({ storage: multer.diskStorage({ destination: UP, filename: (q, f, c) => c(null, crypto.randomUUID() + path.extname(f.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')) }), limits: { fileSize: 200 * 1024 * 1024 }, fileFilter: (q, f, c) => c(null, !!ok[f.mimetype]) });
admin.post('/media', up.array('files', 20), (q, r) => {
  for (const f of q.files || []) db.prepare('INSERT INTO media(file,kind,pos) VALUES(?,?,?)').run(f.filename, ok[f.mimetype], Date.now() % 1e9);
  const first = db.prepare("SELECT COUNT(*) c FROM media WHERE is_main=1").get().c; if (!first) db.prepare("UPDATE media SET is_main=1 WHERE id=(SELECT id FROM media WHERE kind='image' ORDER BY id LIMIT 1)").run();
  r.json({ ok: 1 });
});
admin.get('/media', (q, r) => r.json(db.prepare('SELECT * FROM media ORDER BY is_main DESC,pos,id').all()));
admin.post('/media/:id/main', (q, r) => { db.prepare('UPDATE media SET is_main=0').run(); db.prepare("UPDATE media SET is_main=1 WHERE id=? AND kind='image'").run(q.params.id); r.json({ ok: 1 }); });
admin.post('/media/:id/move', (q, r) => { const l = db.prepare('SELECT id FROM media ORDER BY pos,id').all().map(x => x.id), i = l.indexOf(+q.params.id), j = i + (q.body.dir === 'up' ? -1 : 1); if (i > -1 && l[j]) { [l[i], l[j]] = [l[j], l[i]]; l.forEach((id, n) => db.prepare('UPDATE media SET pos=? WHERE id=?').run(n, id)); } r.json({ ok: 1 }); });
admin.delete('/media/:id', (q, r) => { const m = db.prepare('SELECT file FROM media WHERE id=?').get(q.params.id); if (m) { fs.rmSync(path.join(UP, m.file), { force: true }); db.prepare('DELETE FROM media WHERE id=?').run(q.params.id); } r.json({ ok: 1 }); });
admin.post('/updates', (q, r) => { const { section, title, body } = q.body; if (!['treatment', 'accounts'].includes(section) || !title) return r.status(400).json({ error: 'Dados inválidos.' }); db.prepare('INSERT INTO updates(section,title,body) VALUES(?,?,?)').run(section, String(title).slice(0, 200), String(body || '').slice(0, 20000)); r.json({ ok: 1 }); });
admin.delete('/updates/:id', (q, r) => { db.prepare('DELETE FROM updates WHERE id=?').run(q.params.id); r.json({ ok: 1 }); });
admin.get('/donations', (q, r) => r.json({ rows: db.prepare("SELECT id,name,amount,status,created,paid FROM donations ORDER BY id DESC LIMIT 500").all(),
  stats: db.prepare("SELECT COALESCE(SUM(amount),0) total, COUNT(*) n, COALESCE(AVG(amount),0) avg, COALESCE(MAX(amount),0) max FROM donations WHERE status='confirmed'").get() }));
admin.post('/donations/:id/confirm', (q, r) => { db.prepare("UPDATE donations SET status='confirmed', paid=COALESCE(paid,CURRENT_TIMESTAMP) WHERE id=? AND mp_id LIKE 'M%'").run(q.params.id); r.json({ ok: 1 }); });
admin.delete('/donations/:id', (q, r) => { db.prepare("DELETE FROM donations WHERE id=? AND mp_id LIKE 'M%'").run(q.params.id); r.json({ ok: 1 }); });
admin.get('/settings', (q, r) => r.json(S()));
admin.get('/export.csv', (q, r) => { const rows = db.prepare("SELECT paid,name,amount FROM donations WHERE status='confirmed' ORDER BY paid").all(); r.type('text/csv').attachment('doacoes.csv').send('data,doador,valor\n' + rows.map(x => `${x.paid},"${(x.name || 'Anônimo').replace(/"/g, '""')}",${x.amount}`).join('\n')); });

app.listen(E.PORT || 3000, () => console.log('Rodando na porta', E.PORT || 3000, isTest() ? '(MODO DE TESTE)' : ''));
