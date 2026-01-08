/**
 * Reclaim Expired Vestings Script
 * Reclaims unclaimed tokens from expired vestings where users no longer meet NFT requirements
 * 
 * Usage: npm run reclaim:expired
 */

import { Keypair } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';
import bs58 from 'bs58';
import { config, getConnection } from './config';
import { VestingReclaimService } from './services/vestingReclaimService';
import { SupabaseService } from './services/supabaseService';
import { NFTChecker } from './services/nftChecker';
import { ICluster, GenericStreamClient, IChain } from '@streamflow/stream';

async function main() {
  console.log('💰 Reclaiming expired vestings...\n');

  // Validate configuration
  if (!config.adminPrivateKey) {
    throw new Error('ADMIN_PRIVATE_KEY not set in .env');
  }
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new Error('Supabase credentials not set in .env');
  }

  // Initialize connection
  const connection = getConnection();
  console.log('✅ Connected to Solana:', config.rpcEndpoint);

  // Parse admin keypair
  let adminKeypair: Keypair;
  try {
    if (config.adminPrivateKey.startsWith('[')) {
      const secretKey = Uint8Array.from(JSON.parse(config.adminPrivateKey));
      adminKeypair = Keypair.fromSecretKey(secretKey);
    } else {
      const secretKey = bs58.decode(config.adminPrivateKey);
      adminKeypair = Keypair.fromSecretKey(secretKey);
    }
    console.log('✅ Admin wallet:', adminKeypair.publicKey.toBase58());
  } catch (error) {
    throw new Error('Invalid ADMIN_PRIVATE_KEY format');
  }

  // Initialize Supabase
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
  const dbService = new SupabaseService(supabase);
  console.log('✅ Connected to Supabase\n');

  // Initialize services
  const nftChecker = new NFTChecker(connection, config.nftCollectionAddress);
  const streamClient = new GenericStreamClient<IChain.Solana>({
    chain: IChain.Solana,
    clusterUrl: connection.rpcEndpoint,
    cluster: ICluster.Mainnet,
    commitment: 'confirmed',
  });

  const reclaimService = new VestingReclaimService(nftChecker, dbService, streamClient, adminKeypair);

  // Show upcoming reclaims first
  console.log('Checking for upcoming reclaims (next 7 days)...\n');
  const upcoming = await reclaimService.getUpcomingReclaims(7);

  if (upcoming.length > 0) {
    console.log(`⚠️  ${upcoming.length} vestings expiring in next 7 days:\n`);
    for (const v of upcoming) {
      console.log(`${v.wallet}:`);
      console.log(`  NFTs: ${v.nftCount} (needs ${v.requiredNFTs})`);
      console.log(`  Unclaimed: ${v.unclaimedAmount.toLocaleString()} tokens`);
      console.log(`  Expires: ${new Date(v.gracePeriodEnd).toLocaleString()}\n`);
    }
  } else {
    console.log('✅ No vestings expiring in next 7 days\n');
  }

  // Reclaim expired
  console.log('Reclaiming expired vestings...\n');
  const result = await reclaimService.reclaimExpiredVestings();

  // Display results
  console.log('\n' + '='.repeat(60));
  console.log('📊 RECLAIM RESULTS');
  console.log('='.repeat(60));
  console.log(`Vestings checked: ${result.checked}`);
  console.log(`Vestings reclaimed: ${result.reclaimed}`);
  console.log(`Total tokens reclaimed: ${result.totalReclaimed.toLocaleString()}`);
  console.log(`Errors: ${result.errors.length}`);

  if (result.errors.length > 0) {
    console.log('\n⚠️  Errors:');
    result.errors.slice(0, 10).forEach((e) => console.log(`   - ${e}`));
    if (result.errors.length > 10) {
      console.log(`   ... and ${result.errors.length - 10} more`);
    }
  }

  console.log('='.repeat(60) + '\n');
}

main()
  .then(() => {
    console.log('✨ Reclaim completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Reclaim failed:', error);
    process.exit(1);
  });
