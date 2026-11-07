// @ts-nocheck — plain JS kept in .ts so the Supabase runtime picks it up as is.
// «Зелёное сукно» API: registration, login, sessions and all three games.
// `sql` is a postgres.js-style client: tagged template queries + sql.begin(fn) for transactions.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import * as G from './games.ts';

const SESSION_DAYS = 30;
const HISTORY = 60;
const USERNAME_RE = /^[A-Za-z0-9_.\-А-Яа-яЁё]{3,24}$/;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = msg => new HttpError(400, msg);
const n = v => Number(v);
// «Тест», «тест» and «ТЕСТ» are one player; ё and е are treated as the same letter.
const nameKey = s => String(s).trim().toLowerCase().replace(/ё/g, 'е');
const sha256 = s => createHash('sha256').update(s).digest('hex');
const isAmount = v => Number.isSafeInteger(v) && v > 0 && v <= G.MAX_BET;

/* ---------- Passwords ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1 };
const scrypt = (pw, salt) => new Promise((res, rej) => scryptCb(pw, salt, 64, SCRYPT, (e, k) => (e ? rej(e) : res(k))));
async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
let dummyHash = null;
async function verifyPassword(pw, stored) {
  if (!stored) { dummyHash ??= await hashPassword('dummy-password'); stored = dummyHash; }
  const [, saltB64, keyB64] = String(stored).split('$');
  const expected = Buffer.from(keyB64 || '', 'base64');
  const key = await scrypt(pw, Buffer.from(saltB64 || '', 'base64'));
  return expected.length === key.length && timingSafeEqual(expected, key);
}

export function createApp({ sql, allowedOrigins = [] }) {
  /* ---------- Helpers ---------- */
  async function account(db, id) {
    const [u] = await db`select balance, rounds, wagered, paid, biggest, refills from players where id = ${id}`;
    const rows = await db`
      select game, bet, win, detail, (extract(epoch from created_at) * 1000)::float8 as t
      from bets where player_id = ${id} order by id desc limit ${HISTORY}`;
    return {
      balance: n(u.balance),
      stats: { rounds: n(u.rounds), wagered: n(u.wagered), paid: n(u.paid), biggest: n(u.biggest), refills: n(u.refills) },
      history: rows.map(r => ({ game: r.game, bet: n(r.bet), win: n(r.win), detail: r.detail, t: Math.round(n(r.t)) })),
    };
  }
  async function fullState(db, user) {
    const hand = user.bj_state?.hand;
    return {
      user: { name: user.username },
      account: await account(db, user.id),
      bj: hand && hand.phase === 'play' ? G.bjPublic(hand) : null,
    };
  }
  async function recordRound(db, id, game, bet, win, detail) {
    await db`update players set rounds = rounds + 1, wagered = wagered + ${bet}, paid = paid + ${win},
             biggest = greatest(biggest, ${Math.max(0, win - bet)}) where id = ${id}`;
    await db`insert into bets (player_id, game, bet, win, detail) values (${id}, ${game}, ${bet}, ${win}, ${String(detail)})`;
  }
  async function createSession(id) {
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_DAYS * 86400e3).toISOString();
    await sql`insert into sessions (token_hash, player_id, expires_at) values (${sha256(token)}, ${id}, ${expires})`;
    return token;
  }
  async function currentUserId(req) {
    const token = req.headers.get('x-session-token');
    if (!token || token.length > 200) return null;
    const [s] = await sql`select player_id from sessions where token_hash = ${sha256(token)} and expires_at > now()`;
    return s ? s.player_id : null;
  }
  async function tooManyAttempts(req) {
    const ip = (req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim().slice(0, 64);
    const [r] = await sql`
      insert into auth_attempts (ip, n, reset_at) values (${ip}, 1, now() + interval '10 minutes')
      on conflict (ip) do update set
        n        = case when auth_attempts.reset_at < now() then 1 else auth_attempts.n + 1 end,
        reset_at = case when auth_attempts.reset_at < now() then now() + interval '10 minutes' else auth_attempts.reset_at end
      returning n`;
    if (Math.random() < 0.02) {
      await sql`delete from auth_attempts where reset_at < now()`;
      await sql`delete from sessions where expires_at < now()`;
    }
    return n(r.n) > 20;
  }
  // Lock the player's row for the whole transaction: no double spending from parallel requests.
  async function lockPlayer(tx, id) {
    const [u] = await tx`select * from players where id = ${id} for update`;
    if (!u) throw new HttpError(401, 'Войдите, чтобы играть.');
    u.balance = n(u.balance);
    u.bj_state = u.bj_state || { shoe: [], hand: null };
    return u;
  }
  const saveBj = (tx, id, st) => tx`update players set bj_state = ${JSON.stringify(st)}::jsonb where id = ${id}`;
  const setBalance = (tx, id, v) => tx`update players set balance = ${v} where id = ${id}`;

  async function bjAction(id, fn) {
    return sql.begin(async tx => {
      const u = await lockPlayer(tx, id);
      const st = u.bj_state;
      if (!st.hand || st.hand.phase !== 'play') throw new HttpError(409, 'Нет активной раздачи.');
      let balance = u.balance;
      const done = fn(st, u);
      if (done && typeof done.charge === 'number') balance -= done.charge;
      const result = done && done.result !== undefined ? done.result : done;
      if (result) {
        balance += result.back;
        await recordRound(tx, id, 'blackjack', st.hand.bet, result.back, result.detail);
      }
      await setBalance(tx, id, balance);
      await saveBj(tx, id, st);
      return { bj: G.bjPublic(st.hand), account: await account(tx, id) };
    });
  }

  /* ---------- Routes ---------- */
  const routes = {
    'GET /me': async (req, id) => {
      const [u] = await sql`select * from players where id = ${id}`;
      return fullState(sql, u);
    },

    'POST /auth/register': async (req, _id, body) => {
      if (await tooManyAttempts(req)) throw new HttpError(429, 'Слишком много попыток. Подождите 10 минут.');
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!USERNAME_RE.test(username)) throw bad('Имя: от 3 до 24 символов — буквы, цифры, точка, дефис или подчёркивание.');
      if (password.length < 8 || password.length > 200) throw bad('Пароль должен быть не короче 8 символов.');
      const [taken] = await sql`select 1 from players where name_key = ${nameKey(username)}`;
      if (taken) throw new HttpError(409, 'Это имя уже занято. Выберите другое.');
      const hash = await hashPassword(password);
      let user;
      try {
        [user] = await sql`insert into players (username, name_key, pass_hash, balance)
                           values (${username}, ${nameKey(username)}, ${hash}, ${G.START_BALANCE}) returning *`;
      } catch { throw new HttpError(409, 'Это имя уже занято. Выберите другое.'); }
      return { token: await createSession(user.id), ...(await fullState(sql, user)) };
    },

    'POST /auth/login': async (req, _id, body) => {
      if (await tooManyAttempts(req)) throw new HttpError(429, 'Слишком много попыток. Подождите 10 минут.');
      const [u] = await sql`select * from players where name_key = ${nameKey(body.username || '')}`;
      const ok = await verifyPassword(String(body.password || ''), u ? u.pass_hash : null);
      if (!u || !ok) throw new HttpError(401, 'Неверное имя или пароль.');
      return { token: await createSession(u.id), ...(await fullState(sql, u)) };
    },

    'POST /auth/logout': async req => {
      const token = req.headers.get('x-session-token');
      if (token) await sql`delete from sessions where token_hash = ${sha256(token)}`;
      return { ok: true };
    },

    'POST /slots/spin': (req, id, body) => sql.begin(async tx => {
      const bet = body.bet;
      if (!G.SLOT_BETS.includes(bet)) throw bad('Такой ставки на слотах нет.');
      const u = await lockPlayer(tx, id);
      if (u.balance < bet) throw bad('Не хватает фишек на ставку.');
      const { reels, mult } = G.spinSlots();
      const win = bet * mult;
      await setBalance(tx, id, u.balance - bet + win);
      await recordRound(tx, id, 'slots', bet, win, reels.join(' '));
      return { reels, mult, win, account: await account(tx, id) };
    }),

    'POST /roulette/spin': (req, id, body) => sql.begin(async tx => {
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
      const u = await lockPlayer(tx, id);
      if (u.balance < staked) throw bad('На столе больше фишек, чем в банке.');
      const number = G.spinRoulette();
      let win = 0;
      for (const [k, v] of entries) win += G.roulettePayout(k, number, v);
      await setBalance(tx, id, u.balance - staked + win);
      await recordRound(tx, id, 'roulette', staked, win, `${number} ${G.colorName(number)}`);
      return { number, staked, win, account: await account(tx, id) };
    }),

    'POST /blackjack/deal': (req, id, body) => sql.begin(async tx => {
      const u = await lockPlayer(tx, id);
      const st = u.bj_state;
      if (st.hand && st.hand.phase === 'play') throw new HttpError(409, 'Сначала доиграйте текущую раздачу.');
      const bet = body.bet;
      if (!isAmount(bet)) throw bad('Добавьте фишки к ставке.');
      if (bet > u.balance) throw bad('Ставка больше банка.');
      const done = G.bjDeal(st, bet);
      let balance = u.balance - bet;
      if (done) { balance += done.back; await recordRound(tx, id, 'blackjack', st.hand.bet, done.back, done.detail); }
      await setBalance(tx, id, balance);
      await saveBj(tx, id, st);
      return { bj: G.bjPublic(st.hand), account: await account(tx, id) };
    }),

    'POST /blackjack/hit': (req, id) => bjAction(id, st => G.bjHit(st)),
    'POST /blackjack/stand': (req, id) => bjAction(id, st => G.bjStand(st)),
    'POST /blackjack/double': (req, id) => bjAction(id, (st, u) => {
      if (st.hand.p.length !== 2) throw bad('Удвоить можно только на первых двух картах.');
      if (u.balance < st.hand.bet) throw bad('Не хватает фишек, чтобы удвоить.');
      const charge = st.hand.bet;
      return { charge, result: G.bjDouble(st) };
    }),

    'POST /refill': (req, id) => sql.begin(async tx => {
      const u = await lockPlayer(tx, id);
      if (u.balance >= 10 || (u.bj_state.hand && u.bj_state.hand.phase === 'play')) {
        throw bad('Пополнение доступно, когда в банке меньше 10 фишек.');
      }
      await tx`update players set balance = balance + 1000, refills = refills + 1 where id = ${id}`;
      return { account: await account(tx, id) };
    }),

    'POST /account/reset': (req, id) => sql.begin(async tx => {
      await lockPlayer(tx, id);
      await tx`update players set balance = ${G.START_BALANCE}, rounds = 0, wagered = 0, paid = 0, biggest = 0,
               refills = 0, bj_state = null where id = ${id}`;
      await tx`delete from bets where player_id = ${id}`;
      return { account: await account(tx, id) };
    }),
  };

  /* ---------- HTTP ---------- */
  function corsHeaders(origin) {
    const ok = origin && (allowedOrigins.includes(origin) || LOCAL_ORIGIN.test(origin));
    return {
      ...(ok ? { 'Access-Control-Allow-Origin': origin } : {}),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, x-session-token',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
  }

  return async function handle(req) {
    const origin = req.headers.get('origin');
    const cors = corsHeaders(origin);
    const send = (status, obj) => new Response(JSON.stringify(obj), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
    try {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      // The function lives at …/functions/v1/casino; everything after "casino" is the route.
      const path = new URL(req.url).pathname.replace(/^.*?\/casino(?=\/|$)/, '') || '/';
      if (path === '/' || path === '/healthz') return send(200, { ok: true });
      const handler = routes[`${req.method} ${path}`];
      if (!handler) return send(404, { error: 'Нет такого адреса API.' });
      if (origin && !cors['Access-Control-Allow-Origin']) return send(403, { error: 'Запрос с чужого сайта отклонён.' });

      let body = {};
      if (req.method === 'POST') {
        if (!String(req.headers.get('content-type') || '').startsWith('application/json')) return send(415, { error: 'Нужен JSON.' });
        const text = await req.text();
        if (text.length > 16 * 1024) return send(413, { error: 'Слишком большой запрос.' });
        try { const v = text ? JSON.parse(text) : {}; body = v && typeof v === 'object' ? v : {}; }
        catch { return send(400, { error: 'Неверный формат запроса.' }); }
      }
      const isAuth = path.startsWith('/auth/');
      const id = isAuth ? null : await currentUserId(req);
      if (!isAuth && !id) return send(401, { error: 'Войдите, чтобы играть.' });
      return send(200, await handler(req, id, body));
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error(e);
      return send(500, { error: 'Ошибка на сервере. Попробуйте ещё раз.' });
    }
  };
}
