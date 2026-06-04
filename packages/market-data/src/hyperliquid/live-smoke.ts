import {
  HyperliquidInfoClient,
  normalizeHyperliquidCandleSnapshot,
  normalizeHyperliquidFundingHistory,
  normalizeHyperliquidL2Book,
  normalizeHyperliquidMetaAndAssetCtxs
} from "./index.js";

if (process.env.RUN_HYPERLIQUID_LIVE !== "1") {
  console.log("Skipping live Hyperliquid smoke. Set RUN_HYPERLIQUID_LIVE=1 to run.");
  process.exit(0);
}

const client = new HyperliquidInfoClient();
const receivedAt = new Date().toISOString();
const endTime = Date.now();
const startTime = endTime - 60 * 60 * 1000;

const meta = await client.metaAndAssetCtxs();
const book = await client.l2Book({ coin: "BTC" });
const candles = await client.candleSnapshot({
  coin: "BTC",
  interval: "15m",
  startTime,
  endTime
});
const funding = await client.fundingHistory({
  coin: "BTC",
  startTime,
  endTime
});

const normalizedMeta = normalizeHyperliquidMetaAndAssetCtxs(meta, {
  received_at: receivedAt,
  raw_ref: "live/hyperliquid/meta-and-asset-ctxs"
});
const normalizedBook = normalizeHyperliquidL2Book(book, {
  received_at: receivedAt,
  raw_ref: "live/hyperliquid/l2-book/BTC"
});
const normalizedCandles = normalizeHyperliquidCandleSnapshot(candles, {
  received_at: receivedAt,
  raw_ref: "live/hyperliquid/candles/BTC"
});
const normalizedFunding = normalizeHyperliquidFundingHistory(funding, {
  received_at: receivedAt,
  raw_ref: "live/hyperliquid/funding/BTC"
});

console.log(
  JSON.stringify(
    {
      registry_entries: normalizedMeta.registry.length,
      btc_book_depth: normalizedBook.depth,
      candles: normalizedCandles.length,
      funding_records: normalizedFunding.length
    },
    null,
    2
  )
);
