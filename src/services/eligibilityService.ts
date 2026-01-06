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
}

export interface EligibilityResult {
  isEligible: boolean;
  wallet: string;
  nftCount: number;
  eligibleRules: Array<{
    ruleName: string;
    allocationAmount: number;
    nftCount: number;
  }>;
  totalAllocation: number;
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
      totalAllocation: 0
    };

    // Filter enabled rules
    const activeRules = rules.filter(r => r.enabled !== false);
    if (activeRules.length === 0) return result;

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

          result.eligibleRules.push({
            ruleName: rule.name,
            allocationAmount: allocation,
            nftCount
          });
          result.nftCount += nftCount; // Total relevant NFTs
        }
      } catch (error) {
        console.error(`Error checking rule ${rule.name} for wallet ${walletAddress}:`, error);
      }
    }

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
