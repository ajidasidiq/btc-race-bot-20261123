// Amba BTC race bot — cbBTC/USDC, 1-minute bars, long only, $1,000 paper.
//
// Idea, in one paragraph: one-minute BTC noise is far smaller than the ~26 bps
// a full round trip costs, so the bot only trades moves big enough to pay for
// themselves. It buys in two situations and never chases anything smaller:
//  (1) a dip buy — price within 0.2% of its 8-hour rolling low while still
//      above 99.5% of its 12-hour EMA (a dip inside an intact uptrend), sold
//      when price reaches back to the 8-hour rolling high;
//  (2) a breakout buy — price closes 0.3% above its 8-hour rolling high
//      (a genuine range break, not noise), ridden with a trailing stop.
// Every position carries a hard 1% stop below its fill and a 1.5% trailing
// stop below its peak, so a crash costs at most ~1.5% and a slow bleed is
// exited on the stop, while chop is left alone: no trade, no fee.
//
// Everything is deterministic: no clock, no randomness, no environment reads.
// Decisions use only the bars the harness has already sent.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

// --- tunables (chosen on the kit's published dev window; see README) ---
const LOOKBACK = 480; // 8h rolling range, in bars
const MIN_HISTORY = 60; // bars of history before the first trade
const DIP_OFF_BPS = 20; // dip buy: within 0.20% above the rolling low
const BREAKOUT_BPS = 30; // breakout buy: 0.30% above the rolling high
const TOP_OFF_BPS = 10; // dip exit: within 0.10% below the rolling high
const STOP_BPS = 100; // hard stop: 1.00% below the fill price
const TRAIL_BPS = 150; // trailing stop: 1.50% below the peak since entry
const EMA_PERIOD = 720; // 12h trend filter
const MA_GATE_BPS = 9950; // dip buy only above 99.50% of the 12h EMA
const MAX_SLIPPAGE_BPS = 150; // cap what a fill may move from the last close
const NO_ENTRY_AFTER_BARS = 1430; // don't open a position in the final bars

const SYMBOL = 'CBBTC';

let priceScale = 5;
let qtyScale = 8;

// Bars already seen, NOT including the bar being answered.
const prevCloses: number[] = [];
const prevHighs: number[] = [];
const prevLows: number[] = [];

// 12h EMA of closes, updated with each bar as it arrives (seeded at first close).
let ema = 0;
let emaSeeded = false;

type EntryKind = 'dip' | 'breakout';
let entryKind: EntryKind | null = null;
let entryPrice = 0; // fill price of the open position, USDC
let peakSinceEntry = 0; // highest close since entry, USDC
let pendingOrderId: string | null = null;
let pendingKind: EntryKind | null = null;
let scoredBars = 0; // bars in the scored window (after any warm-up)

function toUsd(raw: string): number {
  return Number(raw) / 10 ** priceScale;
}

function rollingLow(): number {
  let lo = Infinity;
  const start = Math.max(0, prevLows.length - LOOKBACK);
  for (let i = start; i < prevLows.length; i++) if (prevLows[i] < lo) lo = prevLows[i];
  return lo;
}

function rollingHigh(): number {
  let hi = -Infinity;
  const start = Math.max(0, prevHighs.length - LOOKBACK);
  for (let i = start; i < prevHighs.length; i++) if (prevHighs[i] > hi) hi = prevHighs[i];
  return hi;
}

await runBars({
  onHello(state) {
    const sym = state.symbols.get(SYMBOL);
    if (sym) {
      priceScale = sym.price_scale;
      qtyScale = sym.qty_scale;
    }
  },

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Resolve the order sent on the previous batch from this batch's fills.
    if (pendingOrderId !== null) {
      for (const f of batch.fills) {
        if (f.client_id === pendingOrderId) {
          if (f.status === 'filled' && f.side === 'buy' && pendingKind !== null) {
            entryKind = pendingKind;
            entryPrice = toUsd(f.price);
            peakSinceEntry = entryPrice;
          }
          break;
        }
      }
      pendingOrderId = null;
      pendingKind = null;
    }

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return []; // gap minute: no new information, no orders

    const close = toUsd(bar.c);
    const high = toUsd(bar.h);
    const low = toUsd(bar.l);

    // Update the trend filter with this bar's close (EMA includes the current bar).
    if (!emaSeeded) {
      ema = close;
      emaSeeded = true;
    } else {
      const k = 2 / (EMA_PERIOD + 1);
      ema = close * k + ema * (1 - k);
    }

    if (!state.warmingUp) scoredBars += 1;

    const pos = state.positions.get(SYMBOL);
    const heldQty = pos === undefined ? 0n : pos.qty;
    const holding = heldQty > 0n;
    if (!holding) {
      entryKind = null;
      entryPrice = 0;
      peakSinceEntry = 0;
    }

    let orders: OrderInput[] = [];

    if (holding && entryKind !== null && entryPrice > 0) {
      // --- exits ---
      if (close > peakSinceEntry) peakSinceEntry = close;
      const rollHigh = rollingHigh();
      const stopHit = close <= entryPrice * (1 - STOP_BPS / 10000);
      const trailHit = close <= peakSinceEntry * (1 - TRAIL_BPS / 10000);
      const topHit =
        entryKind === 'dip' &&
        rollHigh !== -Infinity &&
        close >= rollHigh * (1 - TOP_OFF_BPS / 10000);
      if (stopHit || trailHit || topHit) {
        orders = [
          {
            side: 'sell',
            symbol: SYMBOL,
            qty: heldQty.toString(),
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          },
        ];
      }
    } else if (
      !holding &&
      !state.warmingUp &&
      prevCloses.length >= MIN_HISTORY &&
      scoredBars < NO_ENTRY_AFTER_BARS
    ) {
      // --- entries (rolling range uses bars before this one) ---
      const rollLow = rollingLow();
      const rollHigh = rollingHigh();
      const dipBuy =
        rollLow !== Infinity &&
        close <= rollLow * (1 + DIP_OFF_BPS / 10000) &&
        close >= ema * (MA_GATE_BPS / 10000);
      const breakoutBuy =
        rollHigh !== -Infinity && close >= rollHigh * (1 + BREAKOUT_BPS / 10000);
      const kind: EntryKind | null = dipBuy ? 'dip' : breakoutBuy ? 'breakout' : null;
      if (kind !== null) {
        const room = state.weightRoom(SYMBOL);
        const notional = state.cash < room ? state.cash : room;
        if (notional >= 1_000_000n) {
          // 1 USDC minimum notional
          const id = state.clientId();
          pendingOrderId = id;
          pendingKind = kind;
          orders = [
            {
              side: 'buy',
              client_id: id,
              symbol: SYMBOL,
              notional_quote_units: notional.toString(),
              max_slippage_bps: MAX_SLIPPAGE_BPS,
            },
          ];
        }
      }
    }

    // Record this bar in history AFTER deciding (decisions use prior bars only).
    prevCloses.push(close);
    prevHighs.push(high);
    prevLows.push(low);
    return orders;
  },
});
