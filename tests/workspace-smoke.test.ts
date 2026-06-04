import { describe, expect, it } from "vitest";
import { backtestingPackageName } from "@openstrat/backtesting";
import { domainPackageName } from "@openstrat/domain";
import { marketDataPackageName } from "@openstrat/market-data";
import { persistencePackageName } from "@openstrat/persistence";
import { riskPackageName } from "@openstrat/risk";
import { strategySdkPackageName } from "@openstrat/strategy-sdk";
import { workersPackageName } from "@openstrat/workers";

describe("workspace package surface", () => {
  it("exposes the initial backend package boundaries", () => {
    expect([
      domainPackageName,
      persistencePackageName,
      marketDataPackageName,
      backtestingPackageName,
      riskPackageName,
      strategySdkPackageName,
      workersPackageName
    ]).toEqual([
      "@openstrat/domain",
      "@openstrat/persistence",
      "@openstrat/market-data",
      "@openstrat/backtesting",
      "@openstrat/risk",
      "@openstrat/strategy-sdk",
      "@openstrat/workers"
    ]);
  });
});
