'use strict';
/*
  Копилка — сервер.

  Без внешних зависимостей: только встроенные модули Node.js (нужен Node 22.13+).
  Что делает:
    1. раздаёт приложение (index.html);
    2. проверяет, что запрос пришёл из Telegram (подпись initData) и определяет пользователя;
    3. хранит данные каждого пользователя отдельно в SQLite;
    4. отвечает в боте на /start кнопкой «Открыть Копилку».

  Переменные окружения:
    BOT_TOKEN   токен бота от @BotFather (обязательно)
    APP_URL     публичный https-адрес приложения, например https://mani.up.railway.app
    DATA_DIR    папка для базы (на хостинге — путь к постоянному диску, например /data)
    PORT        порт (хостинг обычно задаёт сам)
    DISABLE_BOT=1   не запускать бота (только API и сайт)
    DEV=1       разрешить заголовок X-Dev-User для локальных проверок без Telegram
*/

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DEV = process.env.DEV === '1';
const MAX_AGE = Number(process.env.INITDATA_MAX_AGE) || 3 * 24 * 3600; // сколько секунд действует вход
const INDEX_FILE = path.join(__dirname, 'index.html');

const LIMITS = { stateBytes: 3 * 1024 * 1024, imgChars: 900 * 1024, imgPerUser: 30, ratePerMin: 300 };

if (!BOT_TOKEN && !DEV) {
  console.error('Не задана переменная BOT_TOKEN (токен бота от @BotFather). Сервер остановлен.');
  process.exit(1);
}

/* ---------- База данных ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'mani.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, first_name TEXT, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS states (
    user_id INTEGER PRIMARY KEY, rev INTEGER NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS families (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, created_by INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    user_id INTEGER PRIMARY KEY, family_id INTEGER NOT NULL, joined_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS members_family ON members (family_id);
  CREATE TABLE IF NOT EXISTS premium (
    user_id INTEGER PRIMARY KEY, until INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS prefs (
    user_id INTEGER PRIMARY KEY, remind INTEGER NOT NULL DEFAULT 0, hour INTEGER NOT NULL DEFAULT 20,
    tz INTEGER NOT NULL DEFAULT 180, last_sent TEXT NOT NULL DEFAULT '',
    weekly INTEGER NOT NULL DEFAULT 0, last_week TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS refcodes (
    user_id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS referrals (
    user_id INTEGER PRIMARY KEY, referrer_id INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS images (
    user_id INTEGER NOT NULL, goal_id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, goal_id)
  );
`);

const q = {
  upsertUser: db.prepare(`INSERT INTO users (id, first_name, created_at, last_seen) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name, last_seen = excluded.last_seen`),
  getState: db.prepare('SELECT rev, data FROM states WHERE user_id = ?'),
  putState: db.prepare(`INSERT INTO states (user_id, rev, data, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET rev = excluded.rev, data = excluded.data, updated_at = excluded.updated_at`),
  getImages: db.prepare('SELECT goal_id, data FROM images WHERE user_id = ?'),
  imageIds: db.prepare('SELECT goal_id FROM images WHERE user_id = ?'),
  hasImage: db.prepare('SELECT 1 AS x FROM images WHERE user_id = ? AND goal_id = ?'),
  putImage: db.prepare(`INSERT INTO images (user_id, goal_id, data, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, goal_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`),
  delImage: db.prepare('DELETE FROM images WHERE user_id = ? AND goal_id = ?'),
  delImages: db.prepare('DELETE FROM images WHERE user_id = ?'),
  delState: db.prepare('DELETE FROM states WHERE user_id = ?'),
  delUser: db.prepare('DELETE FROM users WHERE id = ?'),
  famOf: db.prepare('SELECT family_id FROM members WHERE user_id = ?'),
  famById: db.prepare('SELECT id, code FROM families WHERE id = ?'),
  famByCode: db.prepare('SELECT id, code FROM families WHERE code = ?'),
  famMembers: db.prepare(`SELECT m.user_id AS id, COALESCE(u.first_name, '') AS name FROM members m
    LEFT JOIN users u ON u.id = m.user_id WHERE m.family_id = ? ORDER BY m.joined_at`),
  famCount: db.prepare('SELECT COUNT(*) AS n FROM members WHERE family_id = ?'),
  insFam: db.prepare('INSERT INTO families (code, created_by, created_at) VALUES (?, ?, ?)'),
  insMember: db.prepare('INSERT INTO members (user_id, family_id, joined_at) VALUES (?, ?, ?)'),
  delMember: db.prepare('DELETE FROM members WHERE user_id = ?'),
  setCode: db.prepare('UPDATE families SET code = ? WHERE id = ?'),
  delFam: db.prepare('DELETE FROM families WHERE id = ?'),
  premiumOf: db.prepare('SELECT until FROM premium WHERE user_id = ?'),
  famPremium: db.prepare(`SELECT MAX(p.until) AS until FROM premium p JOIN members m ON m.user_id = p.user_id WHERE m.family_id = ?`),
  getPrefs: db.prepare('SELECT remind, weekly, hour, tz FROM prefs WHERE user_id = ?'),
  putPrefs: db.prepare(`INSERT INTO prefs (user_id, remind, weekly, hour, tz) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET remind = excluded.remind, weekly = excluded.weekly, hour = excluded.hour, tz = excluded.tz`),
  delPrefs: db.prepare('DELETE FROM prefs WHERE user_id = ?'),
  remindList: db.prepare('SELECT user_id, remind, weekly, hour, tz, last_sent, last_week FROM prefs WHERE remind = 1 OR weekly = 1'),
  refCodeOf: db.prepare('SELECT code FROM refcodes WHERE user_id = ?'),
  refByCode: db.prepare('SELECT user_id FROM refcodes WHERE code = ?'),
  insRefCode: db.prepare('INSERT INTO refcodes (user_id, code) VALUES (?, ?)'),
  referredBy: db.prepare('SELECT referrer_id FROM referrals WHERE user_id = ?'),
  insReferral: db.prepare('INSERT INTO referrals (user_id, referrer_id, created_at) VALUES (?, ?, ?)'),
  refInvited: db.prepare('SELECT COUNT(*) AS n FROM referrals WHERE referrer_id = ?'),
  refPaying: db.prepare(`SELECT COUNT(*) AS n FROM referrals r JOIN premium p ON p.user_id = r.user_id
    WHERE r.referrer_id = ? AND p.until > ?`),
  delRefs: db.prepare('DELETE FROM referrals WHERE user_id = ? OR referrer_id = ?'),
  delRefCode: db.prepare('DELETE FROM refcodes WHERE user_id = ?'),
  markWeek: db.prepare('UPDATE prefs SET last_week = ? WHERE user_id = ?'),
  markSent: db.prepare('UPDATE prefs SET last_sent = ? WHERE user_id = ?'),
};
const FAMILY_MAX = Number(process.env.FAMILY_MAX) || 2;
const FAMILY_PAID = process.env.FAMILY_PAID === '1';   // 1 = семью создаёт только подписчик

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
}

function loadState(uid) {
  const row = q.getState.get(uid);
  if (!row) return { state: null, rev: 0 };
  const state = JSON.parse(row.data);
  const imgs = {};
  for (const r of q.getImages.all(uid)) imgs[r.goal_id] = r.data;
  for (const g of state.goals) g.img = imgs[g.id] || '';
  return { state, rev: row.rev };
}

function validState(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  if (!Array.isArray(s.cats) || !Array.isArray(s.goals) || !Array.isArray(s.ops)) return false;
  if (s.cats.length > 200 || s.goals.length > 50 || s.ops.length > 20000) return false;
  return s.goals.every((g) => g && typeof g === 'object' && typeof g.id === 'string' && g.id.length <= 40);
}

function saveState(uid, body) {
  return tx(() => {
    const cur = q.getState.get(uid);
    const curRev = cur ? cur.rev : 0;
    if (Number(body.rev) !== curRev) return { conflict: true, ...loadState(uid) };
    const state = body.state;
    for (const g of state.goals) delete g.img; // фото хранятся отдельно
    const rev = curRev + 1;
    q.putState.run(uid, rev, JSON.stringify(state), Date.now());
    const alive = new Set(state.goals.map((g) => g.id));
    for (const r of q.imageIds.all(uid)) if (!alive.has(r.goal_id)) q.delImage.run(uid, r.goal_id);
    return { rev };
  });
}

/* ---------- Проверка входа через Telegram ---------- */
const SECRET_KEY = BOT_TOKEN ? crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest() : null;

function sameHex(a, b) {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

function verifyInitData(raw) {
  if (!SECRET_KEY || typeof raw !== 'string' || raw.length > 4096) return null;
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const entries = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const check = (list) => {
    const dcs = list.map(([k, v]) => `${k}=${v}`).join('\n');
    return sameHex(crypto.createHmac('sha256', SECRET_KEY).update(dcs).digest('hex'), hash);
  };
  // поле signature Telegram добавил позже; принимаем подпись с ним и без него
  if (!check(entries) && !check(entries.filter(([k]) => k !== 'signature'))) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE) return { expired: true };
  let user;
  try { user = JSON.parse(params.get('user') || 'null'); } catch (_) { return null; }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) return null;
  return { user: { id: user.id, first_name: String(user.first_name || '').slice(0, 64) } };
}

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, extra });
}

function authenticate(req) {
  if (DEV && req.headers['x-dev-user']) {
    const id = Number(req.headers['x-dev-user']);
    if (Number.isSafeInteger(id) && id > 0) return { id, first_name: 'Dev' + id };
  }
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('tma ')) throw httpError(401, 'unauthorized');
  const r = verifyInitData(h.slice(4));
  if (!r) throw httpError(401, 'unauthorized');
  if (r.expired) throw httpError(401, 'expired');
  return r.user;
}

/* ---------- Вспомогательное ---------- */
const seen = new Map();   // user id -> когда последний раз обновляли last_seen
const rates = new Map();  // user id -> { n, reset }

function touch(user) {
  const t = Date.now();
  if (t - (seen.get(user.id) || 0) > 10 * 60 * 1000) {
    q.upsertUser.run(user.id, user.first_name, t, t);
    seen.set(user.id, t);
  }
}

function rateLimit(uid) {
  const t = Date.now();
  let r = rates.get(uid);
  if (!r || t > r.reset) { r = { n: 0, reset: t + 60000 }; rates.set(uid, r); }
  if (++r.n > LIMITS.ratePerMin) throw httpError(429, 'too many requests');
}
setInterval(() => { const t = Date.now(); for (const [k, v] of rates) if (t > v.reset) rates.delete(k); }, 5 * 60000).unref();

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const text = await readBody(req, limit);
  try { return JSON.parse(text); } catch (_) { throw httpError(400, 'bad json'); }
}

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://telegram.org",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
  ].join('; '));
}


/* ---------- Семья ---------- */
function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  const b = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) c += alphabet[b[i] % alphabet.length];
  return c;
}
function familyIdOf(uid) { const r = q.famOf.get(uid); return r ? r.family_id : 0; }
function hasPremium(uid) { const r = q.premiumOf.get(uid); return !!(r && r.until > Date.now()); }
function familyActive(fid) {
  if (!FAMILY_PAID) return true;
  const r = q.famPremium.get(fid);
  return !!(r && r.until && r.until > Date.now());
}
function familyInfo(uid) {
  const fid = familyIdOf(uid);
  const base = { paid: FAMILY_PAID, premium: hasPremium(uid), max: FAMILY_MAX };
  if (!fid) return { ...base, family: null };
  const f = q.famById.get(fid);
  return { ...base, family: { id: f.id, code: f.code, members: q.famMembers.all(fid), active: familyActive(fid) } };
}
function leaveFamily(uid) {
  return tx(() => {
    const fid = familyIdOf(uid);
    if (!fid) return;
    q.delMember.run(uid);
    if (q.famCount.get(fid).n === 0) {
      const owner = -fid;
      q.delImages.run(owner); q.delState.run(owner); q.delFam.run(fid);
    } else {
      q.setCode.run(newCode(), fid);   // старый код больше не действует
    }
  });
}
// владелец данных: свой id или (для семьи) отрицательный id семьи
function ownerFor(user, url, write) {
  if (url.searchParams.get('scope') !== 'family') return user.id;
  const fid = familyIdOf(user.id);
  if (!fid) throw httpError(403, 'not in family');
  if (write && !familyActive(fid)) throw httpError(402, 'subscription required');
  return -fid;
}


/* ---------- Скидка за друзей ---------- */
function refCode(uid) {
  let r = q.refCodeOf.get(uid);
  if (r) return r.code;
  for (let i = 0; i < 6; i++) {
    const c = newCode();
    try { q.insRefCode.run(uid, c); return c; } catch (_) {}
  }
  throw httpError(500, 'cannot create code');
}
const discountFor = (n) => (n >= 5 ? 50 : n >= 3 ? 20 : n >= 1 ? 10 : 0);   // за 1 друга −10%, за 3 −20%, за 5 −50%
function refInfo(uid) {
  const paying = q.refPaying.get(uid, Date.now()).n;
  return { code: refCode(uid), invited: q.refInvited.get(uid).n, paying, discount: discountFor(paying), referred: !!q.referredBy.get(uid) };
}

/* ---------- API ---------- */
const IMG_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
let BOT_NAME = process.env.BOT_USERNAME || '';

async function handleApi(req, res, url) {
  const user = authenticate(req);
  rateLimit(user.id);
  const p = url.pathname, m = req.method;

  if (p === '/api/state' && m === 'GET') {
    touch(user);
    const owner = ownerFor(user, url, false);
    return json(res, 200, { ...loadState(owner), bot: BOT_NAME });
  }

  if (p === '/api/state' && m === 'PUT') {
    const body = await readJson(req, LIMITS.stateBytes);
    if (!validState(body && body.state)) throw httpError(400, 'bad state');
    touch(user);
    const r = saveState(ownerFor(user, url, true), body);
    if (r.conflict) return json(res, 409, { error: 'conflict', state: r.state, rev: r.rev });
    return json(res, 200, { rev: r.rev });
  }

  const im = p.match(/^\/api\/img\/([\w-]{1,40})$/);
  if (im && m === 'PUT') {
    const body = await readJson(req, LIMITS.imgChars + 1024);
    const img = body && body.img;
    if (typeof img !== 'string' || img.length > LIMITS.imgChars || !IMG_RE.test(img)) throw httpError(400, 'bad image');
    touch(user);
    const owner = ownerFor(user, url, true);
    tx(() => {
      if (!q.hasImage.get(owner, im[1]) && q.imageIds.all(owner).length >= LIMITS.imgPerUser) throw httpError(400, 'too many images');
      q.putImage.run(owner, im[1], img, Date.now());
    });
    return json(res, 200, { ok: true });
  }
  if (im && m === 'DELETE') {
    q.delImage.run(ownerFor(user, url, true), im[1]);
    return json(res, 200, { ok: true });
  }

  /* семья */
  if (p === '/api/family' && m === 'GET') { touch(user); return json(res, 200, familyInfo(user.id)); }
  if (p === '/api/family/create' && m === 'POST') {
    touch(user);
    if (familyIdOf(user.id)) throw httpError(400, 'already in family');
    if (FAMILY_PAID && !hasPremium(user.id)) throw httpError(402, 'subscription required');
    tx(() => {
      let id = 0;
      for (let i = 0; i < 5 && !id; i++) {
        try { id = Number(q.insFam.run(newCode(), user.id, Date.now()).lastInsertRowid); } catch (_) {}
      }
      if (!id) throw httpError(500, 'cannot create');
      q.insMember.run(user.id, id, Date.now());
    });
    return json(res, 200, familyInfo(user.id));
  }
  if (p === '/api/family/join' && m === 'POST') {
    const body = await readJson(req, 2048);
    const code = String((body && body.code) || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    touch(user);
    if (familyIdOf(user.id)) throw httpError(400, 'already in family');
    tx(() => {
      const f = code.length === 8 ? q.famByCode.get(code) : null;
      if (!f) throw httpError(404, 'wrong code');
      if (q.famCount.get(f.id).n >= FAMILY_MAX) throw httpError(409, 'family full');
      q.insMember.run(user.id, f.id, Date.now());
    });
    return json(res, 200, familyInfo(user.id));
  }
  if (p === '/api/family/leave' && m === 'POST') {
    leaveFamily(user.id);
    return json(res, 200, familyInfo(user.id));
  }

  /* скидка за друзей */
  if (p === '/api/ref' && m === 'GET') { touch(user); return json(res, 200, refInfo(user.id)); }
  if (p === '/api/ref/use' && m === 'POST') {
    const body = await readJson(req, 1024);
    const code = String((body && body.code) || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    touch(user);
    if (q.referredBy.get(user.id)) throw httpError(409, 'already used');
    const owner = code.length === 8 ? q.refByCode.get(code) : null;
    if (!owner || owner.user_id === user.id) throw httpError(404, 'wrong code');
    q.insReferral.run(user.id, owner.user_id, Date.now());
    return json(res, 200, refInfo(user.id));
  }

  /* напоминания */
  if (p === '/api/prefs' && m === 'GET') {
    const r = q.getPrefs.get(user.id) || { remind: 0, weekly: 0, hour: 20, tz: 180 };
    return json(res, 200, { remind: !!r.remind, weekly: !!r.weekly, hour: r.hour, tz: r.tz });
  }
  if (p === '/api/prefs' && m === 'PUT') {
    const b = await readJson(req, 1024);
    const hour = Math.min(23, Math.max(0, Math.round(Number(b && b.hour))));
    const tz = Math.min(840, Math.max(-720, Math.round(Number(b && b.tz))));
    touch(user);
    q.putPrefs.run(user.id, b && b.remind ? 1 : 0, b && b.weekly ? 1 : 0, Number.isFinite(hour) ? hour : 20, Number.isFinite(tz) ? tz : 180);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/account' && m === 'DELETE') {
    leaveFamily(user.id);
    tx(() => { q.delImages.run(user.id); q.delState.run(user.id); q.delPrefs.run(user.id); q.delRefs.run(user.id, user.id); q.delRefCode.run(user.id); q.delUser.run(user.id); });
    seen.delete(user.id);
    return json(res, 200, { ok: true });
  }

  throw httpError(404, 'not found');
}

const server = http.createServer(async (req, res) => {
  try {
    securityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(INDEX_FILE));
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('Ошибка:', e);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'server error' : e.message });
    else res.end();
  }
});
server.requestTimeout = 30000;

/* ---------- Бот ---------- */
async function tgApi(method, payload, timeoutMs) {
  const r = await fetch(`${(process.env.TG_API_BASE || 'https://api.telegram.org').replace(/\/$/, '')}/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(timeoutMs || 15000),
  });
  return r.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopping = false;

async function handleUpdate(u) {
  const m = u.message;
  if (!m || !m.chat || m.chat.type !== 'private') return;
  const text = String(m.text || '').trim();
  const name = (m.from && m.from.first_name) || '';
  const msg = text.startsWith('/start')
    ? `Привет${name ? ', ' + name : ''}! 👋\n\nЭто Копилка: считайте расходы, планируйте бюджет и копите на цели.\nНажмите кнопку ниже, чтобы открыть.`
    : 'Нажмите кнопку ниже, чтобы открыть Копилку 👇';
  await tgApi('sendMessage', {
    chat_id: m.chat.id,
    text: msg,
    reply_markup: { inline_keyboard: [[{ text: 'Открыть Копилку', web_app: { url: APP_URL } }]] },
  });
}

async function startBot() {
  /* Telegram с некоторых хостингов бывает недоступен: пробуем снова, пока не получится. */
  let delay = 5000;
  while (!stopping) {
    try {
      const me = await tgApi('getMe');
      if (!me.ok) { console.error('Бот: Telegram не принял токен. Проверьте BOT_TOKEN.'); return; }
      BOT_NAME = me.result.username || BOT_NAME;
      console.log('Бот: @' + BOT_NAME);
      if (!APP_URL) { console.warn('Бот: не задан APP_URL — кнопка открытия приложения не настроена.'); return; }
      await tgApi('deleteWebhook');
      await tgApi('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Открыть', web_app: { url: APP_URL } } });
      await tgApi('setMyCommands', { commands: [{ command: 'start', description: 'Открыть Копилку' }] });
      break;
    } catch (e) {
      console.error('Бот: не удалось подключиться к Telegram (' + e.message + '), повтор через ' + Math.round(delay / 1000) + ' с');
      await sleep(delay);
      delay = Math.min(delay * 2, 300000);
    }
  }
  let offset = 0;
  while (!stopping) {
    try {
      const r = await tgApi('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] }, 65000);
      if (!r.ok) { await sleep(5000); continue; }
      for (const u of r.result) {
        offset = u.update_id + 1;
        handleUpdate(u).catch((e) => console.error('Бот: ошибка ответа:', e.message));
      }
    } catch (_) {
      if (!stopping) await sleep(5000);
    }
  }
}


/* ---------- Напоминания ---------- */
function localParts(tzMin, shiftDays) {
  const d = new Date(Date.now() + tzMin * 60000 - (shiftDays || 0) * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  return { day: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, hour: d.getUTCHours(), dow: d.getUTCDay() };
}
const rub = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';
function openButton() {
  return APP_URL ? { inline_keyboard: [[{ text: 'Открыть Копилку', web_app: { url: APP_URL } }]] } : undefined;
}
function weeklyText(st, tz) {
  const days = new Set();
  for (let i = 1; i <= 7; i++) days.add(localParts(tz, i - 1).day);
  const cats = new Map(st.cats.map((c) => [c.id, c]));
  let spent = 0, earned = 0;
  const byCat = new Map();
  for (const o of st.ops) {
    if (!days.has(o.date)) continue;
    if (o.type === 'expense') { spent += o.amount; byCat.set(o.catId, (byCat.get(o.catId) || 0) + o.amount); }
    else earned += o.amount;
  }
  let saved = 0;
  for (const g of st.goals) for (const c of g.contribs || []) if (days.has(c.date)) saved += c.amount;
  if (!spent && !earned && !saved) return 'Итоги недели: операций не было. Загляните и запишите траты, чтобы видеть картину 👇';
  const top = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0];
  const c = top && cats.get(top[0]);
  let t = `Итоги недели 📊\nПотрачено: ${rub(spent)}`;
  if (c) t += `\nБольше всего: ${c.emoji} ${c.name} — ${rub(top[1])}`;
  if (earned) t += `\nДоход: ${rub(earned)}`;
  if (saved) t += `\nОтложено в цели: ${rub(saved)}`;
  return t;
}
async function sendReminders() {
  if (!BOT_NAME || !BOT_TOKEN) return;
  for (const r of q.remindList.all()) {
    try {
      const lp = localParts(r.tz);
      if (lp.hour < r.hour || lp.hour > r.hour + 3) continue;
      const st = loadState(r.user_id).state;
      if (!st) continue;
      if (r.remind && r.last_sent !== lp.day) {
        q.markSent.run(lp.day, r.user_id);
        const wrote = st.ops.some((o) => o.type === 'expense' && o.date === lp.day);
        if (!wrote) {
          const resp = await tgApi('sendMessage', { chat_id: r.user_id, text: 'Вы ещё не записали траты за сегодня. Это займёт пару секунд 👇', reply_markup: openButton() }, 10000);
          if (!resp.ok) q.markSent.run('', r.user_id);
        }
      }
      if (r.weekly && lp.dow === 1 && r.last_week !== lp.day) {
        q.markWeek.run(lp.day, r.user_id);
        const resp = await tgApi('sendMessage', { chat_id: r.user_id, text: weeklyText(st, r.tz), reply_markup: openButton() }, 10000);
        if (!resp.ok) q.markWeek.run('', r.user_id);
      }
    } catch (_) { q.markSent.run('', r.user_id); q.markWeek.run('', r.user_id); }
  }
}
setInterval(() => { sendReminders().catch(() => {}); }, 10 * 60 * 1000).unref();

/* ---------- Запуск ---------- */
server.listen(PORT, () => {
  console.log(`Копилка запущена на порту ${PORT}. Данные: ${DATA_DIR}`);
  if (BOT_TOKEN && process.env.DISABLE_BOT !== '1') startBot();
});

function shutdown() {
  stopping = true;
  server.close(() => { try { db.close(); } catch (_) {} process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => console.error('Необработанная ошибка:', e));
