# Work notes

makefun anchor 512327ece1c317d0ba5ae7f270c132f4b017b480 round 34075016

## PASS 01 of 05 — vendor shim and scaffold

- Copied the kit SDK byte-for-byte to `vendor/makefun-bars.ts` with a single `cp`
  (verified with `cmp` against the kit's `sdk/makefun-bars.ts`). The copy is not edited.
- Wrote a first `main.ts` scaffold: imports `runBars` and `BPS` from `./vendor/makefun-bars.ts`,
  defines `RSI_PERIOD=21`, `RSI_ENTER=15`, `RSI_EXIT=55`, `SYMBOL='CBBTC'`, `MAX_SLIPPAGE_BPS=200`,
  sketches the Wilder RSI state object and `stepRsi`, updates RSI from any CBBTC bar in each
  batch, and returns `[]` for now.
- README not written yet. LICENSE and `.makefun/freshness.json` untouched.

Protocol terms: the harness sends `hello` once (universe, capital, caps, fees, seed), then one
`batch` per minute with that minute's bar, fills, and account, then `done`. The bot replies to every
`batch` with exactly one JSON line of type `reply` echoing the batch seq and an orders array.
Orders decided on a bar fill at the next bar's open (latency 1).

## PASS 02 of 05 — Wilder RSI strategy in main.ts

- Finished `stepRsi` exactly as specified (N=21): first close seeds prev only, RSI undefined until
  N=21 change observations (seen == N+1 closes), first averages are the plain sums of the first 21
  gains/losses divided by N, then Wilder smoothing `(avg*(N-1) + x)/N`. Edge cases: avgLoss === 0 ->
  RSI 100, avgGain === 0 -> RSI 0, else `100 - 100/(1 + avgGain/avgLoss)`. Float64 only.
- `onBatch`: folds every CBBTC bar's close (Number(bar.c)) into the RSI state, returns [] while
  state.warmingUp, clears the sticky exit flag when flat. Holding CBBTC with RSI >= 55 arms a sticky
  exit that sells the full held qty (max_slippage_bps 200) every batch until flat, even if RSI dips
  back. With no CBBTC position and RSI defined and <= 15, buys once with notional
  min(cash, max_weight_bps * equity / BPS) provided that notional is at least
  fees.min_notional_quote_units. Rejections retry naturally on later batches while the signal holds.
- No other symbols traded. No README yet. LICENSE and `.makefun/freshness.json` untouched.
