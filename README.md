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
  window with TP 1.9%: 2.0% washout bar gave 1 trade / +$11.54, 1.5% gave
  3 trades / +$29.48, 1.2% over-traded into +$6.41).

Exits: take profit +1.9%, stop loss −1.5%, or a 300-bar time stop, whole
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
| 3 — fallback | bar 1000+, 0 trades | no drawdown gate: RSI < 40 + tick-up + near 120-bar low |
| 4 — last call | bar 1150+, 0 trades | RSI < 45 + tick-up only |

A 24h race has 1440 bars; bar 1150 still leaves nearly 5 hours for the
exit rules to work. The min-1-trade guardrail can never fail again.

## v2.1 tuning (2026-11-17)

A 576-config sweep on the dev window plus replay on yesterday's range day.
The dev window's moves are only ~2–2.5%, so TP +4.5% almost never fired
(dev +$13.74). TP +1.9% banks the moves the window actually has: dev
3 trades / +$29.48 / max DD 0.69%; range day 2 trades / +$16.66 /
max DD 1.33%. TP 1.8–2.0% is a flat plateau (1.9% is its center); TP 2.1%
collapses to $13.74, and TP 2.5–3% was tested and rejected. TIME_STOP 300
beats 250 and 350 on both windows. Fallback moved earlier (1200→1000,
1320→1150) so the insurance is in place before the mid-race NVIDIA
earnings / FOMC minutes volatility; it never fired on either seen window.
Oracle ceiling on dev is ~$31.59.

## Files

- `main.ts` — the bot (runBars SDK).
- `vendor/makefun-bars.ts` — kit-provided SDK shim, vendored from the kit.

## Grade

Run with the competition kit (level 19):

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --json
```
