#!/usr/bin/env node
import { FileObjectStore } from "@openstrat/persistence";
import { z } from "zod";
import {
  HyperliquidCandleIntervalSchema,
  HyperliquidInfoClient,
  ingestHyperliquidWindow
} from "../hyperliquid/index.js";

const args = parseArgs(process.argv.slice(2));
const startTime = parseTimeArg(args.start);
const endTime = parseTimeArg(args.end);
const store = new FileObjectStore(args.store);
const client = new HyperliquidInfoClient(
  args.endpoint === undefined ? {} : { endpoint: args.endpoint }
);

const result = await ingestHyperliquidWindow({
  client,
  object_store: store,
  coin: args.symbol,
  interval: args.interval,
  start_time_ms: startTime,
  end_time_ms: endTime
});

console.log(JSON.stringify(result, null, 2));

const CliArgsSchema = z.object({
  symbol: z.string().min(1),
  interval: HyperliquidCandleIntervalSchema,
  start: z.string().min(1),
  end: z.string().min(1),
  store: z.string().min(1),
  endpoint: z.string().url().optional()
});

type CliArgs = z.infer<typeof CliArgsSchema>;

function parseArgs(argv: string[]): CliArgs {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    parsed[key] = value;
    index += 1;
  }

  return CliArgsSchema.parse(parsed);
}

function parseTimeArg(value: string): number {
  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid time value: ${value}`);
  }
  return parsed;
}
