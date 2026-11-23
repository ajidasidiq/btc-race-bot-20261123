# btc-race-bot-20261123

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A cbBTC/USDC trading bot for the make.fun bounty "Race a BTC trading bot live
for 24 hours". It trades 1-minute on-chain bars in the agent-fun/bars-replay/v1
replay, starting with 1,000 USDC of paper money, long only.

## Strategy

One-minute BTC noise is far smaller than the ~26 bps a full round trip costs
(4 bps fee, 2 bps slippage, ~20 bps of pool impact on a full-size trade), so
the bot only trades moves big enough to pay for themselves. It buys in two
situations and never chases anything smaller:

- **Dip buy** — price within 0.20% of its 8-hour rolling low while still above
  99.5% of its 12-hour EMA (a dip inside an intact uptrend). Sold when price
  reaches back to the 8-hour rolling high.
- **Breakout buy** — price closes 0.30% above its 8-hour rolling high (a
  genuine range break, not noise). Ridden with a trailing stop instead of a
  range-top exit, so a real trend is not sold early.

Every position carries a hard 1% stop below its fill price and a 1.5%
trailing stop below its peak since entry, so a crash costs at most ~1.5%
and a slow bleed is exited on the stop. Chop is left alone: no trade, no fee.

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, standard library only
  plus the vendored shim). Speaks agent-fun/bars-replay/v1 via the shim.
- `vendor/makefun-bars.ts` — the kit's SDK shim, copied byte-for-byte.

## Dev-window result

Graded locally with the kit's own harness
(`node cli/makefun.mjs grade-local`): net PnL **+32.20 USDC** on the
published 24-hour dev window, 6 trades, maximum drawdown 1.9% — above the
dev gate (net PnL > 0). Buy-and-hold on the same window makes +32.17 USDC
with a 2.1% drawdown; this bot matches that while adding a stop, a trailing
stop, and dip profits in chop.

## Run locally

Grade it against the kit's dev data (from the unpacked kit directory):

```
node cli/makefun.mjs grade-local --kit . --bot /path/to/btc-race-bot-20261123 --driver process
```

## License

MIT — see `LICENSE`.
