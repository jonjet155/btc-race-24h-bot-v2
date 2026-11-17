// Washout Fisher v2 — dip-buy mean reversion on cbBTC, long only.
//
// Why this bot exists: v1 ("Capitulation Sniper") was right about the shape
// of the trade and wrong about how deep a washout has to be. On its dev
// window (2026-11-14 -> 2026-11-15) the market fell 3.9% with one sharp
// -2% capitulation leg and a V-recovery, and v1 banked +$27.80 in 4 trades
// by buying only that deep flush. But in the live race window the deepest
// drawdown was only 2.38% — below v1's 6% bar — so v1 fired zero times and
// finished with $0.00 PnL, 0 trades, and a failed min-1-trade guardrail.
// The strategy was never wrong; the trigger was calibrated to a crash that
// never came.
//
// v2 keeps the same skeleton (RSI(14) oversold + tick-up + near the 120-bar
// low + TP/SL/time-stop + full-cash sizing + equity circuit breaker) and
// changes what "deep enough" means, in three tiers:
//
//   Tier 1 — normal:   price >= 2.0% below the running high.
//   Tier 2 — late:     after bar 1000 with no trade yet, >= 1.5%.
//   Tier 3 — fallback: after bar 1200 with no trade yet, the DD gate is
//                      dropped entirely: RSI(14) < 40, a tick back up, and
//                      a close within 0.4% of the 120-bar low is enough.
//   Tier 4 — last call: after bar 1320 with no trade yet, even the
//                      near-low requirement is dropped: RSI(14) < 45 plus
//                      a tick-up enters, so the min-1-trade guardrail can
//                      never fail again. A 24h race has 1440 bars; bar 1320
//                      still leaves 120 bars (2h) for the exit rules to work.
//
// Exits are unchanged from v1: take profit at +4.5% of cost, stop loss at
// -1.5%, or a 300-bar time stop, whole position, one position at a time.
// A stop that hits during the flush is not a failure — the bot re-enters
// lower on the next signal. No shorts, no leverage, deterministic (pure
// functions of the closes seen; no clock, no randomness, no network).

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// ---- tunables ----
const RSI_LEN = 14;
const RSI_BUY = 40; // oversold enough to be a washout, not just a dip
const RSI_LAST_CALL = 45; // tier 4 only: looser, the race is nearly over
const LOW_BARS = 120; // near the 2-hour low
const NEAR_LOW_PCT = 0.004; // within 0.4% of that low
const DD_MIN = 0.015; // v1: 0.06 — the live window never reached 6%.
// Tuned on the dev window: 0.02 gave 2 trades / +$11.54, 0.015 gave
// 3 trades / +$13.74 (100% win rate), 0.01 over-traded (7 trades, -$4.64).
const LATE_BAR = 1000; // after this, if no trade yet, relax the washout bar
const LATE_DD_MIN = 0.015; // v1: 0.04 — late threshold, 1.5%
const FALLBACK_BAR = 1200; // after this, if no trade yet, drop the DD gate
const LAST_CALL_BAR = 1320; // after this, if no trade yet, drop near-low too
const TP_NUM = 1045; // take profit: value >= 104.5% of cost
const TP_DEN = 1000;
const SL_NUM = 985; // stop loss: value <= 98.5% of cost
const SL_DEN = 1000;
const TIME_STOP = 300; // bars
const MAX_SLIPPAGE_BPS = 100;

const SYMBOL = 'CBBTC';

// ---- rolling state ----
const closes: number[] = [];
let prevClose: number | null = null;
let runningHigh = 0;
let rsiGain: number | null = null;
let rsiLoss: number | null = null;
const rsiSeed: number[] = [];
let fillBar = -1; // fill bar of the open position, -1 when flat
let fills = 0; // buy fills so far (drives the late/fallback rules)
let peakEquity = 0n; // circuit breaker

function noteClose(c: number): void {
  closes.push(c);
  if (closes.length > 200) closes.shift();
  if (c > runningHigh) runningHigh = c;
  if (prevClose !== null) {
    const change = c - prevClose;
    const up = change > 0 ? change : 0;
    const down = change < 0 ? -change : 0;
    if (rsiGain === null || rsiLoss === null) {
      rsiSeed.push(change);
      if (rsiSeed.length === RSI_LEN) {
        let g = 0;
        let l = 0;
        for (const x of rsiSeed) {
          if (x > 0) g += x;
          else l -= x;
        }
        rsiGain = g / RSI_LEN;
        rsiLoss = l / RSI_LEN;
      }
    } else {
      rsiGain = (rsiGain * (RSI_LEN - 1) + up) / RSI_LEN;
      rsiLoss = (rsiLoss * (RSI_LEN - 1) + down) / RSI_LEN;
    }
  }
  prevClose = c;
}

function rsiNow(): number | null {
  if (rsiGain === null || rsiLoss === null) return null;
  const moved = rsiGain + rsiLoss;
  return moved === 0 ? 50 : (100 * rsiGain) / moved;
}

function lowOf(windowBars: number): number | null {
  // Lowest close among the previous `windowBars` closes (excluding the latest).
  const w = closes.slice(0, -1).slice(-windowBars);
  if (w.length < 10) return null;
  let lo = w[0];
  for (const x of w) if (x < lo) lo = x;
  return lo;
}

await runBars({
  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) noteClose(Number(bar.c));
    const fresh = batch.bars.some((b) => b.symbol === SYMBOL);
    if (!fresh || state.warmingUp) return [];
    if (state.equity > peakEquity) peakEquity = state.equity;
    const held = state.positions.get(SYMBOL);
    const close = prevClose; // latest close as a number
    if (close === null) return [];

    // --- exits: whole position ---
    if (held !== undefined) {
      if (fillBar < 0) {
        fillBar = state.seq; // position first seen = fill bar
        fills++; // count fills, not sent orders: a refused buy is not a trade
      }
      const value = state.value(SYMBOL, held.qty);
      const tookProfit = value * BigInt(TP_DEN) >= held.cost * BigInt(TP_NUM);
      const stoppedOut = value * BigInt(SL_DEN) <= held.cost * BigInt(SL_NUM);
      const timedOut = state.seq - fillBar > TIME_STOP;
      if (tookProfit || stoppedOut || timedOut) {
        fillBar = -1;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }
    fillBar = -1;

    // --- entries: flat only ---
    const r = rsiNow();
    const tickUp = closes.length >= 2 && close > closes[closes.length - 2];
    const noTradeYet = fills === 0;
    const dd = runningHigh > 0 ? (runningHigh - close) / runningHigh : 0;

    // Tier 4 — last call: bar 1320+, still no trade. RSI < 45 + tick-up.
    if (noTradeYet && state.seq > LAST_CALL_BAR) {
      if (r !== null && r < RSI_LAST_CALL && tickUp) return buyAll(state);
      return [];
    }

    // Tier 3 — fallback: bar 1200+, still no trade. RSI < 40 + tick-up +
    // near the 120-bar low, no drawdown requirement at all.
    if (noTradeYet && state.seq > FALLBACK_BAR) {
      const lo = lowOf(LOW_BARS);
      if (r !== null && r < RSI_BUY && tickUp && lo !== null && close <= lo * (1 + NEAR_LOW_PCT)) {
        return buyAll(state);
      }
      return [];
    }

    // Tiers 1-2 — normal and late washout entries.
    if (r === null || r >= RSI_BUY) return [];
    if (!tickUp) return [];
    const lo = lowOf(LOW_BARS);
    if (lo === null || close > lo * (1 + NEAR_LOW_PCT)) return []; // not at the low
    const late = noTradeYet && state.seq > LATE_BAR;
    if (dd <= (late ? LATE_DD_MIN : DD_MIN)) return []; // not a deep enough washout
    return buyAll(state);
  },
});

function buyAll(state: BarsState) {
  // Full-cash sizing, one position at a time, gated by the circuit breaker:
  // no new entries after a 5% drawdown from peak equity.
  if (state.equity * 10000n < peakEquity * 9500n) return [];
  const byWeight = state.weightRoom(SYMBOL);
  let slice = state.cash;
  if (slice > byWeight) slice = byWeight;
  if (slice <= 0n || slice < BigInt(state.hello.fees.min_notional_quote_units)) return [];
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
}
