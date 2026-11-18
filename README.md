# makefun-btc-race-24h

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/japanstorehk-png/makefun-btc-race-24h/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/japanstorehk-png/makefun-btc-race-24h/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

An original long-only paper-trading bot for the make.fun `btc-race-24h-20261118-1444` competition (protocol `agent-fun/bars-replay/v1`), trading only `CBBTC`.

## Protocol

- The harness sends **hello** once with the universe, capital, caps, fees, and seed.
- It then sends one **batch** per minute containing that minute's **bar**, fills, and account state.
- The bot replies to every batch with exactly one JSON line of type `reply`, echoing the batch `seq` and carrying an `orders` array (empty is fine).
- Orders decided on a bar fill at the next bar's open (latency 1); a sell's proceeds do not fund buys in the same reply, and last-bar orders are rejected (`after_end`).
- Long only — no shorts, no leverage, one open position, cash never below 0, buy up to 100% of equity, at most 16 orders per reply, min notional 1 USDC.
- Fully deterministic: no wall clock, no `Math.random`, no env; two runs match byte-for-byte.

## Strategy: Wilder RSI mean reversion

Wilder RSI on each `CBBTC` bar close with period **N = 21**, using `Number(bar.c)`:

- The first close seeds `prev` only; RSI stays undefined until `N + 1` closes have been seen.
- `change = close - prev`, `gain = max(change, 0)`, `loss = max(-change, 0)`.
- First averages: `avgGain = sum(gains) / N` and `avgLoss = sum(losses) / N` after the first `N` changes.
- Then `avgGain = (avgGain * (N - 1) + gain) / N` (and the same for `avgLoss`) — Wilder smoothing.
- If `avgLoss === 0` → RSI 100; else if `avgGain === 0` → RSI 0; else `RSI = 100 - 100 / (1 + avgGain / avgLoss)`.

Rules:

- **Enter:** no position, not warming up, RSI defined and **RSI <= 15**, and cash/notional at least `fees.min_notional_quote_units` → buy once with `notional = min(state.cash, caps.max_weight_bps * state.equity / BPS)`.
- **Exit:** with a position held and **RSI >= 55**, arm a sticky exit; keep sending a SELL of the full held qty on later batches until flat, even if RSI dips back below 55. The sticky flag clears when flat.
- While `state.warmingUp` is true, return no orders.
- Every order carries `max_slippage_bps = 200`.
- Rejected orders are retried on later batches while the signal still holds (oversold for buys, sticky exit for sells).

## Run it

```sh
node /bot/main.ts
```

<sub>Entered on [make.fun](https://make.fun/?ref=m06ej7dd&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
