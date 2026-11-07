// Game rules. Everything random happens here, on the server, with crypto.randomInt.
import { randomInt } from 'node:crypto';

export const START_BALANCE = 1000;
export const MAX_BET = 1_000_000;

/* ---------- Slots ---------- */
const SYM = ['7', '★', '♦', '♥', '♠', '♣'];
const W = [1, 2, 3, 3, 4, 4];
const WS = W.reduce((a, b) => a + b, 0);
const PAY3 = { '7': 100, '★': 20, '♦': 10, '♥': 10, '♠': 6, '♣': 6 };
const REDS = new Set(['♦', '♥']);
const BLACKS = new Set(['♠', '♣']);
export const SLOT_BETS = [10, 25, 50, 100];

function pickSym() {
  let r = randomInt(WS);
  for (let i = 0; i < SYM.length; i++) { r -= W[i]; if (r < 0) return SYM[i]; }
  return SYM[SYM.length - 1];
}
export function slotPay(r) {
  if (r[0] === r[1] && r[1] === r[2]) return PAY3[r[0]];
  const sevens = r.filter(s => s === '7').length;
  if (sevens === 2) return 5;
  if (sevens === 1) return 2;
  if (r.every(s => REDS.has(s)) || r.every(s => BLACKS.has(s))) return 2;
  return 0;
}
export function spinSlots() {
  const reels = [pickSym(), pickSym(), pickSym()];
  return { reels, mult: slotPay(reels) };
}

/* ---------- European roulette ---------- */
export const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
export const ROULETTE_KEY = /^(n:([0-9]|[12][0-9]|3[0-6])|red|black|even|odd|low|high|d1|d2|d3)$/;
export const colorName = n => (n === 0 ? 'зеро' : RED.has(n) ? 'красное' : 'чёрное');
export function spinRoulette() { return randomInt(37); }
/** Total returned for one stake (stake included), 0 when it loses. */
export function roulettePayout(key, n, amt) {
  if (key.startsWith('n:')) return Number(key.slice(2)) === n ? amt * 36 : 0;
  if (n === 0) return 0;
  switch (key) {
    case 'red': return RED.has(n) ? amt * 2 : 0;
    case 'black': return !RED.has(n) ? amt * 2 : 0;
    case 'even': return n % 2 === 0 ? amt * 2 : 0;
    case 'odd': return n % 2 === 1 ? amt * 2 : 0;
    case 'low': return n <= 18 ? amt * 2 : 0;
    case 'high': return n >= 19 ? amt * 2 : 0;
    case 'd1': return n <= 12 ? amt * 3 : 0;
    case 'd2': return n >= 13 && n <= 24 ? amt * 3 : 0;
    case 'd3': return n >= 25 ? amt * 3 : 0;
  }
  return 0;
}

/* ---------- Blackjack: 6 decks, dealer stands on soft 17, BJ pays 3:2 ---------- */
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function newShoe() {
  const shoe = [];
  for (let d = 0; d < 6; d++) for (const s of SUITS) for (const r of RANKS) shoe.push(r + s);
  for (let i = shoe.length - 1; i > 0; i--) { const j = randomInt(i + 1); [shoe[i], shoe[j]] = [shoe[j], shoe[i]]; }
  return shoe;
}
function draw(st) {
  if (!Array.isArray(st.shoe) || st.shoe.length < 60) st.shoe = newShoe();
  return st.shoe.pop();
}
const rankOf = c => c.slice(0, -1);
export function handVal(h) {
  let t = 0, a = 0;
  for (const c of h) {
    const r = rankOf(c);
    if (r === 'A') { t += 11; a++; }
    else if (r === 'J' || r === 'Q' || r === 'K' || r === '10') t += 10;
    else t += Number(r);
  }
  while (t > 21 && a) { t -= 10; a--; }
  return t;
}
const isBJ = h => h.length === 2 && handVal(h) === 21;

/** st = {shoe, hand}; hand = {phase:'play'|'done', bet, p, d, result?} */
export function bjDeal(st, bet) {
  const h = { phase: 'play', bet, p: [], d: [] };
  h.p.push(draw(st)); h.d.push(draw(st)); h.p.push(draw(st)); h.d.push(draw(st));
  st.hand = h;
  if (isBJ(h.p) || isBJ(h.d)) return settle(h);
  if (handVal(h.p) === 21) return bjStand(st);
  return null;
}
export function bjHit(st) {
  const h = st.hand;
  h.p.push(draw(st));
  const t = handVal(h.p);
  if (t > 21) return settle(h);
  if (t === 21) return bjStand(st);
  return null;
}
export function bjDouble(st) {
  const h = st.hand;
  h.bet *= 2;
  h.p.push(draw(st));
  if (handVal(h.p) > 21) return settle(h);
  return bjStand(st);
}
export function bjStand(st) {
  const h = st.hand;
  while (handVal(h.d) < 17) h.d.push(draw(st));
  return settle(h);
}
function settle(h) {
  const pv = handVal(h.p), dv = handVal(h.d), pB = isBJ(h.p), dB = isBJ(h.d);
  let back = 0, code;
  if (pv > 21) code = 'bust';
  else if (pB && dB) { back = h.bet; code = 'push_bj'; }
  else if (pB) { back = Math.floor(h.bet * 2.5); code = 'bj'; }
  else if (dB) code = 'dealer_bj';
  else if (dv > 21) { back = h.bet * 2; code = 'dealer_bust'; }
  else if (pv > dv) { back = h.bet * 2; code = 'win'; }
  else if (pv === dv) { back = h.bet; code = 'push'; }
  else code = 'lose';
  h.phase = 'done';
  h.result = { code, back };
  return { back, detail: (pB ? 'BJ' : pv) + ' : ' + (dB ? 'BJ' : dv) };
}
/** What the player may see: the hole card stays hidden (null) while the hand is live. */
export function bjPublic(h) {
  if (!h) return null;
  return {
    phase: h.phase,
    bet: h.bet,
    p: h.p,
    d: h.phase === 'play' ? [h.d[0], null] : h.d,
    result: h.result || null,
  };
}
