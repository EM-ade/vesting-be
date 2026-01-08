/**
 * Snapshot Scheduler
 * 
 * Monitors snapshot pools and takes snapshots at their start time.
 * Runs as a background daemon process.
 * 
 * Usage: npm run snapshot:scheduler
 */

import { createClient } from '@supabase/supabase-js';
import { config } from './config';
import { Connection, PublicKey } from '@solana/web3.js';
import { Metaplex } from '@metaplex-foundation/js';

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
const connection = new Connection(config.rpcEndpoint, 'confirmed');
const metaplex = Metaplex.make(connection);

const CHECK_INTERVAL = 60 * 1000; // Check every 1 minute

interface SnapshotPool {
  id: string;
  name: string;
  start_time: string;
  nft_requirements: any[];
  total_pool_amount: number;
  snapshot_taken: boolean;
}

/**
 * Get NFT holders for a collection
 */
async function getNFTHolders(collectionAddress: string): Promise<Map<string, number>> {
  console.log(`[SNAPSHOT] Fetching NFT holders for collection: ${collectionAddress}`);
  
  const holderMap = new Map<string, number>();
  
  try {
    const collectionPubkey = new PublicKey(collectionAddress);
    const nfts = await metaplex.nfts().findAllByCreator({ creator: collectionPubkey });
    
    for (const nft of nfts) {
      if (nft.model === 'metadata') {
        try {
          const nftData = await metaplex.nfts().load({ metadata: nft });
          const owner = (nftData as any).owner?.address?.toBase58();
          
          if (owner) {
            holderMap.set(owner, (holderMap.get(owner) || 0) + 1);
          }
        } catch (err) {
          console.warn(`[SNAPSHOT] Failed to load NFT ${nft.address}:`, err);
        }
      }
    }
    
    console.log(`[SNAPSHOT] Found ${holderMap.size} unique holders`);
    return holderMap;
    
  } catch (error) {
    console.error(`[SNAPSHOT] Error fetching NFT holders:`, error);
    throw error;
  }
}

/**
 * Calculate tier based on NFT count
 */
function calculateTier(nftCount: number, rules: any[]): number {
  // Sort rules by min_nfts descending
  const sortedRules = [...rules].sort((a, b) => b.min_nfts - a.min_nfts);
  
  for (const rule of sortedRules) {
    if (nftCount >= rule.min_nfts) {
      return rule.tier;
    }
  }
  
  return 0; // No tier if doesn't meet minimum
}

/**
 * Take snapshot for a pool
 */
async function takeSnapshot(pool: SnapshotPool): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[SNAPSHOT] Taking snapshot for pool: ${pool.name}`);
  console.log(`[SNAPSHOT] Pool ID: ${pool.id}`);
  console.log(`[SNAPSHOT] Start Time: ${pool.start_time}`);
  console.log(`${'='.repeat(60)}\n`);
  
  try {
    // Get NFT requirements
    const requirements = pool.nft_requirements || [];
    
    if (requirements.length === 0) {
      console.log('[SNAPSHOT] ⚠️ No NFT requirements defined for this pool - skipping snapshot');
      console.log('[SNAPSHOT] 💡 For pools without NFT requirements, add users manually to the vestings table');
      
      // Mark snapshot as taken so it doesn't keep trying
      await supabase
        .from('vesting_streams')
        .update({ snapshot_taken: true })
        .eq('id', pool.id);
      
      return;
    }
    
    // Get holders for each collection
    const allHolders = new Map<string, number>();
    
    for (const req of requirements) {
      if (req.collection_address) {
        const holders = await getNFTHolders(req.collection_address);
        
        // Merge holders
        for (const [wallet, count] of holders) {
          allHolders.set(wallet, (allHolders.get(wallet) || 0) + count);
        }
      }
    }
    
    console.log(`[SNAPSHOT] Total unique wallets: ${allHolders.size}`);
    
    // Calculate allocations
    let totalNFTs = 0;
    const eligibleWallets: Array<{
      wallet: string;
      nftCount: number;
      tier: number;
    }> = [];
    
    for (const [wallet, nftCount] of allHolders) {
      const tier = calculateTier(nftCount, requirements);
      
      if (tier > 0) {
        eligibleWallets.push({ wallet, nftCount, tier });
        totalNFTs += nftCount;
      }
    }
    
    console.log(`[SNAPSHOT] Eligible wallets: ${eligibleWallets.length}`);
    console.log(`[SNAPSHOT] Total NFTs: ${totalNFTs}`);
    
    if (eligibleWallets.length === 0) {
      console.warn('[SNAPSHOT] No eligible wallets found!');
      return;
    }
    
    // Calculate token amounts based on rules
    // Each rule: wallets meeting threshold share allocationValue% of pool
    const vestingRecords = [];
    
    for (const rule of requirements) {
      if (rule.enabled === false) continue;
      
      // Find wallets that meet this rule's threshold
      const eligibleForRule = eligibleWallets.filter(w => w.nftCount >= (rule.threshold || 0));
      
      if (eligibleForRule.length === 0) {
        console.log(`[SNAPSHOT] Rule "${rule.name}": No eligible wallets`);
        continue;
      }
      
      // Rule's allocationValue% of pool, split equally among eligible wallets
      const ruleTotalTokens = (rule.allocationValue / 100) * pool.total_pool_amount;
      const tokensPerWallet = ruleTotalTokens / eligibleForRule.length;
      const sharePercentage = rule.allocationValue / eligibleForRule.length;
      
      console.log(`[SNAPSHOT] Rule "${rule.name}": ${rule.allocationValue}% = ${ruleTotalTokens.toLocaleString()} tokens`);
      console.log(`[SNAPSHOT]   ${eligibleForRule.length} wallets → ${tokensPerWallet.toLocaleString()} each`);
      
      for (const { wallet, nftCount, tier } of eligibleForRule) {
        vestingRecords.push({
          user_wallet: wallet,
          vesting_stream_id: pool.id,
          token_amount: tokensPerWallet,
          nft_count: nftCount,
          tier: tier || 1,
          vesting_mode: 'snapshot',
          is_active: true,
          share_percentage: sharePercentage,
        });
      }
    }
    
    // Delete existing vestings for this pool (in case of re-snapshot)
    const { error: deleteError } = await supabase
      .from('vestings')
      .delete()
      .eq('vesting_stream_id', pool.id);
    
    if (deleteError) {
      console.error('[SNAPSHOT] Error deleting old vestings:', deleteError);
    }
    
    // Insert new vestings
    console.log(`[SNAPSHOT] Inserting ${vestingRecords.length} vesting records...`);
    
    const { error: insertError } = await supabase
      .from('vestings')
      .insert(vestingRecords);
    
    if (insertError) {
      throw insertError;
    }
    
    // Mark snapshot as taken
    const { error: updateError } = await supabase
      .from('vesting_streams')
      .update({ snapshot_taken: true })
      .eq('id', pool.id);
    
    if (updateError) {
      throw updateError;
    }
    
    console.log(`\n✅ Snapshot completed successfully!`);
    console.log(`   Wallets processed: ${eligibleWallets.length}`);
    console.log(`   Total allocation: ${pool.total_pool_amount.toLocaleString()} tokens`);
    console.log(`${'='.repeat(60)}\n`);
    
  } catch (error) {
    console.error('[SNAPSHOT] Error taking snapshot:', error);
    throw error;
  }
}

/**
 * Check for pools that need snapshots
 */
export async function checkPendingSnapshots(): Promise<void> {
  try {
    const now = new Date();
    
    // Find snapshot pools where:
    // - vesting_mode = 'snapshot'
    // - snapshot_taken = false
    // - start_time <= now
    // - is_active = true
    const { data: pools, error } = await supabase
      .from('vesting_streams')
      .select('*')
      .eq('vesting_mode', 'snapshot')
      .eq('snapshot_taken', false)
      .eq('is_active', true)
      .lte('start_time', now.toISOString());
    
    if (error) {
      console.error('[SCHEDULER] Error fetching pools:', error);
      return;
    }
    
    if (!pools || pools.length === 0) {
      // No pending snapshots (this is normal)
      return;
    }
    
    console.log(`[SCHEDULER] Found ${pools.length} pool(s) ready for snapshot`);
    
    // Take snapshot for each pool
    for (const pool of pools) {
      try {
        await takeSnapshot(pool as SnapshotPool);
      } catch (error) {
        console.error(`[SCHEDULER] Failed to snapshot pool ${pool.name}:`, error);
        // Continue with other pools
      }
    }
    
  } catch (error) {
    console.error('[SCHEDULER] Error in checkPendingSnapshots:', error);
  }
}

/**
 * Main scheduler loop
 */
async function runScheduler(): Promise<void> {
  console.log('🚀 Snapshot Scheduler Started');
  console.log(`   Checking every ${CHECK_INTERVAL / 1000} seconds`);
  console.log(`   Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  console.log(`   Current time: ${new Date().toISOString()}`);
  console.log('─'.repeat(60));
  
  // Initial check
  await checkPendingSnapshots();
  
  // Schedule periodic checks
  setInterval(async () => {
    await checkPendingSnapshots();
  }, CHECK_INTERVAL);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[SCHEDULER] Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[SCHEDULER] Shutting down gracefully...');
  process.exit(0);
});

// Check if running in cron mode (--once flag)
const isOnceMode = process.argv.includes('--once');

if (isOnceMode) {
  // Run once and exit (for cron jobs)
  console.log('[SCHEDULER] Running in cron mode (once)');
  checkPendingSnapshots()
    .then(() => {
      console.log('[SCHEDULER] Cron job completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('[SCHEDULER] Cron job failed:', error);
      process.exit(1);
    });
} else {
  // Run as daemon (continuous)
  console.log('[SCHEDULER] Running in daemon mode (continuous)');
  runScheduler().catch((error) => {
    console.error('[SCHEDULER] Fatal error:', error);
    process.exit(1);
  });
}
