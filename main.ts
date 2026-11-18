// Original long-only paper-trading bot for make.fun competition btc-race-24h-20261118-1444
// (protocol agent-fun/bars-replay/v1).
//
// Protocol, in this bot's own words:
//   - The harness sends the `hello` message once (universe, capital, caps, fees, seed); the vendor
//     shim runBars reads it and drives the callbacks below.
//   - Then it sends one `batch` per minute with that minute's `bar`, the fills from our previous
//     reply, and the account, and finally `done`.
//   - Every `batch` is answered with exactly one JSON line of type "reply" echoing that batch's seq
//     plus an `orders` array (empty is fine). runBars does the wire for us.
//   - Orders decided on a bar fill at the next bar's open (latency 1); a sell's proceeds do not fund
//     buys in the same reply; last-bar orders are rejected (after_end).
//
// Strategy: Wilder RSI mean-reversion on the CBBTC bar close — buy oversold, sell overbought, and
// hold a sticky exit until flat. Long only, no shorts, no leverage, one open position, cash never
// negative, at most one order per reply, min notional from hello.fees.
// Deterministic: no Date, no wall clock, no Math.random, no env, no network — two runs match
// byte-for-byte.
//
// Official init anchor: makefun anchor 512327ece1c317d0ba5ae7f270c132f4b017b480 round 34075016

import { runBars, BPS } from './vendor/makefun-bars.ts';
import type { Batch, BarsState, OrderInput } from './vendor/makefun-bars.ts';

const RSI_PERIOD = 21;
const RSI_ENTER = 15;
const RSI_EXIT = 55;
const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 200;

/** Wilder RSI state, folded forward one CBBTC close at a time. Float64 only. */
interface WilderRsi {
  period: number;
  /** Previous close (Number(bar.c), exact in float64 safe integers), null before the first close. */
  prevClose: number | null;
  /** Number of closes seen so far. */
  seen: number;
  /** Number of change observations so far. */
  changes: number;
  /** Running sums over the first `period` changes (used until avgGain/avgLoss are seeded). */
  sumGain: number;
  sumLoss: number;
  /** Wilder-smoothed averages; meaningful once changes >= period. */
  avgGain: number;
  avgLoss: number;
  /** Defined once seen == period + 1 closes; otherwise null (warming up). */
  rsi: number | null;
}

function initRsi(period: number): WilderRsi {
  return {
    period,
    prevClose: null,
    seen: 0,
    changes: 0,
    sumGain: 0,
    sumLoss: 0,
    avgGain: 0,
    avgLoss: 0,
    rsi: null,
  };
}

/** Fold one close into the Wilder RSI state: first averages after N changes, then Wilder smoothing. */
function stepRsi(s: WilderRsi, close: number): void {
  s.seen += 1;
  if (s.prevClose === null) {
    // First close seeds prev only; no change observation yet.
    s.prevClose = close;
    return;
  }
  const change = close - s.prevClose;
  const gain = change > 0 ? change : 0;
  const loss = change < 0 ? -change : 0;
  s.prevClose = close;
  s.changes += 1;
  if (s.changes < s.period) {
    s.sumGain += gain;
    s.sumLoss += loss;
    return;
  }
  if (s.changes === s.period) {
    // First averages after the first N changes.
    s.sumGain += gain;
    s.sumLoss += loss;
    s.avgGain = s.sumGain / s.period;
    s.avgLoss = s.sumLoss / s.period;
  } else {
    // Wilder smoothing.
    s.avgGain = (s.avgGain * (s.period - 1) + gain) / s.period;
    s.avgLoss = (s.avgLoss * (s.period - 1) + loss) / s.period;
  }
  if (s.avgLoss === 0) s.rsi = 100;
  else if (s.avgGain === 0) s.rsi = 0;
  else s.rsi = 100 - 100 / (1 + s.avgGain / s.avgLoss);
}

const rsi = initRsi(RSI_PERIOD);
/**
 * Sticky exit flag: armed when RSI >= RSI_EXIT while a CBBTC position is held.
 * Cleared ONLY when the position is gone (held qty is 0 / no entry) — never while a sell is still
 * working, so the sell keeps being re-sent even if RSI dips back below 55.
 */
let stickyExit = false;

await runBars({
  /**
   * Called once per `batch` (one minute of bars + fills + account). Returns the `orders` array for
   * the single "reply" JSON line that echoes this batch's seq.
   */
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // 1) Fold this batch's bars into the RSI state before deciding anything.
    // Safety guard: a batch can carry no bars at all (or none for CBBTC) — skip folding rather than
    // iterating a missing array; the RSI state simply stays as-is and decisions use the last value.
    const bars = Array.isArray(batch.bars) ? batch.bars : [];
    for (const bar of bars) {
      if (bar == null || bar.symbol !== SYMBOL) continue;
      // The bar close used for RSI: Number(bar.c) — CBBTC closes are exact in float64 safe integers.
      stepRsi(rsi, Number(bar.c));
    }
    // 2) Warm-up batches (hello.warmup_bars) are not scored: return no orders while they last.
    if (state.warmingUp) return [];

    // 3) Decide the orders array for this reply (at most one order; long only).
    const orders: OrderInput[] = [];
    const held = state.positions.get(SYMBOL);
    const heldQty = held?.qty ?? 0n;
    if (heldQty > 0n) {
      // Position open: arm the sticky exit when RSI is overbought.
      if (rsi.rsi !== null && rsi.rsi >= RSI_EXIT) stickyExit = true;
      // Sticky exit: keep sending a SELL of the full held qty on later batches until the position is
      // flat, even if RSI dips back below 55. (Rejected sells come back on the next batch's fills and
      // are retried here while the flag is still set.)
      if (stickyExit) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: heldQty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    } else {
      // Flat: this is the only place stickyExit is cleared — the position is gone.
      stickyExit = false;
      // Entry: oversold RSI with enough cash/notional for hello.fees.min_notional_quote_units.
      // (A rejected buy comes back on the next batch's fills and is retried while RSI stays <= 15.)
      if (rsi.rsi !== null && rsi.rsi <= RSI_ENTER) {
        const maxByWeight = (BigInt(state.hello.caps.max_weight_bps) * state.equity) / BPS;
        const notional = state.cash < maxByWeight ? state.cash : maxByWeight;
        if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
          orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      }
    }
    // The orders returned here become the `orders` array of this batch's one "reply" JSON line.
    return orders;
  },
});
