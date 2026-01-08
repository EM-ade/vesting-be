/**
 * Pool-Based Sync Daemon
 * Syncs NFT holder eligibility and updates share percentages in database
 * Works with VestingPoolService (single pool architecture)
 * 
 * Usage: npm run sync:daemon:pool
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';
import bs58 from 'bs58';
import { config, getConnection, getNetwork } from './config';
import { SupabaseService } from './services/supabaseService';
import { HeliusNFTService } from './services/heliusNFTService';

class PoolSyncDaemon {
  private dbService!: SupabaseService;
  private nftService!: HeliusNFTService;
  private adminKeypair!: Keypair;
  private isRunning = false;
  private syncIntervalMs: number;
  private poolId: string | null = null;

  constructor() {
    this.syncIntervalMs = config.syncIntervalHours * 60 * 60 * 1000;
  }

  async initialize() {
    console.log('🤖 Initializing Pool-Based Sync Daemon...\n');

    // Validate configuration
    if (!config.treasuryPrivateKey) {
      throw new Error('TREASURY_PRIVATE_KEY not set in .env');
    }
    if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
      throw new Error('Supabase credentials not set in .env');
    }
    if (!config.heliusApiKey) {
      throw new Error('HELIUS_API_KEY not set in .env');
    }

    // Initialize connection
    const connection = getConnection();
    console.log('✅ Connected to Solana:', config.rpcEndpoint);

    // Parse treasury keypair
    try {
      if (config.treasuryPrivateKey.startsWith('[')) {
        const secretKey = Uint8Array.from(JSON.parse(config.treasuryPrivateKey));
        this.adminKeypair = Keypair.fromSecretKey(secretKey);
      } else {
        const secretKey = bs58.decode(config.treasuryPrivateKey);
        this.adminKeypair = Keypair.fromSecretKey(secretKey);
      }
      console.log('✅ Treasury wallet:', this.adminKeypair.publicKey.toBase58());
    } catch (error) {
      throw new Error('Invalid ADMIN_PRIVATE_KEY format');
    }

    // Initialize Supabase
    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    this.dbService = new SupabaseService(supabase);
    console.log('✅ Connected to Supabase');

    // Initialize Helius NFT service
    const network = getNetwork();
    this.nftService = new HeliusNFTService(config.heliusApiKey, network);
    console.log(`✅ Helius NFT service initialized (${network})`);

    console.log(`✅ Sync interval: ${config.syncIntervalHours} hours\n`);
  }

  async getActivePoolId(): Promise<string | null> {
    // Get the most recent active vesting stream
    const { data, error } = await this.dbService.supabase
      .from('vesting_streams')
      .select('id, streamflow_stream_id')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      console.warn('⚠️  No active vesting stream found');
      return null;
    }

    return data.streamflow_stream_id || data.id;
  }

  async runSync() {
    console.log('\n' + '='.repeat(60));
    console.log(`🔄 Starting pool sync at ${new Date().toISOString()}`);
    console.log('='.repeat(60) + '\n');

    try {
      // Get active pool ID
      this.poolId = await this.getActivePoolId();
      if (!this.poolId) {
        console.log('⚠️  No active pool found. Skipping sync.');
        return;
      }

      console.log(`📦 Syncing pool: ${this.poolId}\n`);

      // Get pool details
      const { data: pool, error: poolError } = await this.dbService.supabase
        .from('vesting_streams')
        .select('*')
        .eq('id', this.poolId)
        .single();

      if (poolError || !pool) {
        throw new Error('Failed to fetch pool details');
      }

      // Fetch current NFT holders
      const collectionAddress = config.nftCollectionAddress;
      if (!collectionAddress) {
        throw new Error('NFT_COLLECTION_ADDRESS not set in config');
      }

      console.log('🔍 Fetching NFT holders from Helius...');
      const holders = await this.nftService.getAllHolders(collectionAddress);
      console.log(`✅ Found ${holders.length} unique holders\n`);

      // Get current allocations from database
      const currentAllocations = await this.dbService.getAllVestings();
      const currentWallets = new Set(currentAllocations.map(v => v.user_wallet));

      let walletsAdded = 0;
      let walletsUpdated = 0;
      let walletsRemoved = 0;
      const errors: string[] = [];

      // Process each rule
      const requirements = pool.nft_requirements || [];
      
      for (const rule of requirements) {
        if (rule.enabled === false) continue;
        
        // Find holders that meet this rule's threshold
        const eligibleHolders = holders.filter((h: any) => h.nftCount >= (rule.threshold || 0));
        
        if (eligibleHolders.length === 0) {
          console.log(`  Rule "${rule.name}": No eligible holders`);
          continue;
        }
        
        // Rule's allocationValue% of pool, split equally among eligible wallets
        const ruleTotalTokens = (rule.allocationValue / 100) * pool.total_pool_amount;
        const tokensPerWallet = ruleTotalTokens / eligibleHolders.length;
        const sharePercentage = rule.allocationValue / eligibleHolders.length;
        
        console.log(`  Rule "${rule.name}": ${rule.allocationValue}% = ${ruleTotalTokens.toLocaleString()} tokens`);
        console.log(`    ${eligibleHolders.length} wallets → ${tokensPerWallet.toLocaleString()} each`);
        
        for (const holder of eligibleHolders) {
          try {
            const existingVesting = currentAllocations.find(v => v.user_wallet === holder.wallet);

            if (existingVesting) {
              // Update if NFT count or allocation changed
              if (existingVesting.nft_count !== holder.nftCount || existingVesting.token_amount !== tokensPerWallet) {
                await this.dbService.supabase
                  .from('vestings')
                  .update({
                    nft_count: holder.nftCount,
                    token_amount: tokensPerWallet,
                    share_percentage: sharePercentage,
                    tier: 1,
                    last_verified: new Date().toISOString(),
                  })
                  .eq('id', existingVesting.id);

                walletsUpdated++;
                console.log(`    ✏️  Updated ${holder.wallet}: ${existingVesting.nft_count} → ${holder.nftCount} NFTs`);
              }
              currentWallets.delete(holder.wallet);
            } else {
              // Add new holder
              await this.dbService.supabase
                .from('vestings')
                .insert({
                  user_wallet: holder.wallet,
                  vesting_stream_id: pool.id,
                  token_amount: tokensPerWallet,
                  nft_count: holder.nftCount,
                  tier: 1,
                  vesting_mode: 'dynamic',
                  is_active: true,
                  share_percentage: sharePercentage,
                });
              
              console.log(`    ➕ New holder added: ${holder.wallet} (${holder.nftCount} NFTs)`);
              walletsAdded++;
            }
          } catch (err) {
            const errorMsg = `Failed to process ${holder.wallet}: ${err instanceof Error ? err.message : 'Unknown error'}`;
            errors.push(errorMsg);
            console.error(`    ❌ ${errorMsg}`);
          }
        }
      }

      // Remove holders who no longer have NFTs
      for (const wallet of currentWallets) {
        try {
          const vesting = currentAllocations.find(v => v.user_wallet === wallet);
          if (vesting && !vesting.is_cancelled) {
            // Mark as cancelled or reduce allocation to 0
            await this.dbService.supabase
              .from('vestings')
              .update({
                is_cancelled: true,
                cancelled_at: new Date().toISOString(),
                cancellation_reason: 'No longer holds required NFTs',
              })
              .eq('id', vesting.id);

            walletsRemoved++;
            console.log(`  ➖ Removed ${wallet}: No longer holds NFTs`);
          }
        } catch (err) {
          const errorMsg = `Failed to remove ${wallet}: ${err instanceof Error ? err.message : 'Unknown error'}`;
          errors.push(errorMsg);
          console.error(`  ❌ ${errorMsg}`);
        }
      }

      // Display summary
      console.log('\n📊 Sync Summary:');
      console.log(`   Status: ${errors.length === 0 ? '✅' : '⚠️'}`);
      console.log(`   Total Holders: ${holders.length}`);
      console.log(`   Added: ${walletsAdded}`);
      console.log(`   Updated: ${walletsUpdated}`);
      console.log(`   Removed: ${walletsRemoved}`);
      console.log(`   Errors: ${errors.length}`);

      if (errors.length > 0) {
        console.log('\n⚠️  Errors encountered:');
        errors.slice(0, 5).forEach(e => console.log(`   - ${e}`));
        if (errors.length > 5) {
          console.log(`   ... and ${errors.length - 5} more`);
        }
      }

      const nextSync = new Date(Date.now() + this.syncIntervalMs);
      console.log(`\n⏰ Next sync scheduled for: ${nextSync.toISOString()}`);
    } catch (error) {
      console.error('❌ Sync failed:', error);
    }
  }

  async start() {
    if (this.isRunning) {
      console.log('⚠️  Daemon is already running');
      return;
    }

    this.isRunning = true;
    console.log('🚀 Pool Sync Daemon started');
    console.log(`⏰ Sync interval: ${config.syncIntervalHours} hours`);
    console.log('Press Ctrl+C to stop\n');

    // Run initial sync
    await this.runSync();

    // Schedule periodic syncs
    const intervalId = setInterval(async () => {
      if (this.isRunning) {
        await this.runSync();
      }
    }, this.syncIntervalMs);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n\n🛑 Shutting down daemon...');
      this.isRunning = false;
      clearInterval(intervalId);
      console.log('✅ Daemon stopped');
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      console.log('\n\n🛑 Shutting down daemon...');
      this.isRunning = false;
      clearInterval(intervalId);
      console.log('✅ Daemon stopped');
      process.exit(0);
    });
  }
}

async function main() {
  const daemon = new PoolSyncDaemon();
  await daemon.initialize();
  await daemon.start();
}

main().catch((error) => {
  console.error('❌ Daemon failed to start:', error);
  process.exit(1);
});
