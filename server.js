// «Зелёное сукно» — HTTP server, auth, and game API. No npm dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import * as G from './src/games.js';

const scrypt = promisify(scryptCb);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PROD = process.env.NODE_ENV === 'production';
const COOKIE_SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : PROD;
const TRUST_PROXY = (process.env.TRUST_PROXY ?? 'true') === 'true';
const SESSION_DAYS = 30;
const HISTORY = 60;

/* ---------- Database ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'casino.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY,
    username   TEXT NOT NULL,
    name_key   TEXT NOT NULL UNIQUE,
    pass_hash  TEXT NOT NULL,
    balance    INTEGER NOT NULL,
    rounds     INTEGER NOT NULL DEFAULT 0,
    wagered    INTEGER NOT NULL DEFAULT 0,
    paid       INTEGER NOT NULL DEFAULT 0,
    biggest    INTEGER NOT NULL DEFAULT 0,
    refills    INTEGER NOT NULL DEFAULT 0,
    bj_state   TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bets (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game       TEXT NOT NULL,
    bet        INTEGER NOT NULL,
    win        INTEGER NOT NULL,
    detail     TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS bets_by_user ON bets(user_id, id DESC);
`);

const q = {
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByName: db.prepare('SELECT * FROM users WHERE name_key = ?'),
  insertUser: db.prepare('INSERT INTO users (username, name_key, pass_hash, balance, created_at) VALUES (?, ?, ?, ?, ?)'),
  setBalance: db.prepare('UPDATE users SET balance = ? WHERE id = ?'),
  setBj: db.prepare('UPDATE users SET bj_state = ? WHERE id = ?'),
  addStats: db.prepare(`UPDATE users SET rounds = rounds + 1, wagered = wagered + ?, paid = paid + ?,
                        biggest = MAX(biggest, ?) WHERE id = ?`),
  refill: db.prepare('UPDATE users SET balance = balance + 1000, refills = refills + 1 WHERE id = ?'),
  reset: db.prepare(`UPDATE users SET balance = ?, rounds = 0, wagered = 0, paid = 0, biggest = 0,
                     refills = 0, bj_state = NULL WHERE id = ?`),
  insertBet: db.prepare('INSERT INTO bets (user_id, game, bet, win, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  history: db.prepare('SELECT game, bet, win, detail, created_at AS t FROM bets WHERE user_id = ? ORDER BY id DESC LIMIT ?'),
  clearBets: db.prepare('DELETE FROM bets WHERE user_id = ?'),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  session: db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
};

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* ---------- Passwords & sessions ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
const DUMMY_HASH = await hashPassword(randomBytes(12).toString('hex'));
async function verifyPassword(pw, stored) {
  const [, saltB64, keyB64] = String(stored).split('$');
  const expected = Buffer.from(keyB64 || '', 'base64');
  const key = await scrypt(pw, Buffer.from(saltB64 || '', 'base64'), 64, SCRYPT);
  return expected.length === key.length && timingSafeEqual(expected, key);
}
const sha256 = s => createHash('sha256').update(s).digest('hex');

function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  q.insertSession.run(sha256(token), userId, Date.now() + SESSION_DAYS * 86400e3);
  return token;
}
function sessionCookie(token, maxAgeSec) {
  return [`sid=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${maxAgeSec}`, COOKIE_SECURE ? 'Secure' : '']
    .filter(Boolean).join('; ');
}
function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
function currentUser(req) {
  const token = readCookie(req, 'sid');
  if (!token) return null;
  const s = q.session.get(sha256(token));
  if (!s || s.expires_at < Date.now()) return null;
  return q.userById.get(s.user_id) || null;
}
setInterval(() => q.purgeSessions.run(Date.now()), 3600e3).unref();

/* ---------- Rate limiting for auth ---------- */
const attempts = new Map();
function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
function tooManyAttempts(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.reset < now) { attempts.set(ip, { n: 1, reset: now + 10 * 60e3 }); return false; }
  a.n++;
  return a.n > 20;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k); }, 600e3).unref();

/* ---------- Account helpers ---------- */
function loadBj(user) {
  try { return user.bj_state ? JSON.parse(user.bj_state) : { shoe: [], hand: null }; }
  catch { return { shoe: [], hand: null }; }
}
function account(userId) {
  const u = q.userById.get(userId);
  return {
    balance: u.balance,
    stats: { rounds: u.rounds, wagered: u.wagered, paid: u.paid, biggest: u.biggest, refills: u.refills },
    history: q.history.all(userId, HISTORY).map(r => ({ ...r })),
  };
}
function fullState(user) {
  const bj = loadBj(user).hand;
  return {
    user: { name: user.username },
    account: account(user.id),
    bj: bj && bj.phase === 'play' ? G.bjPublic(bj) : null,
  };
}
function recordRound(userId, game, bet, win, detail) {
  q.addStats.run(bet, win, Math.max(0, win - bet), userId);
  q.insertBet.run(userId, game, bet, win, String(detail), Date.now());
}
const isAmount = v => Number.isSafeInteger(v) && v > 0 && v <= G.MAX_BET;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = msg => new HttpError(400, msg);

/* ---------- API routes ---------- */
const USERNAME_RE = /^[A-Za-z0-9_.\-А-Яа-яЁё]{3,24}$/;
// «Тест», «тест» and «ТЕСТ» are one player; ё and е are treated as the same letter.
const nameKey = s => String(s).trim().toLowerCase().replace(/ё/g, 'е');
const routes = {
  'GET /api/me': (req, user) => fullState(user),

  'POST /api/auth/register': async (req, _u, body, res) => {
    if (tooManyAttempts(clientIp(req))) throw new HttpError(429, 'Слишком много попыток. Подождите 10 минут.');
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!USERNAME_RE.test(username)) throw bad('Имя: от 3 до 24 символов — буквы, цифры, точка, дефис или подчёркивание.');
    if (password.length < 8 || password.length > 200) throw bad('Пароль должен быть не короче 8 символов.');
    if (q.userByName.get(nameKey(username))) throw new HttpError(409, 'Это имя уже занято. Выберите другое.');
    const hash = await hashPassword(password);
    let id;
    try { id = Number(q.insertUser.run(username, nameKey(username), hash, G.START_BALANCE, Date.now()).lastInsertRowid); }
    catch { throw new HttpError(409, 'Это имя уже занято. Выберите другое.'); }
    res.setHeader('Set-Cookie', sessionCookie(createSession(id), SESSION_DAYS * 86400));
    return fullState(q.userById.get(id));
  },

  'POST /api/auth/login': async (req, _u, body, res) => {
    if (tooManyAttempts(clientIp(req))) throw new HttpError(429, 'Слишком много попыток. Подождите 10 минут.');
    const u = q.userByName.get(nameKey(body.username || ''));
    const ok = await verifyPassword(String(body.password || ''), u ? u.pass_hash : DUMMY_HASH);
    if (!u || !ok) throw new HttpError(401, 'Неверное имя или пароль.');
    res.setHeader('Set-Cookie', sessionCookie(createSession(u.id), SESSION_DAYS * 86400));
    return fullState(u);
  },

  'POST /api/auth/logout': (req, _u, _b, res) => {
    const token = readCookie(req, 'sid');
    if (token) q.deleteSession.run(sha256(token));
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    return { ok: true };
  },

  'POST /api/slots/spin': (req, user, body) => tx(() => {
    const bet = body.bet;
    if (!G.SLOT_BETS.includes(bet)) throw bad('Такой ставки на слотах нет.');
    const u = q.userById.get(user.id);
    if (u.balance < bet) throw bad('Не хватает фишек на ставку.');
    const { reels, mult } = G.spinSlots();
    const win = bet * mult;
    q.setBalance.run(u.balance - bet + win, u.id);
    recordRound(u.id, 'slots', bet, win, reels.join(' '));
    return { reels, mult, win, account: account(u.id) };
  }),

  'POST /api/roulette/spin': (req, user, body) => tx(() => {
    const bets = body.bets;
    if (!bets || typeof bets !== 'object' || Array.isArray(bets)) throw bad('Сначала поставьте фишки на поле.');
    const entries = Object.entries(bets);
    if (!entries.length) throw bad('Сначала поставьте фишки на поле.');
    if (entries.length > 60) throw bad('Слишком много ставок за один спин.');
    let staked = 0;
    for (const [k, v] of entries) {
      if (!G.ROULETTE_KEY.test(k) || !isAmount(v)) throw bad('Неверная ставка на поле.');
      staked += v;
    }
    if (staked > G.MAX_BET) throw bad('Слишком большая сумма на столе.');
    const u = q.userById.get(user.id);
    if (u.balance < staked) throw bad('На столе больше фишек, чем в банке.');
    const number = G.spinRoulette();
    let win = 0;
    for (const [k, v] of entries) win += G.roulettePayout(k, number, v);
    q.setBalance.run(u.balance - staked + win, u.id);
    recordRound(u.id, 'roulette', staked, win, `${number} ${G.colorName(number)}`);
    return { number, staked, win, account: account(u.id) };
  }),

  'POST /api/blackjack/deal': (req, user, body) => tx(() => {
    const u = q.userById.get(user.id);
    const st = loadBj(u);
    if (st.hand && st.hand.phase === 'play') throw new HttpError(409, 'Сначала доиграйте текущую раздачу.');
    const bet = body.bet;
    if (!isAmount(bet)) throw bad('Добавьте фишки к ставке.');
    if (bet > u.balance) throw bad('Ставка больше банка.');
    const done = G.bjDeal(st, bet);
    let balance = u.balance - bet;
    if (done) { balance += done.back; recordRound(u.id, 'blackjack', st.hand.bet, done.back, done.detail); }
    q.setBalance.run(balance, u.id);
    q.setBj.run(JSON.stringify(st), u.id);
    return { bj: G.bjPublic(st.hand), account: account(u.id) };
  }),

  'POST /api/blackjack/hit': (req, user) => bjAction(user, st => G.bjHit(st)),
  'POST /api/blackjack/stand': (req, user) => bjAction(user, st => G.bjStand(st)),
  'POST /api/blackjack/double': (req, user) => bjAction(user, (st, u) => {
    if (st.hand.p.length !== 2) throw bad('Удвоить можно только на первых двух картах.');
    if (u.balance < st.hand.bet) throw bad('Не хватает фишек, чтобы удвоить.');
    q.setBalance.run(u.balance - st.hand.bet, u.id);
    return G.bjDouble(st);
  }),

  'POST /api/refill': (req, user) => tx(() => {
    const u = q.userById.get(user.id);
    const st = loadBj(u);
    if (u.balance >= 10 || (st.hand && st.hand.phase === 'play')) throw bad('Пополнение доступно, когда в банке меньше 10 фишек.');
    q.refill.run(u.id);
    return { account: account(u.id) };
  }),

  'POST /api/account/reset': (req, user) => tx(() => {
    q.reset.run(G.START_BALANCE, user.id);
    q.clearBets.run(user.id);
    return { account: account(user.id) };
  }),
};

function bjAction(user, fn) {
  return tx(() => {
    const u = q.userById.get(user.id);
    const st = loadBj(u);
    if (!st.hand || st.hand.phase !== 'play') throw new HttpError(409, 'Нет активной раздачи.');
    const done = fn(st, u);
    if (done) {
      const cur = q.userById.get(u.id);
      q.setBalance.run(cur.balance + done.back, u.id);
      recordRound(u.id, 'blackjack', st.hand.bet, done.back, done.detail);
    }
    q.setBj.run(JSON.stringify(st), u.id);
    return { bj: G.bjPublic(st.hand), account: account(u.id) };
  });
}

/* ---------- HTTP plumbing ---------- */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 16 * 1024) { reject(new HttpError(413, 'Слишком большой запрос.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); }
      catch { reject(bad('Неверный формат запроса.')); }
    });
    req.on('error', reject);
  });
}
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не найдено'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600',
      ...SECURITY_HEADERS,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  try {
    if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, pathname);
    }
    const handler = routes[`${req.method} ${pathname}`];
    if (!handler) return send(res, 404, { error: 'Нет такого адреса API.' });

    let body = {};
    if (req.method === 'POST') {
      // CSRF: only same-origin JSON requests change state.
      const origin = req.headers.origin;
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      let originHost = null;
      try { originHost = origin ? new URL(origin).host : null; } catch { originHost = 'invalid'; }
      if (origin && originHost !== host) return send(res, 403, { error: 'Запрос с чужого сайта отклонён.' });
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'Нужен JSON.' });
      body = await readJson(req);
    }
    const isAuthRoute = pathname.startsWith('/api/auth/');
    const user = isAuthRoute ? null : currentUser(req);
    if (!isAuthRoute && !user) return send(res, 401, { error: 'Войдите, чтобы играть.' });
    const result = await handler(req, user, body, res);
    send(res, 200, result);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Ошибка на сервере. Попробуйте ещё раз.' });
  }
});

server.listen(PORT, () => console.log(`Зелёное сукно: http://localhost:${PORT} (data: ${DATA_DIR})`));
function shutdown() { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
