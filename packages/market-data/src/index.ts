import type {
  Candle,
  CandleInterval,
  MarketDatum,
  MarketRegistryEntry,
  OrderbookSnapshot
} from "@openstrat/domain";

export const marketDataPackageName = "@openstrat/market-data" as const;

export interface MarketDataQuery {
  canonical_symbol: string;
  source?: string;
  venue?: string;
}

export interface CandleQuery extends MarketDataQuery {
  interval: CandleInterval;
  start_at: string;
  end_at: string;
}

export interface OrderbookQuery extends MarketDataQuery {
  depth: number;
}

export interface MarketDataReader {
  getMarket(canonicalSymbol: string): Promise<MarketRegistryEntry | undefined>;
  getLatestPrice(query: MarketDataQuery): Promise<MarketDatum>;
  getCandles(query: CandleQuery): Promise<Candle[]>;
  getOrderbookSnapshot(query: OrderbookQuery): Promise<OrderbookSnapshot>;
}
