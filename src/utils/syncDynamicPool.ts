import { Connection, PublicKey } from '@solana/web3.js';
import { SupabaseService } from '../services/supabaseService';
import { HeliusNFTService } from '../services/heliusNFTService';
import { getConnection, config, getNetwork } from '../config';
import { createClient } from '@supabase/supabase-js';

/**
 * Sync a dynamic pool - check NFT holdings and update user allocations
 */
export async function syncDynamicPool(pool: any) {
  console.log(`\n🔄 Syncing dynamic pool: ${pool.name}`);
  console.log(`Pool ID: ${pool.id}`);
  
  // GUARD: Do not sync if pool is cancelled or not active
  if (pool.state === 'cancelled' || pool.is_active === false) {
    console.log('🛑 Pool is cancelled or inactive. Aborting sync to prevent zombie reactivation.');
    return;
  }

  const connection = getConnection();
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  const dbService = new SupabaseService(supabase);
  
  // Get rules from pool's nft_requirements JSON field
  const rules = pool.nft_requirements || [];
  
  if (!rules || rules.length === 0) {
    console.log('⚠️ No NFT rules found for this pool - skipping dynamic sync');
    console.log('💡 For pools without NFT requirements, add users manually to the vestings table');
    return;
  }
  
  // Filter only enabled rules
  const activeRules = rules.filter((r: any) => r.enabled !== false);
  
  console.log(`Found ${rules.length} active rule(s)`);
  
  // Track all eligible wallets across all rules
  const allEligibleWallets = new Set<string>();
  
  // Process each rule
  for (const rule of activeRules) {
    console.log(`\n📋 Processing rule: ${rule.name}`);
    console.log(`  NFT Contract: ${rule.nftContract}`);
    console.log(`  Threshold: ${rule.threshold}`);
    console.log(`  Allocation: ${rule.allocationValue} ${rule.allocationType}`);
    
    let updatedCount = 0;
    let createdCount = 0;
    let errorCount = 0;
    
    try {
      // Validate NFT contract address
      let nftContract: PublicKey;
      try {
        nftContract = new PublicKey(rule.nftContract);
      } catch (err) {
        console.log(`  ⚠️ Skipping rule "${rule.name}" - invalid public key: ${rule.nftContract}`);
        continue;
      }
      
      console.log(`  🔍 Fetching NFT holders from Helius for ${nftContract.toBase58()}...`);
      const heliusService = new HeliusNFTService(config.heliusApiKey, getNetwork());
      
      let holders;
      try {
        holders = await heliusService.getAllHolders(nftContract);
        console.log(`  ✅ Helius response: Found ${holders.length} holders`);
        // Debug: Log first 3 holders
        if (holders.length > 0) {
            console.log(`  Example holders: ${holders.slice(0, 3).map(h => `${h.wallet} (${h.nftCount})`).join(', ')}`);
        }
      } catch (heliusError) {
        console.error(`  ❌ Failed to fetch holders from Helius:`, heliusError);
        console.log(`  ⚠️ Skipping rule "${rule.name}" due to Helius API error`);
        console.log(`  💡 The sync will retry on the next scheduled run`);
        errorCount++;
        continue;
      }
      
      console.log(`  ✅ Found ${holders.length} total holders`);

      // Filter by threshold
      const eligibleHolders = holders.filter((h: any) => h.nftCount >= rule.threshold);
      console.log(`  ${eligibleHolders.length} holders meet threshold of ${rule.threshold}`);

      // Calculate weighted NFTs held by eligible holders (for weighted distribution)
      // Weight formula: nftCount * rule.weight (default 1.0)
      const ruleWeight = rule.weight || 1.0;
      const totalWeightedNFTs = eligibleHolders.reduce((sum: number, h: any) => sum + (h.nftCount * ruleWeight), 0);
      console.log(`  Total weighted NFTs held by eligible holders: ${totalWeightedNFTs} (weight: ${ruleWeight}x)`);

      // Calculate pool share for this rule
      let poolShare: number;
      if (rule.allocationType === 'PERCENTAGE') {
        poolShare = (pool.total_pool_amount * rule.allocationValue) / 100;
      } else {
        // Fixed amount total for this rule
        poolShare = rule.allocationValue;
      }

      console.log(`  Pool share for this rule: ${poolShare.toFixed(2)} tokens`);
      console.log(`  Using weighted allocation: (holderNFTs * weight) / totalWeightedNFTs × poolShare`);
      
      // Add/update users with weighted allocation
      for (const holder of eligibleHolders) {
        // Track this wallet as eligible
        allEligibleWallets.add(holder.wallet);

        // Calculate weighted allocation: (holder's NFTs * weight) / totalWeightedNFTs × pool share
        const holderWeightedNFTs = holder.nftCount * ruleWeight;
        const allocationPerUser = totalWeightedNFTs > 0 ? (holderWeightedNFTs / totalWeightedNFTs) * poolShare : 0;
        
        // Check if user already has vesting for this pool
        const { data: existing, error: fetchError } = await dbService.supabase
          .from('vestings')
          .select('*')
          .eq('user_wallet', holder.wallet)
          .eq('vesting_stream_id', pool.id)
          .maybeSingle();
        
        if (existing) {
          // Update existing allocation (and reactivate if it was cancelled)
          // GUARD: Only reactivate if pool is still active (double check)
          const { error: updateError } = await dbService.supabase
            .from('vestings')
            .update({
              token_amount: allocationPerUser,
              nft_count: holder.nftCount,
              is_active: true,
              is_cancelled: false,
            })
            .eq('id', existing.id);
          
          if (updateError) {
            console.error(`  ❌ Failed to update ${holder.wallet}:`, updateError);
            errorCount++;
          } else {
            updatedCount++;
          }
        } else {
          // Create new vesting
          const { error: insertError } = await dbService.supabase
            .from('vestings')
            .insert({
              user_wallet: holder.wallet,
              vesting_stream_id: pool.id,
              token_amount: allocationPerUser,
              nft_count: holder.nftCount,
              tier: 1, // Default tier for dynamic vesting
              vesting_mode: pool.vesting_mode || 'dynamic',
              is_active: true,
              snapshot_locked: pool.vesting_mode === 'snapshot', // Lock if snapshot mode
            });
          
          if (insertError) {
            console.error(`  ❌ Failed to create ${holder.wallet}:`, insertError);
            errorCount++;
          } else {
            console.log(`  ✨ Added ${holder.wallet.slice(0, 4)}...${holder.wallet.slice(-4)}: ${holder.nftCount} NFTs → ${allocationPerUser.toFixed(2)} tokens`);
            createdCount++;
          }
        }
      }
      
      // Summary for this rule
      console.log(`  📊 Summary: ${updatedCount} updated, ${createdCount} created, ${errorCount} errors`);
    } catch (error) {
      console.error(`  ❌ Error processing rule "${rule.name}":`, error);
    }
  }
  
  // Deactivate users who no longer hold NFTs
  console.log(`\n🔍 Checking for users who no longer meet requirements...`);
  try {
    // Get all active vestings for this pool
    const { data: allVestings, error: fetchError } = await dbService.supabase
      .from('vestings')
      .select('*')
      .eq('vesting_stream_id', pool.id)
      .eq('is_active', true);
    
    if (fetchError) {
      console.error('  ❌ Failed to fetch existing vestings:', fetchError);
    } else if (allVestings) {
      let deactivatedCount = 0;
      
      for (const vesting of allVestings) {
        // If this wallet is not in the eligible list, deactivate it
        if (!allEligibleWallets.has(vesting.user_wallet)) {
          const { error: deactivateError } = await dbService.supabase
            .from('vestings')
            .update({
              is_active: false,
              is_cancelled: true,
              cancelled_at: new Date().toISOString(),
              cancellation_reason: 'No longer holds required NFTs',
            })
            .eq('id', vesting.id);
          
          if (deactivateError) {
            console.error(`  ❌ Failed to deactivate ${vesting.user_wallet}:`, deactivateError);
          } else {
            console.log(`  🗑️  Deactivated ${vesting.user_wallet.slice(0, 4)}...${vesting.user_wallet.slice(-4)} (no longer holds NFTs)`);
            deactivatedCount++;
          }
        }
      }
      
      console.log(`  📊 Deactivated ${deactivatedCount} user(s) who no longer meet requirements`);
    }
  } catch (error) {
    console.error('  ❌ Error checking for removed users:', error);
  }

  // UPDATE SNAPSHOT FLAG (Fix for Issue 1)
  if (pool.vesting_mode === 'snapshot' && !pool.snapshot_taken) {
    console.log('📸 Marking snapshot as taken...');
    const { error: snapshotError } = await dbService.supabase
      .from('vesting_streams')
      .update({ 
        snapshot_taken: true,
        snapshot_date: new Date().toISOString()
      })
      .eq('id', pool.id);
    
    if (snapshotError) {
      console.error('❌ Failed to update snapshot_taken flag:', snapshotError);
    } else {
      console.log('✅ Snapshot marked as complete.');
    }
  }
  
  console.log(`\n✅ Sync completed for pool: ${pool.name}\n`);
}
