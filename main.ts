// Tiny Bot: a dip-and-recover bot for the bars-replay/v1 protocol.
//
// Idea in one paragraph: buy-and-hold loses whenever the whole universe drifts down, because it
// never leaves. This bot does the opposite of chasing: it waits for a symbol to be knocked down
// hard enough that its short-term momentum is oversold, checks that the short trend has already
// stopped falling, buys a modest slice, and sells again as soon as the bounce has paid for the
// round trip. The rest of the time it sits in cash. After the hello handshake it reads every
// batch bar by bar, keeps its indicators per symbol, and answers each batch with orders only
// when its own rules fire — never on a warm-up batch, where every order would be rejected.
//
// Why it is built this way (the first two versions of this bot chased strength and pullbacks
// inside uptrends, and on the dev window every one of their round trips lost: in a falling,
// mean-reverting market a hot momentum run is usually a local top, and a slow trend exit gives
// the whole bounce back):
//   - Oversold gate: a Wilder-style RSI over the last 10 closes must read at most 37. That is
//     the dip. No dip, no trade — most bars of most symbols are simply ignored.
//   - Turn gate: the 9-bar exponential average must be higher than it was 3 bars ago. The dip
//     alone is a falling knife; the rising short average says the fall has actually paused and
//     the first buyers are back. (Removing this gate was the single worst variant tested.)
//   - Entry sizing: at most 4 positions at once, each about 25% of equity (never past the hello
//     caps' weight room or the cash on hand), deepest RSI first, so no single symbol can sink
//     the account and the capital keeps recycling into fresh dips.
//   - Exits, whole position, all quick: worth 1.2% over cost (take profit — the bounce is the
//     trade, it is banked, not ridden), worth 5% under cost (hard stop), 24 bars old (time stop:
//     a dip that has not bounced within a day is not a dip, it is a downtrend). No trailing
//     rule is kept: the take profit already covers the upside.
//   - Cooldown: after any exit a symbol rests 2 bars before it can be bought again.
//   - Every order caps its slippage at 250 bps past the close it was decided on; a fill the
//     market moves too far against is refused and the still-valid signal is sent again next bar.
//     All thresholds sit well above the round-trip cost (fee plus modelled slippage plus pool
//     price impact), so a trade that fires is expected to clear its costs, not just its price.
//
// Determinism: only + - * / on float64 closes and integer account amounts — no clock, no random,
// no environment. The same hello, batch stream and orders come out identical on every run.

import { runBars, type Bar, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const RSI_BARS = 10;
const RSI_ENTRY_AT_MOST = 37;
const EMA_BARS = 9;
const SLOPE_LAG = 3; // the short average must be above its value this many bars ago
const TAKE_PROFIT = 1.012; // sell when the position is worth 101.2% of its cost
const STOP_LOSS = 0.95; // sell when the position is worth 95% of its cost
const MAX_HOLD_BARS = 24; // sell when the position is this many bars old
const MAX_POSITIONS = 4;
const WEIGHT = 0.25; // target share of equity per position
const COOLDOWN_BARS = 2;
const MAX_SLIPPAGE_BPS = 250;

interface Track {
  closes: number[];
  ema: number | null;
  emaSeed: number[];
  emaHistory: (number | null)[]; // the short average after each bar, for the slope check
  avgGain: number | null; // Wilder averages for the RSI
  avgLoss: number | null;
  gainSeed: number[];
  lossSeed: number[];
  rsi: number | null;
  cooldownUntil: number; // first batch seq at which the symbol may be bought again
}

const tracks = new Map<string, Track>();
/** The batch seq at which each held position was first seen in the account (its fill bar, near enough). */
const enteredAt = new Map<string, number>();

function trackOf(symbol: string): Track {
  let t = tracks.get(symbol);
  if (t === undefined) {
    t = {
      closes: [], ema: null, emaSeed: [], emaHistory: [],
      avgGain: null, avgLoss: null, gainSeed: [], lossSeed: [],
      rsi: null, cooldownUntil: -1,
    };
    tracks.set(symbol, t);
  }
  return t;
}

/** Fold one bar into its symbol's indicators: the short EMA and the Wilder RSI over its closes. */
function observe(bar: Bar): void {
  const t = trackOf(bar.symbol);
  const close = Number(bar.c);
  const prev = t.closes.length > 0 ? t.closes[t.closes.length - 1]! : null;
  t.closes.push(close);

  if (t.ema !== null) {
    t.ema += (2 / (EMA_BARS + 1)) * (close - t.ema);
  } else {
    t.emaSeed.push(close);
    if (t.emaSeed.length === EMA_BARS) t.ema = t.emaSeed.reduce((a, x) => a + x, 0) / EMA_BARS;
  }
  t.emaHistory.push(t.ema);

  if (prev === null) return;
  const change = close - prev;
  const gain = change > 0 ? change : 0;
  const loss = change < 0 ? -change : 0;
  if (t.avgGain !== null && t.avgLoss !== null) {
    t.avgGain = (t.avgGain * (RSI_BARS - 1) + gain) / RSI_BARS;
    t.avgLoss = (t.avgLoss * (RSI_BARS - 1) + loss) / RSI_BARS;
  } else {
    t.gainSeed.push(gain);
    t.lossSeed.push(loss);
    if (t.gainSeed.length === RSI_BARS) {
      t.avgGain = t.gainSeed.reduce((a, x) => a + x, 0) / RSI_BARS;
      t.avgLoss = t.lossSeed.reduce((a, x) => a + x, 0) / RSI_BARS;
    }
  }
  if (t.avgGain !== null && t.avgLoss !== null) {
    t.rsi = t.avgLoss === 0 ? 100 : 100 - 100 / (1 + t.avgGain / t.avgLoss);
  }
}

/** Whether the turn gate holds: the short average exists and is above its value SLOPE_LAG bars ago. */
function turningUp(t: Track): boolean {
  const n = t.emaHistory.length;
  if (n <= SLOPE_LAG) return false;
  const now = t.emaHistory[n - 1];
  const then = t.emaHistory[n - 1 - SLOPE_LAG];
  return now !== null && then !== null && now > then;
}

await runBars({
  onBatch(state, batch) {
    // Read the whole batch first: every bar updates its track before any order is decided, so a
    // symbol's signal always rests on its latest close.
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      observe(bar);
      fresh.add(bar.symbol);
    }
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const minNotional = BigInt(fees.min_notional_quote_units);
    const sells: SellInput[] = [];
    const heldNow = new Set<string>();

    // Exits first: a finished bounce or a broken dip leaves before new orders compete for the cap.
    for (const { symbol } of state.hello.symbols) {
      const held = state.positions.get(symbol);
      if (held === undefined) {
        enteredAt.delete(symbol);
        continue;
      }
      heldNow.add(symbol);
      if (!enteredAt.has(symbol)) enteredAt.set(symbol, state.seq);
      if (!fresh.has(symbol)) continue;
      const value = state.value(symbol, held.qty);
      const banked = value * 1000n >= held.cost * BigInt(Math.round(TAKE_PROFIT * 1000));
      const stopped = value * 100n <= held.cost * BigInt(Math.round(STOP_LOSS * 100));
      const stale = state.seq - enteredAt.get(symbol)! >= MAX_HOLD_BARS;
      if (banked || stopped || stale) {
        sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        trackOf(symbol).cooldownUntil = state.seq + COOLDOWN_BARS;
        enteredAt.delete(symbol);
      }
    }

    // Entries: the symbols that are oversold and turning up, deepest dip first. A symbol sold in
    // this same reply is not rebought here (its proceeds only land at the next open anyway, and
    // the cooldown bars it out regardless).
    const soldHere = new Set(sells.map((o) => o.symbol));
    const candidates: { symbol: string; rsi: number }[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (heldNow.has(symbol) || soldHere.has(symbol)) continue;
      if (state.seq < trackOf(symbol).cooldownUntil) continue;
      const t = trackOf(symbol);
      if (t.rsi === null || t.rsi > RSI_ENTRY_AT_MOST) continue;
      if (!turningUp(t)) continue;
      candidates.push({ symbol, rsi: t.rsi });
    }
    candidates.sort((a, b) => a.rsi - b.rsi || (a.symbol < b.symbol ? -1 : 1));

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slotCap = Math.min(MAX_POSITIONS, caps.max_open_positions);
    let slots = slotCap - (heldNow.size - sells.length);
    let cash = state.cash;
    for (const { symbol } of candidates) {
      if (slots <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = BigInt(Math.floor(Number(state.equity) * WEIGHT));
      const room = state.weightRoom(symbol);
      if (room < slice) slice = room;
      if (cash < slice) slice = cash;
      if (slice < minNotional || slice <= 0n) continue;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
      slots--;
    }
    return orders;
  },
});
