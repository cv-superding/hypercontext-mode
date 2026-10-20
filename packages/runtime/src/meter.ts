import type { HypercontextConfig } from "@hypercontext/core";
import type { ProxyOverview } from "./engines.ts";

export interface MeterReport {
  hasFoldData: boolean;
  tokens: {
    grossSaved: number;
    repay: number;
    summaryCost: number;
    summaryInput: number;
    summaryOutput: number;
    injectedOverhead: number;
    netUpstream: number;
    netAfterOverhead: number;
  };
  requests: {
    postFold: number;
    grossPerPostFoldRequest: number | null;
    breakEvenPostFoldRequests: number | null;
  };
  summary: {
    calls: number;
    latencyMs: number;
    averageLatencyMs: number | null;
  };
  cache: {
    inputTokens: number;
    cachedTokens: number;
    hitPct: number | null;
  };
  money: {
    configured: boolean;
    currency: string;
    saved: number;
    repay: number;
    summary: number;
    injected: number;
    net: number;
  };
}

export function buildMeter(overview: ProxyOverview, config: HypercontextConfig): MeterReport {
  const input = overview.inputTokens;
  const cached = overview.cachedTokens;
  const gross = overview.grossSaved;
  const repay = overview.repay;
  const summaryCost = overview.summaryCost;
  const summaryInput = overview.summaryInputTokens;
  const summaryOutput = overview.summaryOutputTokens;
  // The ledger's sigma is the billed summary output; where the ledger has no
  // fold rows the MEASURED output tokens are the honest stand-in.
  const summaryBilledOutput = summaryCost > 0 ? summaryCost : summaryOutput;
  const injected = overview.injectedOverheadTokens;
  const netUpstream = gross - repay - summaryBilledOutput;
  const netAfterOverhead = netUpstream - summaryInput - injected;
  const postFold = overview.postFoldRequests;
  const grossPerPostFoldRequest = postFold > 0 ? gross / postFold : null;
  const overhead = repay + summaryBilledOutput + summaryInput + injected;
  const breakEvenPostFoldRequests =
    grossPerPostFoldRequest === null || grossPerPostFoldRequest <= 0
      ? null
      : netAfterOverhead >= 0
        ? 0
        : Math.ceil(overhead / grossPerPostFoldRequest);

  const pricing = config.pricing;
  const configured =
    pricing.inputPerMTok > 0 ||
    pricing.cachedInputPerMTok > 0 ||
    pricing.outputPerMTok > 0 ||
    pricing.summaryInputPerMTok > 0 ||
    pricing.summaryOutputPerMTok > 0;
  const perMillion = 1_000_000;
  const inputRate = pricing.inputPerMTok;
  const cachedRate = pricing.cachedInputPerMTok > 0 ? pricing.cachedInputPerMTok : inputRate;
  const summaryInputRate = pricing.summaryInputPerMTok > 0 ? pricing.summaryInputPerMTok : inputRate;
  const summaryOutputRate = pricing.summaryOutputPerMTok > 0 ? pricing.summaryOutputPerMTok : pricing.outputPerMTok;
  const savedValue = (gross * inputRate) / perMillion;
  const repayValue = (repay * inputRate) / perMillion;
  const summaryValue = (summaryInput * summaryInputRate + summaryBilledOutput * summaryOutputRate) / perMillion;
  const injectedValue = (injected * cachedRate) / perMillion;

  return {
    hasFoldData: overview.hasFoldData,
    tokens: {
      grossSaved: gross,
      repay,
      summaryCost: summaryBilledOutput,
      summaryInput,
      summaryOutput,
      injectedOverhead: injected,
      netUpstream,
      netAfterOverhead,
    },
    requests: {
      postFold,
      grossPerPostFoldRequest,
      breakEvenPostFoldRequests,
    },
    summary: {
      calls: overview.summaryCalls,
      latencyMs: overview.summaryLatencyMs,
      averageLatencyMs: overview.summaryCalls > 0 ? overview.summaryLatencyMs / overview.summaryCalls : null,
    },
    cache: { inputTokens: input, cachedTokens: cached, hitPct: overview.hitPct },
    money: {
      configured,
      currency: pricing.currency,
      saved: savedValue,
      repay: repayValue,
      summary: summaryValue,
      injected: injectedValue,
      net: savedValue - repayValue - summaryValue - injectedValue,
    },
  };
}
