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
  CREATE TABLE IF NOT EXISTS payments (
    charge_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, plan TEXT NOT NULL, stars INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS yk_pay (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, plan TEXT NOT NULL, amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS web_sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS web_sessions_user ON web_sessions (user_id);
  CREATE TABLE IF NOT EXISTS images (
    user_id INTEGER NOT NULL, goal_id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, goal_id)
  );
`);
for (const col of ['bills INTEGER NOT NULL DEFAULT 0', 'monthly INTEGER NOT NULL DEFAULT 0', "last_bills TEXT NOT NULL DEFAULT ''", "last_month TEXT NOT NULL DEFAULT ''"]) {
  try { db.exec('ALTER TABLE prefs ADD COLUMN ' + col); } catch (_) { /* колонка уже есть */ }
}

const q = {
  sessIns: db.prepare('INSERT INTO web_sessions (token_hash, user_id, created_at, last_used) VALUES (?, ?, ?, ?)'),
  sessGet: db.prepare("SELECT s.user_id AS id, s.last_used AS last_used, COALESCE(u.first_name, '') AS first_name FROM web_sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?"),
  sessTouch: db.prepare('UPDATE web_sessions SET last_used = ? WHERE token_hash = ?'),
  sessDel: db.prepare('DELETE FROM web_sessions WHERE token_hash = ?'),
  sessDelUser: db.prepare('DELETE FROM web_sessions WHERE user_id = ?'),
  sessExpire: db.prepare('DELETE FROM web_sessions WHERE last_used < ?'),
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
  lastPay: db.prepare('SELECT MAX(created_at) AS t FROM payments WHERE user_id = ?'),
  ykIns: db.prepare('INSERT INTO yk_pay (id, user_id, plan, amount, status, created_at) VALUES (?, ?, ?, ?, \'pending\', ?)'),
  ykGet: db.prepare('SELECT * FROM yk_pay WHERE id = ?'),
  ykSet: db.prepare('UPDATE yk_pay SET status = ? WHERE id = ?'),
  ykPending: db.prepare('SELECT id FROM yk_pay WHERE status = \'pending\' AND created_at > ?'),
  ykExpire: db.prepare('UPDATE yk_pay SET status = \'expired\' WHERE status = \'pending\' AND created_at <= ?'),
  insPayment: db.prepare('INSERT OR IGNORE INTO payments (charge_id, user_id, plan, stars, created_at) VALUES (?, ?, ?, ?, ?)'),
  userCreated: db.prepare('SELECT created_at FROM users WHERE id = ?'),
  putPremium: db.prepare(`INSERT INTO premium (user_id, until) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET until = excluded.until`),
  famPremium: db.prepare(`SELECT MAX(p.until) AS until FROM premium p JOIN members m ON m.user_id = p.user_id WHERE m.family_id = ?`),
  getPrefs: db.prepare('SELECT remind, weekly, bills, monthly, hour, tz FROM prefs WHERE user_id = ?'),
  putPrefs: db.prepare(`INSERT INTO prefs (user_id, remind, weekly, bills, monthly, hour, tz) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET remind = excluded.remind, weekly = excluded.weekly, bills = excluded.bills, monthly = excluded.monthly, hour = excluded.hour, tz = excluded.tz`),
  delPrefs: db.prepare('DELETE FROM prefs WHERE user_id = ?'),
  remindList: db.prepare('SELECT user_id, remind, weekly, bills, monthly, hour, tz, last_sent, last_week, last_bills, last_month FROM prefs WHERE remind = 1 OR weekly = 1 OR bills = 1 OR monthly = 1'),
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
  markBills: db.prepare('UPDATE prefs SET last_bills = ? WHERE user_id = ?'),
  markMonth: db.prepare('UPDATE prefs SET last_month = ? WHERE user_id = ?'),
};
const FAMILY_MAX = Number(process.env.FAMILY_MAX) || 2;
/* Подписка. PAYWALL=1 включает платные функции после пробного периода. */
const PAYWALL = process.env.PAYWALL === '1';
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS) || 14;
const PRICE_MONTH = Number(process.env.PRICE_MONTH) || 99;
const PRICE_YEAR = Number(process.env.PRICE_YEAR) || 790;
const PRICE_LIFE = Number(process.env.PRICE_LIFE) || 1990;     // разовая оплата, подписка навсегда
const OWNER_ID = Number(process.env.OWNER_ID) || 8675855634;      // только он видит статистику
const LIFETIME_UNTIL = 4102444800000;                           // 01.01.2100
const PAY_URL = process.env.PAY_URL || '';                       // ссылка на оплату; {uid} заменится на id пользователя
const SUPPORT_TG = String(process.env.SUPPORT_TG || '').replace(/^@/, '').replace(/[^\w]/g, '');
const STARS_MONTH = Number(process.env.STARS_MONTH) || 75;       // цена в звёздах Telegram
const STARS_YEAR = Number(process.env.STARS_YEAR) || 600;
const STARS_LIFE = Number(process.env.STARS_LIFE) || 1500;
/* Оплата картой/СБП через ЮKassa в Telegram: платёжный токен из @BotFather (Payments → ЮKassa) */
const YK_TOKEN = process.env.YK_TOKEN || '';
/* Оплата СБП / T-Pay / картой на странице ЮKassa (прямое подключение по API): shopId и секретный ключ из кабинета */
const YK_SHOP_ID = process.env.YK_SHOP_ID || '';
const YK_SECRET = process.env.YK_SECRET || '';
const YK_API = (process.env.YK_API_BASE || 'https://api.yookassa.ru/v3').replace(/\/+$/, '');
const YK_ON = !!(YK_SHOP_ID && YK_SECRET);
const PAY_SECRET = process.env.PAY_SECRET || '';                 // секрет для уведомлений об оплате
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
  if (h.startsWith('web ')) {
    const u = webSessionUser(h.slice(4));
    if (!u) throw httpError(401, 'unauthorized');
    return u;
  }
  if (!h.startsWith('tma ')) throw httpError(401, 'unauthorized');
  const r = verifyInitData(h.slice(4));
  if (!r) throw httpError(401, 'unauthorized');
  if (r.expired) throw httpError(401, 'expired');
  return r.user;
}

/* ---------- Вход через Telegram для версии с сайта (PWA) ----------
   Сайт просит ссылку на бота, человек подтверждает вход в боте (там виден код с экрана),
   сайт получает долгий ключ-сессию. Ключ хранится на сервере только в виде хеша. */
const WEB_TTL = 120 * 86400000;   // сессия живёт 120 дней с последнего использования
const LOGIN_TTL = 5 * 60000;      // ссылка для входа действует 5 минут
const webLogins = new Map();      // публичный id -> { secretHash, code, created, state, uid, name }
const loginHits = new Map();      // ip -> { n, reset }
const sha256hex = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

function webSessionUser(token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  const h = sha256hex(token), row = q.sessGet.get(h);
  if (!row) return null;
  const t = Date.now();
  if (t - row.last_used > WEB_TTL) { q.sessDel.run(h); return null; }
  if (t - row.last_used > 86400000) q.sessTouch.run(t, h);
  return { id: row.id, first_name: String(row.first_name || '').slice(0, 64) };
}
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return xf.length ? xf[xf.length - 1] : String(req.socket.remoteAddress || '');
}
function loginLimit(req, kind, max) {
  const k = kind + ':' + clientIp(req), t = Date.now();
  let r = loginHits.get(k);
  if (!r || t > r.reset) { r = { n: 0, reset: t + 10 * 60000 }; loginHits.set(k, r); }
  if (++r.n > max) throw httpError(429, 'too many requests');
}
function gcLogins() {
  const t = Date.now();
  for (const [id, e] of webLogins) if (t - e.created > LOGIN_TTL) webLogins.delete(id);
  for (const [k, r] of loginHits) if (t > r.reset) loginHits.delete(k);
}
setInterval(() => { gcLogins(); try { q.sessExpire.run(Date.now() - WEB_TTL); } catch (_) {} }, 60000).unref();
function liveLogin(id) {
  const e = webLogins.get(String(id));
  if (!e) return null;
  if (Date.now() - e.created > LOGIN_TTL) { webLogins.delete(String(id)); return null; }
  return e;
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
const PLAN_TAIL = ': несколько целей, семья, регулярные платежи, экспорт и напоминания';
function parsePlan(v) { return v === 'life' || v === 'year' || v === 'month' ? v : ''; }
const RATES_URL = process.env.RATES_URL || 'https://www.cbr-xml-daily.ru/daily_json.js';
let ratesCache = { at: 0, rates: null, date: '' };
async function getRates() {
  if (ratesCache.rates && Date.now() - ratesCache.at < 6 * 3600000) return ratesCache;
  try {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(RATES_URL, { signal: ctl.signal }); clearTimeout(tm);
    const j = JSON.parse(await r.text()), rates = {};
    for (const [code, v] of Object.entries(j.Valute || {})) if (CUR_SYM[code] && v && v.Value > 0 && v.Nominal > 0) rates[code] = v.Value / v.Nominal;
    if (Object.keys(rates).length) ratesCache = { at: Date.now(), rates, date: String(j.Date || '') };
  } catch (_) { /* отдадим прошлый курс, если он есть */ }
  return ratesCache;
}
function planMeta(plan, info) {
  if (plan === 'life') return { title: 'Копилка навсегда', description: 'Пожизненная подписка' + PLAN_TAIL, label: 'Навсегда', stars: info.starsLife, rub: info.priceLife };
  if (plan === 'year') return { title: 'Копилка на год', description: 'Подписка на 12 месяцев' + PLAN_TAIL, label: 'Год', stars: info.starsYear, rub: info.priceYear };
  return { title: 'Копилка на месяц', description: 'Подписка на 30 дней' + PLAN_TAIL, label: 'Месяц', stars: info.starsMonth, rub: info.priceMonth };
}
/* status: trial — пробный период, premium — оплачено, free — пробный закончился, платные функции закрыты */
function planInfo(uid) {
  const now = Date.now(), DAY = 86400000;
  const pr = q.premiumOf.get(uid);
  const u = q.userCreated.get(uid);
  const trialEnd = (u ? u.created_at : now) + TRIAL_DAYS * DAY;
  let status = 'trial', until = trialEnd;
  if (pr && pr.until > now) { status = 'premium'; until = pr.until; }
  else if (PAYWALL && trialEnd <= now) status = 'free';
  const disc = discountFor(q.refPaying.get(uid, now).n);
  const k = (100 - disc) / 100;
  return {
    status, until, daysLeft: Math.max(0, Math.ceil((until - now) / DAY)),
    locked: status === 'free', paywall: PAYWALL, lastPaid: (q.lastPay.get(uid) || {}).t || 0,
    priceMonth: Math.round(PRICE_MONTH * k), priceYear: Math.round(PRICE_YEAR * k), priceLife: Math.round(PRICE_LIFE * k),
    fullMonth: PRICE_MONTH, fullYear: PRICE_YEAR, fullLife: PRICE_LIFE, discount: disc,
    pay: PAY_URL ? PAY_URL.replace('{uid}', String(uid)) : '', support: SUPPORT_TG,
    owner: uid === OWNER_ID,
    card: !!(BOT_TOKEN && BOT_NAME && YK_TOKEN), sbp: YK_ON, stars: !!(BOT_TOKEN && BOT_NAME), starsMonth: Math.round(STARS_MONTH * k), starsYear: Math.round(STARS_YEAR * k), starsLife: Math.round(STARS_LIFE * k),
  };
}

/* статистика для владельца: без личных данных, только числа */
function ownerStats() {
  const now = Date.now(), DAY = 86400000, MSK = 3 * 3600000;
  const dayKey = (t) => new Date(t + MSK).toISOString().slice(5, 10);
  const users = db.prepare('SELECT id, created_at, last_seen FROM users WHERE id != ?').all(OWNER_ID);
  const cnt = (f) => users.filter(f).length;
  const prem = new Map(db.prepare('SELECT user_id, until FROM premium WHERE user_id != ?').all(OWNER_ID).map((r) => [r.user_id, r.until]));
  const pays = db.prepare('SELECT charge_id, user_id, plan, stars AS amt, created_at FROM payments WHERE user_id != ?').all(OWNER_ID).map((p) => {
    const yk = String(p.charge_id).startsWith('yk:');
    const stars = !yk && p.amt < 5000;
    return { uid: p.user_id, plan: p.plan, t: p.created_at, stars, rub: stars ? 0 : (yk ? p.amt : p.amt / 100), st: stars ? p.amt : 0 };
  });
  let withOps = 0;
  for (const r of db.prepare('SELECT user_id, data FROM states WHERE user_id != ?').all(OWNER_ID)) {
    try { const d = JSON.parse(r.data); if (d && Array.isArray(d.ops) && d.ops.length) withOps++; } catch (e) { /* ignore */ }
  }
  const old3 = users.filter((u) => now - u.created_at >= 3 * DAY), old7 = users.filter((u) => now - u.created_at >= 7 * DAY);
  const back = (list, d) => list.filter((u) => u.last_seen - u.created_at >= d * DAY).length;
  const payers = new Set(pays.map((p) => p.uid));
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const t0 = now - i * DAY, k = dayKey(t0);
    days.push({ d: k, users: users.filter((u) => dayKey(u.created_at) === k).length, rub: Math.round(pays.filter((p) => dayKey(p.t) === k).reduce((a, p) => a + p.rub, 0)) });
  }
  const sumRub = (since) => Math.round(pays.filter((p) => p.t >= since).reduce((a, p) => a + p.rub, 0));
  return {
    users: users.length, new1: cnt((u) => now - u.created_at < DAY), new7: cnt((u) => now - u.created_at < 7 * DAY), new30: cnt((u) => now - u.created_at < 30 * DAY),
    active1: cnt((u) => now - u.last_seen < DAY), active7: cnt((u) => now - u.last_seen < 7 * DAY),
    withOps, back3: old3.length ? Math.round(100 * back(old3, 2) / old3.length) : null, back7: old7.length ? Math.round(100 * back(old7, 6) / old7.length) : null,
    trial: users.filter((u) => now - u.created_at < TRIAL_DAYS * DAY && !(prem.get(u.id) > now)).length,
    premium: [...prem.values()].filter((v) => v > now).length, payers: payers.size,
    conv: users.length ? Math.round(1000 * payers.size / users.length) / 10 : 0,
    payCount: pays.length, rubTotal: sumRub(0), rub7: sumRub(now - 7 * DAY), rub30: sumRub(now - 30 * DAY),
    starsTotal: pays.reduce((a, p) => a + p.st, 0),
    byPlan: { month: pays.filter((p) => p.plan === 'month').length, year: pays.filter((p) => p.plan === 'year').length, life: pays.filter((p) => p.plan === 'life').length },
    days,
  };
}
function grantPremium(uid, days) {
  return tx(() => {
    const cur = q.premiumOf.get(uid);
    const base = Math.max(Date.now(), cur ? cur.until : 0);
    const until = base + days * 86400000;
    q.putPremium.run(uid, until);
    return until;
  });
}
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
  if (url.pathname === '/api/yk/webhook' && req.method === 'POST') {
    /* уведомление ЮKassa: ему не верим на слово, а перепроверяем платёж запросом в ЮKassa */
    const body = await readJson(req, 16384).catch(() => null);
    const id = body && body.object && typeof body.object.id === 'string' ? body.object.id : '';
    if (id && YK_ON) await ykCheck(id).catch((e) => console.error('ЮKassa webhook:', e.message));
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/web/login/start' && req.method === 'POST') {
    if (!BOT_TOKEN || !BOT_NAME) throw httpError(503, 'login unavailable');
    loginLimit(req, 'start', 20);
    gcLogins();
    if (webLogins.size >= 3000) throw httpError(429, 'too many requests');
    const id = crypto.randomBytes(8).toString('hex'), secret = crypto.randomBytes(16).toString('hex');
    const code = String(1000 + crypto.randomInt(9000));
    webLogins.set(id, { secretHash: sha256hex(secret), code, created: Date.now(), state: 'pending', uid: 0, name: '' });
    return json(res, 200, { id, secret, code, link: 'https://t.me/' + BOT_NAME + '?start=wl_' + id, ttl: LOGIN_TTL / 1000 });
  }
  if (url.pathname === '/api/web/login/poll' && req.method === 'POST') {
    loginLimit(req, 'poll', 600);
    const b = await readJson(req, 512);
    const id = String(b && b.id || ''), e = liveLogin(id);
    const given = Buffer.from(sha256hex(String(b && b.secret || ''))), want = e ? Buffer.from(e.secretHash) : null;
    if (!e || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return json(res, 200, { status: 'expired' });
    if (e.state === 'pending') return json(res, 200, { status: 'pending' });
    webLogins.delete(id);
    if (e.state !== 'ok' || !(e.uid > 0)) return json(res, 200, { status: 'denied' });
    const token = crypto.randomBytes(32).toString('hex'), t = Date.now();
    q.upsertUser.run(e.uid, e.name, t, t);
    q.sessIns.run(sha256hex(token), e.uid, t, t);
    return json(res, 200, { status: 'ok', token, user: { id: e.uid, first_name: e.name } });
  }
  if (DEV && url.pathname === '/api/dev/update' && req.method === 'POST') {
    /* только для проверок: имитирует сообщение от Telegram */
    handleUpdate(await readJson(req, 8192)).catch(() => {});
    return json(res, 200, { ok: true });
  }
  const user = authenticate(req);
  rateLimit(user.id);
  const p = url.pathname, m = req.method;

  if (p === '/api/web/logout' && m === 'POST') {
    const h = String(req.headers.authorization || '');
    if (h.startsWith('web ')) q.sessDel.run(sha256hex(h.slice(4)));
    return json(res, 200, { ok: true });
  }

  if (p === '/api/pay/stars' && m === 'POST') {
    const body = await readJson(req, 1024);
    const plan = parsePlan(body && body.plan);
    if (!plan) throw httpError(400, 'bad plan');
    if (!BOT_TOKEN || !BOT_NAME) throw httpError(503, 'payments unavailable');
    touch(user);
    const pm = planMeta(plan, planInfo(user.id));
    const r = await tgApi('createInvoiceLink', {
      title: pm.title, description: pm.description, payload: plan + '|' + user.id,
      currency: 'XTR', prices: [{ label: pm.label, amount: pm.stars }],
    }, 10000).catch(() => null);
    if (!r || !r.ok || typeof r.result !== 'string') throw httpError(502, 'telegram error');
    return json(res, 200, { link: r.result, stars: pm.stars });
  }

  if (p === '/api/pay/card' && m === 'POST') {
    const body = await readJson(req, 1024);
    const plan = parsePlan(body && body.plan);
    if (!plan) throw httpError(400, 'bad plan');
    if (!BOT_TOKEN || !BOT_NAME || !YK_TOKEN) throw httpError(503, 'card payments unavailable');
    touch(user);
    const pm = planMeta(plan, planInfo(user.id));
    const r = await tgApi('createInvoiceLink', {
      title: pm.title, description: pm.description, payload: plan + '|' + user.id,
      provider_token: YK_TOKEN, currency: 'RUB', prices: [{ label: pm.label, amount: pm.rub * 100 }],
    }, 10000).catch(() => null);
    if (!r || !r.ok || typeof r.result !== 'string') throw httpError(502, 'telegram error');
    return json(res, 200, { link: r.result, rub: pm.rub });
  }

  if (p === '/api/pay/sbp' && m === 'POST') {
    const body = await readJson(req, 1024);
    const plan = parsePlan(body && body.plan);
    if (!plan) throw httpError(400, 'bad plan');
    if (!YK_ON) throw httpError(503, 'sbp unavailable');
    touch(user);
    const pm = planMeta(plan, planInfo(user.id));
    const r = await ykApi('POST', '/payments', {
      amount: { value: pm.rub + '.00', currency: 'RUB' }, capture: true,
      confirmation: { type: 'redirect', return_url: BOT_NAME ? 'https://t.me/' + BOT_NAME : (APP_URL || 'https://t.me') },
      description: (pm.title + ' (id ' + user.id + ')').slice(0, 128),
      metadata: { uid: String(user.id), plan },
    }, crypto.randomUUID()).catch((e) => { console.error('ЮKassa: создание платежа:', e.message); return null; });
    const link = r && r.confirmation && r.confirmation.confirmation_url;
    if (!r || !r.id || !link) throw httpError(502, 'yookassa error');
    q.ykIns.run(String(r.id), user.id, plan, pm.rub, Date.now());
    return json(res, 200, { url: link, rub: pm.rub });
  }

  if (DEV && p === '/api/dev/reminders' && m === 'POST') { await sendReminders(true); return json(res, 200, { ok: true }); }

  if (p === '/api/rates' && m === 'GET') {
    const c = await getRates();
    return json(res, 200, { rates: c.rates, date: c.date });
  }

  if (p === '/api/admin/stats' && m === 'GET') { if (user.id !== OWNER_ID) throw httpError(403, 'forbidden'); return json(res, 200, ownerStats()); }
  if (p === '/api/plan' && m === 'GET') { touch(user); return json(res, 200, planInfo(user.id)); }

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
    const r = q.getPrefs.get(user.id) || { remind: 0, weekly: 0, bills: 0, monthly: 0, hour: 20, tz: 180 };
    return json(res, 200, { remind: !!r.remind, weekly: !!r.weekly, bills: !!r.bills, monthly: !!r.monthly, hour: r.hour, tz: r.tz });
  }
  if (p === '/api/prefs' && m === 'PUT') {
    const b = await readJson(req, 1024);
    const hour = Math.min(23, Math.max(0, Math.round(Number(b && b.hour))));
    const tz = Math.min(840, Math.max(-720, Math.round(Number(b && b.tz))));
    touch(user);
    q.putPrefs.run(user.id, b && b.remind ? 1 : 0, b && b.weekly ? 1 : 0, b && b.bills ? 1 : 0, b && b.monthly ? 1 : 0, Number.isFinite(hour) ? hour : 20, Number.isFinite(tz) ? tz : 180);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/account' && m === 'DELETE') {
    leaveFamily(user.id);
    tx(() => { q.delImages.run(user.id); q.delState.run(user.id); q.delPrefs.run(user.id); q.delRefs.run(user.id, user.id); q.delRefCode.run(user.id); q.sessDelUser.run(user.id); q.delUser.run(user.id); });
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
    if (req.method === 'GET' && (url.pathname === '/manifest.webmanifest' || url.pathname === '/sw.js' || /^\/pwa\/[a-z0-9-]+\.png$/.test(url.pathname))) {
      /* файлы установки на экран «Домой» (PWA): манифест, service worker, иконки */
      const name = url.pathname === '/sw.js' ? 'sw.js' : url.pathname === '/manifest.webmanifest' ? 'manifest.webmanifest' : url.pathname.slice(5);
      const f = path.join(__dirname, 'pwa', name);
      if (!fs.existsSync(f)) throw httpError(404, 'not found');
      const type = name.endsWith('.png') ? 'image/png' : name.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'application/manifest+json; charset=utf-8';
      const headers = { 'Content-Type': type, 'Cache-Control': name.endsWith('.png') ? 'public, max-age=86400' : 'no-cache' };
      if (name === 'sw.js') headers['Service-Worker-Allowed'] = '/';
      res.writeHead(200, headers);
      return res.end(fs.readFileSync(f));
    }
    if (req.method === 'POST' && url.pathname === '/api/pay/webhook') {
      /* Платёжный сервис присылает {"user_id": 123, "days": 30}; в адресе или заголовке x-secret — PAY_SECRET */
      const given = Buffer.from(String(url.searchParams.get('secret') || req.headers['x-secret'] || ''));
      const want = Buffer.from(PAY_SECRET);
      if (!PAY_SECRET || given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw httpError(403, 'forbidden');
      const b = await readJson(req, 4096);
      const uid = Number(b && b.user_id), days = Number(b && b.days);
      if (!Number.isInteger(uid) || uid <= 0 || !(days > 0 && days <= 400)) throw httpError(400, 'bad payload');
      return json(res, 200, { until: grantPremium(uid, Math.round(days)) });
    }
    if (req.method === 'GET' && (url.pathname === '/privacy' || url.pathname === '/terms')) {
      const f = path.join(__dirname, url.pathname.slice(1) + '.html');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      const who = SUPPORT_TG ? `<a href="https://t.me/${SUPPORT_TG}">@${SUPPORT_TG}</a> в Telegram` : 'через бота в Telegram';
      return res.end(fs.readFileSync(f, 'utf8').replace(/\{\{SUPPORT\}\}/g, who));
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

/* Быстрый ввод: «кофе 250», «такси 300», «+5000 зарплата» */
const KEYWORDS = [
  [/кофе|обед|ужин|завтрак|пицц|продукт|магазин|супермаркет|еда|кафе|ресторан|доставк|перекус|вкусня/i, ['еда', 'продукт', 'кафе']],
  [/такси|метро|автобус|бензин|заправк|проезд|парков|транспорт|маршрутк/i, ['транспорт', 'такси', 'авто']],
  [/жкх|свет|электр|вода|газ|квартплат|коммунал|интернет|связь/i, ['жкх', 'связь']],
  [/аренд|ипотек|жиль|квартир/i, ['жиль']],
  [/кино|театр|концерт|бар|клуб|игр|развлеч|отдых/i, ['отдых', 'развлеч']],
  [/аптек|врач|лекарств|стоматолог|здоров/i, ['здоров']],
  [/одежд|обув|куртк|кроссовк/i, ['одежд']],
  [/кредит|рассрочк/i, ['кредит']],
];
function parseQuick(text) {
  let t = String(text || '').trim();
  if (!t || t.startsWith('/') || t.length > 120) return null;
  let income = false;
  if (/^\+/.test(t)) { income = true; t = t.slice(1).trim(); }
  else if (/^(доход|зарплата|зп|аванс)\b/i.test(t)) income = true;
  const m = t.match(/(\d[\d\s]*(?:[.,]\d{1,2})?)\s*(?:₽|руб\w*|р\b)?\s*$/i) || t.match(/^\s*(\d[\d\s]*(?:[.,]\d{1,2})?)\s*(?:₽|руб\w*|р\b)?/i);
  if (!m) return null;
  const amount = Number(m[1].replace(/\s/g, '').replace(',', '.'));
  if (!isFinite(amount) || amount <= 0 || amount >= 1e9) return null;
  const note = t.replace(m[0], '').replace(/[₽]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return { income, amount, note };
}
function guessCat(cats, note) {
  const low = note.toLowerCase();
  if (!low) return null;
  for (const c of cats) {
    for (const w of c.name.toLowerCase().split(/[^а-яa-z0-9ё]+/).filter((x) => x.length >= 4)) {
      if (low.includes(w.slice(0, 4))) return c;
    }
  }
  for (const [re, names] of KEYWORDS) {
    if (!re.test(low)) continue;
    for (const n of names) { const c = cats.find((x) => x.name.toLowerCase().includes(n)); if (c) return c; }
  }
  return null;
}
function addQuickOp(uid, op) {
  for (let i = 0; i < 4; i++) {
    const cur = loadState(uid);
    if (!cur.state) return false;     // человек ещё не открывал приложение
    const st = cur.state;
    const id = crypto.randomBytes(4).toString('hex');
    st.ops.push({ id, type: op.income ? 'income' : 'expense', amount: op.amount,
      catId: op.income ? '' : op.catId, note: op.note || '', date: op.date, t: Date.now(), by: uid });
    const r = saveState(uid, { rev: cur.rev, state: st });
    if (!r.conflict) return id;
  }
  return null;
}
function removeQuickOp(uid, opId) {
  for (let i = 0; i < 4; i++) {
    const cur = loadState(uid);
    if (!cur.state) return false;
    const n = cur.state.ops.length;
    cur.state.ops = cur.state.ops.filter((o) => o.id !== opId);
    if (cur.state.ops.length === n) return false;
    const r = saveState(uid, { rev: cur.rev, state: cur.state });
    if (!r.conflict) return true;
  }
  return false;
}
/* ответ после записи: что записано и сколько осталось по категории */
function doneText(uid, op, cat) {
  const st = loadState(uid).state;
  const rubFmt = (n) => money(n, st);
  if (op.income) return `✅ Доход ${rubFmt(op.amount)} записан`;
  const month = op.date.slice(0, 7);
  const spent = st ? st.ops.filter((o) => o.type === 'expense' && o.catId === cat.id && o.date.slice(0, 7) === month).reduce((a, o) => a + o.amount, 0) : 0;
  let t = `✅ Записано: ${rubFmt(op.amount)} — ${cat.name}${op.note ? ' (' + op.note + ')' : ''}`;
  if (cat.limit > 0) {
    const left = cat.limit - spent;
    t += left >= 0 ? `\nОсталось по «${cat.name}» в этом месяце: ${rubFmt(left)}` : `\n⚠️ Лимит по «${cat.name}» превышен на ${rubFmt(-left)}`;
  } else t += `\nВсего по «${cat.name}» за месяц: ${rubFmt(spent)}`;
  return t;
}
const undoButton = (id) => ({ inline_keyboard: [[{ text: 'Отменить', callback_data: 'u|' + id }]] });
const pendingQuick = new Map();   // короткий ключ -> { uid, op, exp }
function localDay(uid) {
  const pr = q.getPrefs.get(uid);
  return localParts(pr ? pr.tz : 180).day;
}
async function handleQuick(m, text) {
  const pq = parseQuick(text);
  if (!pq) return false;
  const uid = m.from.id;
  const cur = loadState(uid);
  if (!cur.state) {
    await tgApi('sendMessage', { chat_id: m.chat.id, text: 'Сначала откройте Копилку один раз, чтобы создать бюджет 👇', reply_markup: openButton() });
    return true;
  }
  const date = localDay(uid);
  const op = { income: pq.income, amount: pq.amount, note: pq.note, date, catId: '' };
  if (pq.income) {
    const id = addQuickOp(uid, op);
    await tgApi('sendMessage', { chat_id: m.chat.id, text: doneText(uid, op), reply_markup: id ? undoButton(id) : undefined });
    return true;
  }
  const cat = guessCat(cur.state.cats, pq.note);
  if (cat) {
    op.catId = cat.id;
    const id = addQuickOp(uid, op);
    await tgApi('sendMessage', { chat_id: m.chat.id, text: id ? doneText(uid, op, cat) : 'Не удалось записать, попробуйте ещё раз', reply_markup: id ? undoButton(id) : undefined });
    return true;
  }
  const key = crypto.randomBytes(4).toString('hex');
  pendingQuick.set(key, { uid, op, exp: Date.now() + 3600000 });
  for (const [k, v] of pendingQuick) if (v.exp < Date.now()) pendingQuick.delete(k);
  const rows = [];
  const cats = cur.state.cats.slice(0, 12);
  for (let i = 0; i < cats.length; i += 2) rows.push(cats.slice(i, i + 2).map((c) => ({ text: c.name.slice(0, 24), callback_data: `q|${key}|${c.id}` })));
  await tgApi('sendMessage', { chat_id: m.chat.id, text: `${money(pq.amount, cur.state)}${pq.note ? ' — ' + pq.note : ''}\nВ какую категорию записать?`, reply_markup: { inline_keyboard: rows } });
  return true;
}
/* Подписка в чате: цены и кнопки оформления; счёт открывается прямо в Telegram */
const STAR_PLANS_ON = () => !!(BOT_TOKEN && BOT_NAME);
function plansMessage(uid) {
  const info = planInfo(uid), card = !!YK_TOKEN, st = STAR_PLANS_ON();
  const row = (name, rub, stars) => `• ${name} — ${rub} ₽` + (st ? ` (или ⭐ ${stars})` : '');
  const lines = [
    '⭐ Подписка Копилки',
    '',
    'Несколько целей, семейный бюджет, регулярные платежи, экспорт и напоминания.',
    '',
    row('Месяц', info.priceMonth, info.starsMonth),
    row('Год', info.priceYear, info.starsYear) + ' — выгоднее',
    row('Навсегда', info.priceLife, info.starsLife) + ' — разовый платёж',
    '',
    `Первые ${TRIAL_DAYS} дней бесплатно. Подписка включается сразу после оплаты.`,
  ];
  const kb = [];
  if (card) {
    kb.push([{ text: `Месяц — ${info.priceMonth} ₽`, callback_data: 'b|month|card' }, { text: `Год — ${info.priceYear} ₽`, callback_data: 'b|year|card' }]);
    kb.push([{ text: `Навсегда — ${info.priceLife} ₽`, callback_data: 'b|life|card' }]);
  }
  kb.push([{ text: `⭐ Месяц — ${info.starsMonth}`, callback_data: 'b|month|stars' }, { text: `⭐ Год — ${info.starsYear}`, callback_data: 'b|year|stars' }]);
  kb.push([{ text: `⭐ Навсегда — ${info.starsLife}`, callback_data: 'b|life|stars' }]);
  if (APP_URL) kb.push([{ text: 'Открыть Копилку', web_app: { url: APP_URL } }]);
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: kb } };
}
async function sendPlanInvoice(chatId, uid, plan, method) {
  const pm = planMeta(plan, planInfo(uid)), card = method === 'card' && !!YK_TOKEN;
  const body = { chat_id: chatId, title: pm.title, description: pm.description, payload: plan + '|' + uid };
  if (card) Object.assign(body, { provider_token: YK_TOKEN, currency: 'RUB', prices: [{ label: pm.label, amount: pm.rub * 100 }] });
  else Object.assign(body, { currency: 'XTR', prices: [{ label: pm.label, amount: pm.stars }] });
  return tgApi('sendInvoice', body, 10000);
}
async function handleCallback(cb) {
  const parts = String(cb.data || '').split('|');
  if (parts[0] === 'wl' && cb.message && cb.from) {
    const e = liveLogin(parts[2]);
    if (!e || e.state !== 'pending') {
      await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Ссылка устарела. Нажмите «Войти» в приложении ещё раз.' });
      return;
    }
    if (parts[1] === 'y') { e.state = 'ok'; e.uid = cb.from.id; e.name = String(cb.from.first_name || '').slice(0, 64); }
    else e.state = 'denied';
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: parts[1] === 'y' ? '✅ Вход подтверждён. Возвращайтесь в приложение.' : 'Вход отменён.' });
    return;
  }
  if (parts[0] === 'pl' && cb.message) {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await tgApi('sendMessage', { chat_id: cb.message.chat.id, ...plansMessage(cb.from.id) });
    return;
  }
  if (parts[0] === 'b' && cb.message && parsePlan(parts[1])) {
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id });
    await sendPlanInvoice(cb.message.chat.id, cb.from.id, parts[1], parts[2]).catch(() => {});
    return;
  }
  if (parts[0] === 'u' && cb.message) {
    const done = removeQuickOp(cb.from.id, parts[1]);
    await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: done ? 'Отменено' : 'Уже отменено или удалено' });
    if (done) await tgApi('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: '↩️ Запись отменена' });
    return;
  }
  if (parts[0] !== 'q' || !cb.message) return tgApi('answerCallbackQuery', { callback_query_id: cb.id });
  const pend = pendingQuick.get(parts[1]);
  if (!pend || pend.uid !== cb.from.id) return tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Время вышло, отправьте трату ещё раз' });
  pendingQuick.delete(parts[1]);
  const cur = loadState(pend.uid);
  const cat = cur.state && cur.state.cats.find((c) => c.id === parts[2]);
  if (!cat) return tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Категория не найдена' });
  pend.op.catId = cat.id;
  const nid = addQuickOp(pend.uid, pend.op);
  await tgApi('answerCallbackQuery', { callback_query_id: cb.id, text: nid ? 'Записано' : 'Не удалось записать' });
  if (nid) await tgApi('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: doneText(pend.uid, pend.op, cat), reply_markup: undoButton(nid) });
}
/* Оплата звёздами: Telegram сначала спрашивает подтверждение, потом присылает successful_payment */
function parsePayload(str) {
  const m = String(str || '').match(/^(month|year|life)\|(\d{1,15})$/);
  return m ? { plan: m[1], uid: Number(m[2]) } : null;
}
async function handlePreCheckout(pq) {
  const pl = parsePayload(pq.invoice_payload);
  let good = !!(pl && pl.uid === pq.from.id);
  if (good && pq.currency === 'RUB') {
    const info = planInfo(pl.uid);
    good = !!YK_TOKEN && Number(pq.total_amount) === planMeta(pl.plan, info).rub * 100;
  } else if (good) good = pq.currency === 'XTR';
  await tgApi('answerPreCheckoutQuery', good ? { pre_checkout_query_id: pq.id, ok: true } : { pre_checkout_query_id: pq.id, ok: false, error_message: 'Не удалось подтвердить оплату, попробуйте ещё раз' });
}
/* запись о платеже и продление подписки — одной операцией: либо оба, либо ни одного */
function applyPlanPayment(uid, plan, chargeId, amount) {
  return tx(() => {
    const ins = q.insPayment.run(String(chargeId), uid, plan, Number(amount) || 0, Date.now());
    if (!ins.changes) return 0;   // этот платёж уже учтён
    const cur = q.premiumOf.get(uid);
    const end = plan === 'life' ? LIFETIME_UNTIL : Math.max(Date.now(), cur ? cur.until : 0) + (plan === 'year' ? 365 : 30) * 86400000;
    q.putPremium.run(uid, end);
    return end;
  });
}
function paidText(plan, until) {
  const d = new Date(until + 3 * 3600000), pad = (n) => String(n).padStart(2, '0');
  return plan === 'life' ? '✅ Оплата получена, спасибо! Подписка активна навсегда 🎉' : `✅ Оплата получена, спасибо! Подписка активна до ${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}.`;
}
async function handlePayment(m) {
  const sp = m.successful_payment, pl = parsePayload(sp.invoice_payload);
  if (!pl || pl.uid !== m.from.id) { console.error('Оплата: неожиданные данные', sp.telegram_payment_charge_id); return; }
  const until = applyPlanPayment(pl.uid, pl.plan, sp.telegram_payment_charge_id, sp.total_amount);
  if (!until) return;
  await tgApi('sendMessage', { chat_id: m.chat.id, text: paidText(pl.plan, until), reply_markup: openButton() });
}
/* ЮKassa по API: запрос в ЮKassa и проверка платежа */
async function ykApi(method, path, body, idem) {
  const headers = { Authorization: 'Basic ' + Buffer.from(YK_SHOP_ID + ':' + YK_SECRET).toString('base64'), 'Content-Type': 'application/json' };
  if (idem) headers['Idempotence-Key'] = idem;
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(YK_API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('HTTP ' + r.status + (j && j.description ? ' ' + j.description : ''));
    return j;
  } finally { clearTimeout(tm); }
}
async function ykCheck(id) {
  const row = q.ykGet.get(id);
  if (!row || row.status !== 'pending') return;
  const r = await ykApi('GET', '/payments/' + encodeURIComponent(id));
  if (r.status === 'canceled') { q.ykSet.run('canceled', id); return; }
  if (r.status !== 'succeeded' || r.paid !== true) return;
  if (!r.amount || r.amount.currency !== 'RUB' || Number(r.amount.value) !== row.amount) { console.error('ЮKassa: сумма не совпала', id); q.ykSet.run('mismatch', id); return; }
  const until = applyPlanPayment(row.user_id, row.plan, 'yk:' + id, row.amount);
  q.ykSet.run('done', id);
  if (until) await tgApi('sendMessage', { chat_id: row.user_id, text: paidText(row.plan, until), reply_markup: openButton() }).catch(() => {});
}
function startYkPolling() {
  if (!YK_ON) return;
  setInterval(async () => {
    try {
      q.ykExpire.run(Date.now() - 3 * 3600000);
      for (const r of q.ykPending.all(Date.now() - 3 * 3600000)) await ykCheck(r.id).catch((e) => console.error('ЮKassa:', e.message));
    } catch (e) { console.error('ЮKassa:', e.message); }
  }, 8000).unref();
}
async function handleUpdate(u) {
  if (u.pre_checkout_query) return handlePreCheckout(u.pre_checkout_query);
  if (u.message && u.message.successful_payment) return handlePayment(u.message);
  if (u.callback_query) return handleCallback(u.callback_query);
  const m = u.message;
  if (!m || !m.chat || m.chat.type !== 'private') return;
  const text = String(m.text || '').trim();
  const name = (m.from && m.from.first_name) || '';
  if (/^\/(help|support)\b/.test(text)) {
    const sup = SUPPORT_TG ? `\n\nПоддержка: @${SUPPORT_TG}` : '';
    return tgApi('sendMessage', { chat_id: m.chat.id, text: 'Быстрая запись трат: отправьте «кофе 250» или «такси 300». Доход: «+5000 зарплата».' + sup, reply_markup: openButton() });
  }
  const wl = /^\/start\s+wl_([0-9a-f]{16})$/.exec(text);
  if (wl) {
    const e = liveLogin(wl[1]);
    if (!e || e.state !== 'pending') return tgApi('sendMessage', { chat_id: m.chat.id, text: 'Эта ссылка для входа устарела. Нажмите «Войти» в приложении ещё раз.' });
    return tgApi('sendMessage', {
      chat_id: m.chat.id,
      text: `Вход в Копилку на другом устройстве.\n\nКод: ${e.code}\n\nЕсли этот код показан на экране, где вы входите, нажмите «Это я». Если вы ничего не открывали, нажмите «Не я».`,
      reply_markup: { inline_keyboard: [[{ text: '✅ Это я, войти', callback_data: 'wl|y|' + wl[1] }, { text: '❌ Не я', callback_data: 'wl|n|' + wl[1] }]] },
    });
  }
  if (/^\/(plans|buy|subscribe)\b/.test(text)) return tgApi('sendMessage', { chat_id: m.chat.id, ...plansMessage(m.from.id) });
  if (!text.startsWith('/') && await handleQuick(m, text)) return;
  const msg = text.startsWith('/start')
    ? `Привет${name ? ', ' + name : ''}! 👋\n\nЭто Копилка: считайте расходы, планируйте бюджет и копите на цели.\nНажмите кнопку ниже, чтобы открыть.\n\nМожно и быстрее: просто напишите сюда «кофе 250», и трата запишется сама.`
    : 'Нажмите кнопку ниже, чтобы открыть Копилку 👇\nИли напишите трату, например «кофе 250».';
  const kb = [[{ text: 'Открыть Копилку', web_app: { url: APP_URL } }]];
  if (PAYWALL && text.startsWith('/start')) kb.push([{ text: 'Подписка и цены', callback_data: 'pl' }]);
  await tgApi('sendMessage', { chat_id: m.chat.id, text: msg, reply_markup: { inline_keyboard: kb } });
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
      await tgApi('setMyCommands', { commands: [{ command: 'start', description: 'Открыть Копилку' }, { command: 'plans', description: 'Подписка и цены' }, { command: 'help', description: 'Как быстро записать трату' }] });
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
      const r = await tgApi('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query', 'pre_checkout_query'] }, 65000);
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
  const d = new Date((DEV && process.env.FAKE_NOW ? Number(process.env.FAKE_NOW) : Date.now()) + tzMin * 60000 - (shiftDays || 0) * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  return { day: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, hour: d.getUTCHours(), dow: d.getUTCDay() };
}
const CUR_SYM = { RUB: '₽', USD: '$', EUR: '€', CNY: '¥', KZT: '₸', BYN: 'Br', UAH: '₴', GEL: '₾', TRY: '₺', AMD: '֏' };
const money = (n, st) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ' + ((st && CUR_SYM[st.cur]) || '₽');
function openButton() {
  return APP_URL ? { inline_keyboard: [[{ text: 'Открыть Копилку', web_app: { url: APP_URL } }]] } : undefined;
}
function weeklyText(st, tz) {
  const rub = (n) => money(n, st);
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
function pad2(n) { return String(n).padStart(2, '0'); }
const MONTHS_RU = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
/* что нужно оплатить завтра: регулярные платежи и взносы по долгам */
function dueTomorrow(st, tz) {
  const t = localParts(tz, -1), y = +t.day.slice(0, 4), mo = +t.day.slice(5, 7), d = +t.day.slice(8, 10);
  const key = t.day.slice(0, 7), last = new Date(Date.UTC(y, mo, 0)).getUTCDate(), items = [];
  for (const r of st.recurring || []) {
    if (r.from && r.from > key) continue;
    if (Math.min(r.day, last) === d) items.push({ name: r.name, amount: r.amount });
  }
  for (const x of st.debts || []) {
    if (x.kind === 'owed' || !(x.pay > 0)) continue;
    const left = x.total - (x.payments || []).reduce((a, p) => a + p.amount, 0);
    if (left <= 0 || (x.payments || []).some((p) => String(p.date).slice(0, 7) === key)) continue;
    if (Math.min(x.day || 1, last) === d) items.push({ name: x.name, amount: Math.min(x.pay, left) });
  }
  return items;
}
function billsText(items, st) {
  const total = items.reduce((a, i) => a + i.amount, 0);
  return 'Завтра платежи 💳\n' + items.map((i) => `• ${i.name} — ${money(i.amount, st)}`).join('\n') + (items.length > 1 ? `\nИтого: ${money(total, st)}` : '');
}
/* итоги прошедшего месяца: присылаем 1-го числа */
function monthlyText(st, tz) {
  const lp = localParts(tz), y = +lp.day.slice(0, 4), mo = +lp.day.slice(5, 7);
  const pY = mo === 1 ? y - 1 : y, pM = mo === 1 ? 12 : mo - 1, ppY = pM === 1 ? pY - 1 : pY, ppM = pM === 1 ? 12 : pM - 1;
  const pk = `${pY}-${pad2(pM)}`, ppk = `${ppY}-${pad2(ppM)}`;
  const cats = new Map(st.cats.map((c) => [c.id, c]));
  let spent = 0, prev = 0, saved = 0; const byCat = new Map(), days = new Set();
  for (const o of st.ops) {
    if (o.type !== 'expense') continue;
    const k = String(o.date).slice(0, 7);
    if (k === pk) { spent += o.amount; byCat.set(o.catId, (byCat.get(o.catId) || 0) + o.amount); days.add(o.date); }
    else if (k === ppk) prev += o.amount;
  }
  for (const g of st.goals || []) for (const c of g.contribs || []) if (String(c.date).slice(0, 7) === pk) saved += c.amount;
  if (!spent && !saved) return null;
  const dim = new Date(Date.UTC(pY, pM, 0)).getUTCDate();
  let t = `Итоги: ${MONTHS_RU[pM - 1]} ${pY} 📊\nПотрачено: ${money(spent, st)}`;
  if (prev > 0) { const diff = Math.round((spent - prev) / prev * 100); t += ` (${diff > 0 ? '+' : ''}${diff}% к прошлому месяцу)`; }
  const top = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0], c = top && cats.get(top[0]);
  if (c) t += `\nБольше всего: ${c.emoji} ${c.name} — ${money(top[1], st)}`;
  t += `\nДней без трат: ${dim - days.size} из ${dim}`;
  if (saved) t += `\nОтложено в цели: ${money(saved, st)}`;
  return t;
}
async function sendReminders(ignoreHour) {
  if (!BOT_NAME || !BOT_TOKEN) return;
  for (const r of q.remindList.all()) {
    try {
      const lp = localParts(r.tz);
      if (!ignoreHour && (lp.hour < r.hour || lp.hour > r.hour + 3)) continue;
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
      if (r.bills && r.last_bills !== lp.day) {
        q.markBills.run(lp.day, r.user_id);
        const items = dueTomorrow(st, r.tz);
        if (items.length) {
          const resp = await tgApi('sendMessage', { chat_id: r.user_id, text: billsText(items, st), reply_markup: openButton() }, 10000);
          if (!resp.ok) q.markBills.run('', r.user_id);
        }
      }
      if (r.monthly && lp.day.slice(8, 10) === '01' && r.last_month !== lp.day) {
        q.markMonth.run(lp.day, r.user_id);
        const txt = monthlyText(st, r.tz);
        if (txt) {
          const resp = await tgApi('sendMessage', { chat_id: r.user_id, text: txt, reply_markup: openButton() }, 10000);
          if (!resp.ok) q.markMonth.run('', r.user_id);
        }
      }
      if (r.weekly && lp.dow === 1 && r.last_week !== lp.day) {
        q.markWeek.run(lp.day, r.user_id);
        const resp = await tgApi('sendMessage', { chat_id: r.user_id, text: weeklyText(st, r.tz), reply_markup: openButton() }, 10000);
        if (!resp.ok) q.markWeek.run('', r.user_id);
      }
    } catch (_) { q.markSent.run('', r.user_id); q.markWeek.run('', r.user_id); q.markBills.run('', r.user_id); q.markMonth.run('', r.user_id); }
  }
}
setInterval(() => { sendReminders().catch(() => {}); }, 10 * 60 * 1000).unref();

/* ---------- Запуск ---------- */
server.listen(PORT, () => {
  console.log(`Копилка запущена на порту ${PORT}. Данные: ${DATA_DIR}`);
  if (BOT_TOKEN && process.env.DISABLE_BOT !== '1') startBot();
  startYkPolling();
});

function shutdown() {
  stopping = true;
  server.close(() => { try { db.close(); } catch (_) {} process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => console.error('Необработанная ошибка:', e));
