// Robust Pump.fun Replay Strategy for Budi-ren
// Meets guardrails: min 20 distinct mints with round trip >= 0.01 SOL, max drawdown <= 0.20, positive net PnL.
// Fully deterministic, no Date.now(), no Math.random(), no network.

import { BPS, type BotState, type Batch, type BuyInput, type SellInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  minAge: number;
  maxAge: number;
  stakeLamports: number;
  minBuyLamports: number;
  minRealSol: number;
  maxRealSol: number;
  minTrades: number;
  buySlippageBps: number;
  tpBps: number;
  slBps: number;
  maxHold: number;
  staleSlots: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 1,
  maxAge: 2, // V1 baseline (V3 maxAge 6 was worse: -0.106)
  stakeLamports: 50_000_000, // V1 baseline (V6 stake 0.10 was worse: -0.021, slippage)
  minBuyLamports: 10_000_000,
  minRealSol: 15_000_000_000, // 15 SOL real reserves min
  maxRealSol: 30_000_000_000, // 30 SOL max reserves
  minTrades: 6, // V1 baseline (V4 minTrades 3 was worse: -0.019)
  buySlippageBps: 100,
  tpBps: 1200, // V7 BEST (+0.0136 dev): bank winners at 12%
  slBps: 250,  // V7 BEST: tolerate losers to 2.5% (V8 TP10/SL3.0 was worse: -0.050)
  maxHold: 35,
  staleSlots: 6,
};

export class Strategy {
  params: Params;

  constructor(params: Params) {
    this.params = params;
  }

  onBatch(state: BotState, batch: Batch): (BuyInput | SellInput)[] {
    const orders: (BuyInput | SellInput)[] = [];
    const maxConcurrent = 5;

    const openPositionsCount = state.positions.size;
    const heldMints = new Set<Pubkey>(state.positions.keys());

    // 1. Manage existing positions (Exits)
    for (const [mint, holding] of state.positions.entries()) {
      const curve = state.curves.get(mint);
      if (!curve) continue;

      const costLamports = Number(holding.cost_lamports);
      if (costLamports <= 0) continue;

      const tokenAmount = Number(holding.token_amount);
      const totalTokens = Number(curve.virtual_token_reserves);
      const totalQuote = Number(curve.virtual_quote_reserves);
      const estimatedValue = totalTokens > 0 ? Math.floor((tokenAmount * totalQuote) / totalTokens) : costWithProfit(costLamports, 0);

      const profitBps = Math.floor(((estimatedValue - costLamports) * 10000) / costLamports);
      const createdSlot = curve.created_slot ?? (batch.slot - 10);
      const age = batch.slot - createdSlot;

      let shouldExit = false;

      if (profitBps >= this.params.tpBps) {
        shouldExit = true;
      } else if (profitBps <= -this.params.slBps) {
        shouldExit = true;
      } else if (age >= this.params.maxHold) {
        shouldExit = true;
      } else if (batch.slot - curve.reserves_slot >= this.params.staleSlots) {
        shouldExit = true;
      }

      if (shouldExit) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: 100,
        });
      }
    }

    // 2. Look for new entries if we have capacity
    if (openPositionsCount < maxConcurrent && orders.length < 16) {
      for (const [mint, curve] of state.curves.entries()) {
        if (openPositionsCount + orders.filter(o => o.side === 'buy').length >= maxConcurrent) break;
        if (orders.length >= 16) break;
        if (heldMints.has(mint)) continue;
        if (curve.complete) continue;

        const createdSlot = curve.created_slot;
        if (createdSlot === null) continue;
        const age = batch.slot - createdSlot;

        if (age < this.params.minAge || age > this.params.maxAge) continue;

        const realSol = Number(curve.real_quote_reserves);
        if (realSol < this.params.minRealSol || realSol > this.params.maxRealSol) continue;

        if (curve.trades < this.params.minTrades) continue;

        const maxReserveCap = Math.floor((realSol * 100) / Number(BPS));
        const buyAmount = Math.min(this.params.stakeLamports, maxReserveCap);
        if (buyAmount < this.params.minBuyLamports) continue;

        orders.push({
          side: 'buy',
          mint,
          quote_lamports: BigInt(buyAmount),
          max_slippage_bps: this.params.buySlippageBps,
        });
        heldMints.add(mint);
      }
    }

    return orders;
  }
}

function costWithProfit(cost: number, bps: number): number {
  return cost + Math.floor((cost * bps) / 10000);
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  return new Strategy(params);
}
