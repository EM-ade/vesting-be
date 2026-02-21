import { Connection, PublicKey } from '@solana/web3.js';
import { HeliusNFTService } from './heliusNFTService';
import { config, getNetwork } from '../config';

export interface AllocationRule {
  name: string;
  nftContract: string; // Collection address
  threshold: number;
  allocationType: 'PERCENTAGE' | 'FIXED';
  allocationValue: number;
  enabled?: boolean;
  weight?: number; // NEW: Weight multiplier (default: 1.0)
  description?: string; // NEW: Optional description
}

export interface EligibilityResult {
  isEligible: boolean;
  wallet: string;
  nftCount: number;
  eligibleRules: Array<{
    ruleName: string;
    allocationAmount: number;
    nftCount: number;
    weight: number; // NEW: Include weight
  }>;
  totalAllocation: number;
  weightedScore?: number; // NEW: Total weighted score for this wallet
}

export class EligibilityService {
  private heliusService: HeliusNFTService;

  constructor() {
    if (!config.heliusApiKey) {
      throw new Error('HELIUS_API_KEY is not configured');
    }
    this.heliusService = new HeliusNFTService(config.heliusApiKey, getNetwork());
  }

  /**
   * Calculate weighted allocation for a wallet
   * Formula: (nftCount * weight) / totalWeightedNFTs * poolShare
   * 
   * Note: This is a helper method for the sync process.
   * The actual allocation depends on total weighted NFTs across all holders.
   */
  calculateWeightedAllocation(
    walletNFTs: Map<string, number>, // Map of collection address -> NFT count
    rules: AllocationRule[],
    poolTotalAmount: number
  ): { totalWeightedScore: number; ruleBreakdown: Array<{ ruleName: string; weightedCount: number }> } {
    let totalWeightedScore = 0;
    const ruleBreakdown: Array<{ ruleName: string; weightedCount: number }> = [];

    for (const rule of rules.filter(r => r.enabled !== false)) {
      const nftCount = walletNFTs.get(rule.nftContract) || 0;
      
      if (nftCount >= rule.threshold) {
        const weight = rule.weight || 1.0;
        const weightedCount = nftCount * weight;
        totalWeightedScore += weightedCount;
        ruleBreakdown.push({ ruleName: rule.name, weightedCount });
      }
    }

    return { totalWeightedScore, ruleBreakdown };
  }

  /**
   * Check eligibility for a single wallet against a set of rules
   */
  async checkWalletEligibility(
    walletAddress: string,
    poolTotalAmount: number,
    rules: AllocationRule[]
  ): Promise<EligibilityResult> {
    const result: EligibilityResult = {
      isEligible: false,
      wallet: walletAddress,
      nftCount: 0,
      eligibleRules: [],
      totalAllocation: 0,
      weightedScore: 0
    };

    // Filter enabled rules
    const activeRules = rules.filter(r => r.enabled !== false);
    if (activeRules.length === 0) return result;

    // Track NFTs per collection for weighted calculation
    const walletNFTs = new Map<string, number>();

    // Check each rule
    for (const rule of activeRules) {
      try {
        // Use countNFTsFromCollections to check if wallet holds NFTs from this collection
        const collectionPubkey = new PublicKey(rule.nftContract);
        const nftCounts = await this.heliusService.countNFTsFromCollections(
          new PublicKey(walletAddress),
          [collectionPubkey]
        );

        const nftCount = nftCounts.get(rule.nftContract) || 0;

        if (nftCount >= rule.threshold) {
          // Track NFTs for this collection
          walletNFTs.set(rule.nftContract, nftCount);

          // Calculate allocation
          let allocation = 0;
          if (rule.allocationType === 'PERCENTAGE') {
            // Note: Percentage allocation usually depends on TOTAL pool participants
            // For a single check, this is tricky. We might need to assume
            // "allocationValue" is the share of the pool THIS user gets?
            // OR (more likely based on existing code) it's a pool share divided by eligible users?
            // Looking at syncDynamicPool.ts:
            // poolShare = (pool.total_pool_amount * rule.allocationValue) / 100;
            // allocationPerUser = (holder.nftCount / totalNFTs) * poolShare;

            // CRITICAL: We cannot calculate exact dynamic percentage allocation
            // for a single user without knowing the total state of the pool (all other holders).
            // FOR NOW: We will return the "potential" or "base" eligibility info.
            // The actual amount calculation logic might need to reside in the sync process
            // or return a "share" value instead of absolute tokens.

            // However, for "FIXED" type (if implemented as fixed per user), it's easier.
            // But syncDynamicPool.ts logic shows:
            // else { poolShare = rule.allocationValue; } // Fixed total amount for rule

            // It seems the current system is DESIGNED for weighted distribution.
            // Real-time check can only confirm "Yes, you qualify".
            // The exact amount is determined by the sync process.

            allocation = 0; // Placeholder, actual amount depends on total pool state
          } else {
            // Fixed amount logic from syncDynamicPool seems to be "Total Rule Share", then split.
            allocation = 0;
          }

          const weight = rule.weight || 1.0;
          result.eligibleRules.push({
            ruleName: rule.name,
            allocationAmount: allocation,
            nftCount,
            weight // Include weight in result
          });
          result.nftCount += nftCount; // Total relevant NFTs
        }
      } catch (error) {
        console.error(`Error checking rule ${rule.name} for wallet ${walletAddress}:`, error);
      }
    }

    // Calculate weighted score using the new method
    const { totalWeightedScore } = this.calculateWeightedAllocation(
      walletNFTs,
      activeRules,
      poolTotalAmount
    );
    result.weightedScore = totalWeightedScore;
    result.isEligible = result.eligibleRules.length > 0;
    return result;
  }

  /**
   * Get all eligible holders for a rule (for bulk sync)
   */
  async getEligibleHoldersForRule(
    rule: AllocationRule,
    poolTotalAmount: number
  ): Promise<Array<{ wallet: string; nftCount: number }>> {
    try {
      const holders = await this.heliusService.getAllHolders(new PublicKey(rule.nftContract));
      return holders.filter(h => h.nftCount >= rule.threshold);
    } catch (error) {
      console.error(`Error fetching holders for rule ${rule.name}:`, error);
      throw error;
    }
  }
}
