import { PublicKey, Keypair } from '@solana/web3.js';
import { ICluster } from '@streamflow/stream';
import { BatchVestingService, BatchRecipient } from './services/batchVestingService';
import { NFTChecker } from './services/nftChecker';
import { getConnection, config } from './config';
import { KeypairManager } from './utils/keypairManager';

/**
 * Batch vesting creation script
 * 
 * Usage:
 * 1. Set up recipients list (from CSV, database, or API)
 * 2. Configure vesting schedule
 * 3. Run: npm run batch-create
 */

async function main() {
  console.log('=== Batch Vesting Creation ===\n');

  const connection = getConnection();
  console.log('Connected to:', config.rpcEndpoint);

  // Load admin keypair
  const adminKeypair = KeypairManager.loadFromEnv('ADMIN_PRIVATE_KEY');
  console.log('Admin:', adminKeypair.publicKey.toBase58());

  // Initialize services
  const batchService = new BatchVestingService(
    connection,
    ICluster.Mainnet
  );

  const nftChecker = new NFTChecker(connection, config.nftCollectionAddress);

  // Example: Get eligible users from NFT holdings
  console.log('\n=== Scanning for Eligible Wallets ===');
  
  // In production, you'd fetch this from your database or API
  // For now, using example wallets
  const candidateWallets: PublicKey[] = [
    // Add your wallet addresses here
    // new PublicKey('wallet1...'),
    // new PublicKey('wallet2...'),
  ];

  if (candidateWallets.length === 0) {
    console.log('⚠️  No candidate wallets provided.');
    console.log('Edit src/batchCreate.ts and add wallet addresses to candidateWallets array.');
    return;
  }

  // Check NFT eligibility for each wallet
  const eligibleRecipients: BatchRecipient[] = [];
  const nftThreshold = 20; // Minimum NFTs required

  for (const wallet of candidateWallets) {
    try {
      const nftCount = await nftChecker.countNFTs(wallet);
      console.log(`${wallet.toBase58().slice(0, 8)}...: ${nftCount} NFTs`);

      if (nftCount >= nftThreshold) {
        eligibleRecipients.push({
          wallet,
          amount: 1000_000_000_000, // 1000 tokens (9 decimals)
          name: `Holder with ${nftCount} NFTs`,
        });
      }
    } catch (error) {
      console.log(`Failed to check ${wallet.toBase58().slice(0, 8)}...:`, error);
    }
  }

  console.log(`\nEligible wallets: ${eligibleRecipients.length}`);

  if (eligibleRecipients.length === 0) {
    console.log('No eligible wallets found.');
    return;
  }

  // Validate token mint is configured
  if (!config.customTokenMint) {
    console.error('❌ CUSTOM_TOKEN_MINT not configured in .env');
    return;
  }

  // Configure vesting schedule
  const now = Math.floor(Date.now() / 1000);
  const vestingConfig = {
    startTime: now + 60, // Start in 1 minute
    cliffTime: now + 86400, // 1 day cliff
    endTime: now + 2592000, // 30 days total
    tokenMint: config.customTokenMint,
  };

  console.log('\n=== Vesting Configuration ===');
  console.log('Start:', new Date(vestingConfig.startTime * 1000).toISOString());
  console.log('Cliff:', new Date(vestingConfig.cliffTime * 1000).toISOString());
  console.log('End:', new Date(vestingConfig.endTime * 1000).toISOString());
  console.log('Token Mint:', vestingConfig.tokenMint.toBase58());

  // Calculate total
  const totalAmount = BatchVestingService.calculateTotalAmount(eligibleRecipients);
  console.log('\nTotal tokens needed:', totalAmount / 1e9);

  // Validate batch
  const validation = BatchVestingService.validateBatch(eligibleRecipients, vestingConfig);
  if (!validation.valid) {
    console.log('\n❌ Validation failed:');
    validation.errors.forEach(err => console.log(`  - ${err}`));
    return;
  }

  console.log('✓ Validation passed');

  // Confirm before proceeding
  console.log('\n⚠️  Ready to create vestings. Press Ctrl+C to cancel, or wait 5 seconds to proceed...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Create vestings
  console.log('\n=== Creating Vestings ===');
  const result = await batchService.createBatchVestings(
    adminKeypair,
    eligibleRecipients,
    vestingConfig,
    10 // Batch size
  );

  // Save results
  console.log('\n=== Results ===');
  console.log(`Total created: ${result.totalCreated}`);
  console.log(`Total failed: ${result.totalFailed}`);

  if (result.successful.length > 0) {
    console.log('\n✅ Successful:');
    result.successful.forEach(s => {
      console.log(`  ${s.wallet.slice(0, 8)}... → ${s.streamId}`);
    });
  }

  if (result.failed.length > 0) {
    console.log('\n❌ Failed:');
    result.failed.forEach(f => {
      console.log(`  ${f.wallet.slice(0, 8)}...: ${f.error}`);
    });

    // Optionally retry failed
    console.log('\nRetry failed? (Implement retry logic if needed)');
  }

  // Export results to JSON
  const fs = require('fs');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `vesting-batch-${timestamp}.json`;
  
  fs.writeFileSync(filename, JSON.stringify(result, null, 2));
  console.log(`\nResults saved to: ${filename}`);
}

main().catch(console.error);
