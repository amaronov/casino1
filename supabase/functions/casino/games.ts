// @ts-nocheck — plain JS, shared rules for all games. Randomness: node:crypto randomInt.
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

/* ---------- Blackjack ----------
   6 decks, reshuffled below 60 cards. Dealer peeks for blackjack, draws to 17, stands on soft 17.
   Blackjack pays 3:2. Double on any first two cards, including after a split.
   Split any two cards of equal value (10/J/Q/K pair with each other), up to 4 hands;
   split aces get one card each and cannot be split again. 21 after a split is not a blackjack. */
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const MAX_HANDS = 4;

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
const cardValue = c => { const r = rankOf(c); return r === 'A' ? 11 : r === 'J' || r === 'Q' || r === 'K' || r === '10' ? 10 : Number(r); };
export function handVal(h) {
  let t = 0, a = 0;
  for (const c of h) { const v = cardValue(c); t += v; if (v === 11) a++; }
  while (t > 21 && a) { t -= 10; a--; }
  return t;
}
const isBJ = h => h.length === 2 && handVal(h) === 21;

/** Hands saved before splits existed ({p, bet}) become the multi-hand shape. */
export function bjNormalize(h) {
  if (h && !Array.isArray(h.hands) && Array.isArray(h.p)) {
    return { phase: h.phase, d: h.d, hands: [{ cards: h.p, bet: h.bet, done: false }], active: 0, split: false, result: null };
  }
  return h || null;
}
const cur = h => h.hands[h.active];

export function canDouble(h) {
  const x = h && h.phase === 'play' ? cur(h) : null;
  return !!x && !x.done && x.cards.length === 2 && !x.splitAces;
}
export function canSplit(h) {
  const x = h && h.phase === 'play' ? cur(h) : null;
  return !!x && !x.done && x.cards.length === 2 && !x.splitAces && h.hands.length < MAX_HANDS
    && cardValue(x.cards[0]) === cardValue(x.cards[1]);
}

/* Every action returns {charge, done}: chips to take from the bank now, and the settlement when the round ended. */
export function bjDeal(st, bet) {
  const h = { phase: 'play', d: [], hands: [{ cards: [], bet, done: false }], active: 0, split: false };
  const p = h.hands[0].cards;
  p.push(draw(st)); h.d.push(draw(st)); p.push(draw(st)); h.d.push(draw(st));
  st.hand = h;
  if (isBJ(p) || isBJ(h.d)) return { charge: bet, done: finish(st) };
  return { charge: bet, done: advance(st) };
}
export function bjHit(st) {
  const x = cur(st.hand);
  x.cards.push(draw(st));
  return { charge: 0, done: advance(st) };
}
export function bjStand(st) {
  cur(st.hand).done = true;
  return { charge: 0, done: advance(st) };
}
export function bjDouble(st) {
  const x = cur(st.hand);
  const charge = x.bet;
  x.bet *= 2; x.doubled = true;
  x.cards.push(draw(st));
  x.done = true;
  return { charge, done: advance(st) };
}
export function bjSplit(st) {
  const h = st.hand, x = cur(h);
  const [a, b] = x.cards;
  const aces = rankOf(a) === 'A' && rankOf(b) === 'A';
  x.cards = [a, draw(st)];
  const twin = { cards: [b, draw(st)], bet: x.bet, done: false };
  if (aces) { x.splitAces = twin.splitAces = true; x.done = twin.done = true; }
  h.hands.splice(h.active + 1, 0, twin);
  h.split = true;
  return { charge: x.bet, done: advance(st) };
}

// Skip finished hands (21 or bust ends a hand by itself); when none are left the dealer plays and the round settles.
function advance(st) {
  const h = st.hand;
  for (;;) {
    const x = cur(h);
    if (!x.done && handVal(x.cards) < 21) return null;
    x.done = true;
    if (h.active >= h.hands.length - 1) return finish(st);
    h.active++;
  }
}
function finish(st) {
  const h = st.hand;
  const dB = isBJ(h.d);
  const natural = !h.split && isBJ(h.hands[0].cards);
  const anyLive = h.hands.some(x => handVal(x.cards) <= 21);
  if (!dB && !natural && anyLive) while (handVal(h.d) < 17) h.d.push(draw(st));
  const dv = handVal(h.d);
  let back = 0, bet = 0;
  for (const x of h.hands) {
    const pv = handVal(x.cards), pB = !h.split && isBJ(x.cards);
    let code, b = 0;
    if (pv > 21) code = 'bust';
    else if (pB && dB) { b = x.bet; code = 'push_bj'; }
    else if (pB) { b = Math.floor(x.bet * 2.5); code = 'bj'; }
    else if (dB) code = 'dealer_bj';
    else if (dv > 21) { b = x.bet * 2; code = 'dealer_bust'; }
    else if (pv > dv) { b = x.bet * 2; code = 'win'; }
    else if (pv === dv) { b = x.bet; code = 'push'; }
    else code = 'lose';
    x.result = { code, back: b };
    x.done = true;
    back += b; bet += x.bet;
  }
  h.phase = 'done';
  h.result = { back, bet };
  const mine = h.hands.map(x => (!h.split && isBJ(x.cards) ? 'BJ' : handVal(x.cards))).join(', ');
  return { back, bet, detail: mine + ' : ' + (dB ? 'BJ' : dv) };
}

/** What the player may see: the hole card stays hidden (null) while the round is live. */
export function bjPublic(raw) {
  const h = bjNormalize(raw);
  if (!h) return null;
  const live = h.phase === 'play';
  return {
    phase: h.phase,
    d: live ? [h.d[0], null] : h.d,
    hands: h.hands.map(x => ({ cards: x.cards, bet: x.bet, doubled: !!x.doubled, done: !!x.done, result: x.result || null })),
    active: h.active,
    split: !!h.split,
    canDouble: canDouble(h),
    canSplit: canSplit(h),
    result: h.result || null,
  };
}
