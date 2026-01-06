import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { Metaplex } from '@metaplex-foundation/js';
import { NFTChecker } from './nftChecker';
import { VestingService } from './vestingService';
import { SupabaseService } from './supabaseService';
import { VestingModeService } from './vestingModeService';
import { HeliusNFTService } from './heliusNFTService';
import { SnapshotResult, VestingConfig, VestingMode } from '../types';
import { config, getNetwork } from '../config';

/**
 * Snapshot Vesting Service
 * Takes a snapshot of NFT holders and creates vestings for all eligible users at once
 */
export class SnapshotVestingService {
  private metaplex: Metaplex;

  constructor(
    private connection: Connection,
    private nftChecker: NFTChecker,
    private dbService: SupabaseService,
    private vestingService: VestingService,
    private modeService: VestingModeService,
    private adminKeypair: Keypair
  ) {
    this.metaplex = Metaplex.make(connection);
  }

  /**
   * Take snapshot and create all vestings at once
   */
  async takeSnapshotAndCreateVestings(
    collectionAddress: PublicKey,
    vestingConfig: Omit<VestingConfig, 'recipient'>
  ): Promise<SnapshotResult> {
    console.log('📸 Taking NFT holder snapshot...');
    console.log(`Collection: ${collectionAddress.toBase58()}\n`);

    const result: SnapshotResult = {
      totalWallets: 0,
      eligible: 0,
      vestingsCreated: 0,
      errors: [],
      tierBreakdown: {},
    };

    try {
      // Set mode to snapshot
      await this.modeService.setMode(VestingMode.SNAPSHOT, this.adminKeypair.publicKey.toBase58());

      // Get all NFT holders from collection
      console.log('Fetching NFT holders...');
      const holders = await this.getAllNFTHolders(collectionAddress);
      result.totalWallets = holders.length;

      console.log(`Found ${holders.length} NFT holders\n`);

      // Check eligibility for each using Helius
      console.log('Checking eligibility...');
      const eligibleUsers: Array<{ wallet: string; nftCount: number; tier: number }> = [];
      const helius = new HeliusNFTService(config.heliusApiKey, getNetwork());

      for (const holder of holders) {
        try {
          // Use Helius to count NFTs
          const nftCount = await helius.countAllNFTs(new PublicKey(holder.wallet));
          const tier = this.getTierForNFTCount(nftCount);

          if (tier) {
            eligibleUsers.push({ wallet: holder.wallet, nftCount, tier });
            result.eligible++;
          }
        } catch (error) {
          result.errors.push(
            `Failed to check ${holder.wallet}: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }

      console.log(`✅ ${result.eligible} eligible users found\n`);

      // Calculate allocations per tier
      const tierAllocations = this.calculateTierAllocations(eligibleUsers);

      // Display tier breakdown
      console.log('Tier breakdown:');
      for (const [tier, allocation] of Object.entries(tierAllocations)) {
        const wallets = Object.keys(allocation);
        const tokensPerUser = allocation[wallets[0]];
        const totalTokens = tokensPerUser * wallets.length;

        result.tierBreakdown[parseInt(tier)] = {
          users: wallets.length,
          tokensPerUser,
          totalTokens,
        };

        console.log(
          `  Tier ${tier}: ${wallets.length} users × ${tokensPerUser.toLocaleString()} tokens = ${totalTokens.toLocaleString()} total`
        );
      }

      console.log('\nCreating vestings...');

      // Calculate grace period end
      const gracePeriodEnd = new Date(vestingConfig.endTime * 1000);
      gracePeriodEnd.setDate(gracePeriodEnd.getDate() + config.gracePeriodDays);

      // Create vestings for all eligible users
      for (const user of eligibleUsers) {
        try {
          const allocation = tierAllocations[user.tier][user.wallet];

          // Create vesting stream
          const vestingData = await this.vestingService.createVesting(this.adminKeypair, {
            ...vestingConfig,
            recipient: new PublicKey(user.wallet),
            totalAmount: allocation,
          });

          // Save to database
          await this.dbService.createVesting({
            user_wallet: user.wallet,
            nft_count: user.nftCount,
            streamflow_stream_id: vestingData.streamflowId,
            token_amount: allocation,
            vesting_mode: 'snapshot',
            snapshot_locked: true,
            claim_verification_enabled: true,
            grace_period_end: gracePeriodEnd.toISOString(),
          });

          result.vestingsCreated++;
          console.log(`  ✅ Created vesting for ${user.wallet}: ${allocation.toLocaleString()} tokens`);
        } catch (error) {
          result.errors.push(
            `Failed to create vesting for ${user.wallet}: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`
          );
        }
      }

      // Save snapshot date
      await this.modeService.updateSnapshotDate(new Date());

      console.log('\n📊 SNAPSHOT COMPLETE');
      console.log(`Total wallets checked: ${result.totalWallets}`);
      console.log(`Eligible users: ${result.eligible}`);
      console.log(`Vestings created: ${result.vestingsCreated}`);
      console.log(`Errors: ${result.errors.length}`);

      if (result.errors.length > 0) {
        console.log('\n⚠️  Errors:');
        result.errors.slice(0, 10).forEach((e) => console.log(`  - ${e}`));
        if (result.errors.length > 10) {
          console.log(`  ... and ${result.errors.length - 10} more`);
        }
      }

      return result;
    } catch (error) {
      console.error('❌ Snapshot failed:', error);
      result.errors.push(`Snapshot failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return result;
    }
  }

  /**
   * Calculate fair allocation per user in each tier
   */
  private calculateTierAllocations(
    eligibleUsers: Array<{ wallet: string; nftCount: number; tier: number }>
  ): Record<number, Record<string, number>> {
    const TIER_SUB_POOLS = {
      50: 200_000_000, // 20% of pool
      40: 150_000_000, // 15% of pool
      30: 150_000_000, // 15% of pool
      25: 100_000_000, // 10% of pool
      20: 50_000_000, // 5% of pool
    };

    // Group users by tier
    const tierGroups: Record<number, string[]> = {};
    for (const user of eligibleUsers) {
      if (!tierGroups[user.tier]) tierGroups[user.tier] = [];
      tierGroups[user.tier].push(user.wallet);
    }

    // Calculate allocation per user in each tier
    const allocations: Record<number, Record<string, number>> = {};

    for (const [tier, wallets] of Object.entries(tierGroups)) {
      const tierNum = parseInt(tier);
      const subPool = TIER_SUB_POOLS[tierNum as keyof typeof TIER_SUB_POOLS];
      const perUser = Math.floor(subPool / wallets.length);

      allocations[tierNum] = {};
      for (const wallet of wallets) {
        allocations[tierNum][wallet] = perUser;
      }
    }

    return allocations;
  }

  /**
   * Get all holders of an NFT collection using Helius API
   */
  private async getAllNFTHolders(collectionAddress: PublicKey): Promise<Array<{ wallet: string }>> {
    console.log('🔍 Fetching NFT holders from Helius API...');
    
    if (!config.heliusApiKey) {
      throw new Error('HELIUS_API_KEY not set in .env file');
    }

    const helius = new HeliusNFTService(config.heliusApiKey, getNetwork());
    
    try {
      const holders = await helius.getAllHolders(collectionAddress);
      console.log(`✅ Found ${holders.length} unique holders\n`);
      
      return holders.map(h => ({ wallet: h.wallet }));
    } catch (error) {
      console.error('❌ Failed to fetch holders from Helius:', error);
      throw error;
    }
  }

  /**
   * Alternative: Use a manual list of wallets
   */
  async takeSnapshotFromWalletList(
    wallets: string[],
    vestingConfig: Omit<VestingConfig, 'recipient'>
  ): Promise<SnapshotResult> {
    console.log('📸 Taking snapshot from wallet list...');
    console.log(`Wallets to check: ${wallets.length}\n`);

    const result: SnapshotResult = {
      totalWallets: wallets.length,
      eligible: 0,
      vestingsCreated: 0,
      errors: [],
      tierBreakdown: {},
    };

    try {
      // Set mode to snapshot
      await this.modeService.setMode(VestingMode.SNAPSHOT, this.adminKeypair.publicKey.toBase58());

      // Check eligibility for each wallet using Helius
      console.log('Checking eligibility...');
      const eligibleUsers: Array<{ wallet: string; nftCount: number; tier: number }> = [];
      const helius = new HeliusNFTService(config.heliusApiKey, getNetwork());

      for (const wallet of wallets) {
        try {
          // Use Helius to count NFTs
          const nftCount = await helius.countAllNFTs(new PublicKey(wallet));
          const tier = this.getTierForNFTCount(nftCount);

          if (tier) {
            eligibleUsers.push({ wallet, nftCount, tier });
            result.eligible++;
          }
        } catch (error) {
          result.errors.push(
            `Failed to check ${wallet}: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }

      console.log(`✅ ${result.eligible} eligible users found\n`);

      // Calculate allocations per tier
      const tierAllocations = this.calculateTierAllocations(eligibleUsers);

      // Display tier breakdown
      console.log('Tier breakdown:');
      for (const [tier, allocation] of Object.entries(tierAllocations)) {
        const walletList = Object.keys(allocation);
        const tokensPerUser = allocation[walletList[0]];
        const totalTokens = tokensPerUser * walletList.length;

        result.tierBreakdown[parseInt(tier)] = {
          users: walletList.length,
          tokensPerUser,
          totalTokens,
        };

        console.log(
          `  Tier ${tier}: ${walletList.length} users × ${tokensPerUser.toLocaleString()} tokens = ${totalTokens.toLocaleString()} total`
        );
      }

      console.log('\nCreating vestings...');

      // Calculate grace period end
      const gracePeriodEnd = new Date(vestingConfig.endTime * 1000);
      gracePeriodEnd.setDate(gracePeriodEnd.getDate() + config.gracePeriodDays);

      // Create vestings for all eligible users
      for (const user of eligibleUsers) {
        try {
          const allocation = tierAllocations[user.tier][user.wallet];

          // Create vesting stream
          const vestingData = await this.vestingService.createVesting(this.adminKeypair, {
            ...vestingConfig,
            recipient: new PublicKey(user.wallet),
            totalAmount: allocation,
          });

          // Save to database
          await this.dbService.createVesting({
            user_wallet: user.wallet,
            nft_count: user.nftCount,
            streamflow_stream_id: vestingData.streamflowId,
            token_amount: allocation,
            vesting_mode: 'snapshot',
            snapshot_locked: true,
            claim_verification_enabled: true,
            grace_period_end: gracePeriodEnd.toISOString(),
          });

          result.vestingsCreated++;
          console.log(`  ✅ Created vesting for ${user.wallet}: ${allocation.toLocaleString()} tokens`);
        } catch (error) {
          result.errors.push(
            `Failed to create vesting for ${user.wallet}: ${
              error instanceof Error ? error.message : 'Unknown error'
            }`
          );
        }
      }

      // Save snapshot date
      await this.modeService.updateSnapshotDate(new Date());

      console.log('\n📊 SNAPSHOT COMPLETE');
      console.log(`Total wallets checked: ${result.totalWallets}`);
      console.log(`Eligible users: ${result.eligible}`);
      console.log(`Vestings created: ${result.vestingsCreated}`);
      console.log(`Errors: ${result.errors.length}`);

      return result;
    } catch (error) {
      console.error('❌ Snapshot failed:', error);
      result.errors.push(`Snapshot failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return result;
    }
  }

  /**
   * Get tier for NFT count
   */
  private getTierForNFTCount(nftCount: number): number | null {
    if (nftCount >= 50) return 50;
    if (nftCount >= 40) return 40;
    if (nftCount >= 30) return 30;
    if (nftCount >= 25) return 25;
    if (nftCount >= 20) return 20;
    return null;
  }
}
