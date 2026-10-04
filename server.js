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
};

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

/* ---------- API ---------- */
const IMG_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
let BOT_NAME = '';

async function handleApi(req, res, url) {
  const user = authenticate(req);
  rateLimit(user.id);
  const p = url.pathname, m = req.method;

  if (p === '/api/state' && m === 'GET') {
    touch(user);
    return json(res, 200, { ...loadState(user.id), bot: BOT_NAME });
  }

  if (p === '/api/state' && m === 'PUT') {
    const body = await readJson(req, LIMITS.stateBytes);
    if (!validState(body && body.state)) throw httpError(400, 'bad state');
    touch(user);
    const r = saveState(user.id, body);
    if (r.conflict) return json(res, 409, { error: 'conflict', state: r.state, rev: r.rev });
    return json(res, 200, { rev: r.rev });
  }

  const im = p.match(/^\/api\/img\/([\w-]{1,40})$/);
  if (im && m === 'PUT') {
    const body = await readJson(req, LIMITS.imgChars + 1024);
    const img = body && body.img;
    if (typeof img !== 'string' || img.length > LIMITS.imgChars || !IMG_RE.test(img)) throw httpError(400, 'bad image');
    touch(user);
    tx(() => {
      if (!q.hasImage.get(user.id, im[1]) && q.imageIds.all(user.id).length >= LIMITS.imgPerUser) throw httpError(400, 'too many images');
      q.putImage.run(user.id, im[1], img, Date.now());
    });
    return json(res, 200, { ok: true });
  }
  if (im && m === 'DELETE') {
    q.delImage.run(user.id, im[1]);
    return json(res, 200, { ok: true });
  }

  if (p === '/api/account' && m === 'DELETE') {
    tx(() => { q.delImages.run(user.id); q.delState.run(user.id); q.delUser.run(user.id); });
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
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
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
  try {
    const me = await tgApi('getMe');
    if (!me.ok) { console.error('Бот: Telegram не принял токен. Проверьте BOT_TOKEN.'); return; }
    BOT_NAME = me.result.username || '';
    console.log('Бот: @' + BOT_NAME);
    if (!APP_URL) { console.warn('Бот: не задан APP_URL — кнопка открытия приложения не настроена.'); return; }
    await tgApi('deleteWebhook');
    await tgApi('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Открыть', web_app: { url: APP_URL } } });
    await tgApi('setMyCommands', { commands: [{ command: 'start', description: 'Открыть Копилку' }] });
  } catch (e) {
    console.error('Бот: не удалось подключиться к Telegram:', e.message);
    return;
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
