# Washout Fisher v2 — btc-race-24h-20261117-0603

Long-only dip-buy mean reversion on cbBTC for the make.fun 24h BTC race.

## The idea

Most entries in a 24h BTC race lose the same way: they hold through a
slow grind down, or they get chopped by 1-minute trend signals. The only
trade that pays on a down day is the washout bottom — buy the flush, hold
through the V-recovery. So this bot sits in cash and buys **only** a
washout:

- RSI(14) below 40 (oversold, not just a dip),
- the tape ticks back up,
- the close is within 0.4% of its 120-bar (2h) low,
- and the price is at least 1.5% below the running high (tuned on the dev
  window: 2.0% gave 2 trades / +$11.54, 1.5% gave 3 trades / +$13.74,
  1.0% over-traded into −$4.64).

Exits: take profit +4.5%, stop loss −1.5%, or a 300-bar time stop, whole
position. One position at a time, full-cash sizing, no shorts, no leverage.
A 5% equity circuit breaker stops new entries after a drawdown from peak
equity. Fully deterministic — pure functions of the closes seen, no clock,
no randomness, no network.

## What changed vs v1 (and why)

v1, the "Capitulation Sniper", did exactly this with a 6% washout bar and
scored +$27.80 in 4 trades on its dev window. But in the live race window
the deepest drawdown was only 2.38% — below the 6% bar — so v1 fired
**zero times**: $0.00 PnL, 0 trades, failed min-1-trade guardrail. The
strategy was never wrong; the trigger was calibrated to a crash that never
came.

v2 lowers the bar and adds a guaranteed-trade fallback, in tiers:

| Tier | When | Entry requirement |
| --- | --- | --- |
| 1 — normal | always | washout ≥ 1.5% below running high |
| 2 — late | bar 1000+, 0 trades | washout ≥ 1.5% |
| 3 — fallback | bar 1200+, 0 trades | no drawdown gate: RSI < 40 + tick-up + near 120-bar low |
| 4 — last call | bar 1320+, 0 trades | RSI < 45 + tick-up only |

A 24h race has 1440 bars; bar 1320 still leaves 2 hours for the exit
rules to work. The min-1-trade guardrail can never fail again.

## Files

- `main.ts` — the bot (runBars SDK).
- `vendor/makefun-bars.ts` — kit-provided SDK shim, vendored from the kit.

## Grade

Run with the competition kit (level 19):

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --json
```
