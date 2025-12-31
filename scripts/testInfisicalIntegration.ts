/**
 * Integration Test: Infisical Vault Service
 * 
 * Tests the complete flow of creating, retrieving, and using treasury vaults
 * with Infisical Cloud secrets management.
 * 
 * Usage:
 *   npm run test:infisical-integration
 */

import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createProjectVault, getVaultKeypairForProject, deleteProjectVault, verifyVaultIntegrity } from '../src/services/vaultService.infisical';
import { healthCheck } from '../src/services/infisicalService';
import { getSupabaseClient } from '../src/lib/supabaseClient';
import { config } from '../src/config';
import { randomUUID } from 'crypto';

const TEST_PROJECT_PREFIX = 'test-infisical-';

/**
 * Clean up test projects
 */
async function cleanup() {
  const supabase = getSupabaseClient();
  
  const { data: projects } = await supabase
    .from('projects')
    .select('id')
    .like('id', `${TEST_PROJECT_PREFIX}%`);

  if (projects && projects.length > 0) {
    console.log(`🧹 Cleaning up ${projects.length} test project(s)...`);
    for (const project of projects) {
      try {
        await deleteProjectVault(project.id);
      } catch (error) {
        // Ignore errors during cleanup
      }
    }

    await supabase
      .from('projects')
      .delete()
      .like('id', `${TEST_PROJECT_PREFIX}%`);
  }
}

/**
 * Test 1: Infisical connection
 */
async function testInfisicalConnection(): Promise<boolean> {
  console.log('\n📡 Test 1: Infisical Connection');
  console.log('─'.repeat(50));

  try {
    const isHealthy = await healthCheck();
    if (!isHealthy) {
      throw new Error('Health check failed');
    }
    console.log('✅ Successfully connected to Infisical');
    return true;
  } catch (error) {
    console.error('❌ Failed to connect to Infisical:', error);
    return false;
  }
}

/**
 * Test 2: Create vault
 */
async function testCreateVault(): Promise<{ success: boolean; projectId?: string; publicKey?: string }> {
  console.log('\n🔑 Test 2: Create Vault');
  console.log('─'.repeat(50));

  const supabase = getSupabaseClient();
  
  // Generate a proper UUID for the project
  const projectId = randomUUID();

  try {
    // Create test project in database (let database generate ID if needed)
    const { error: createError, data: createdProject } = await supabase
      .from('projects')
      .insert({
        name: 'Infisical Test Project',
        symbol: 'TEST',
        mint_address: 'So11111111111111111111111111111111111111112', // SOL mint
      })
      .select()
      .single();

    if (createError || !createdProject) {
      throw new Error(`Failed to create test project: ${createError?.message || 'No data returned'}`);
    }

    const actualProjectId = createdProject.id;

    // Create vault
    const publicKey = await createProjectVault(actualProjectId);
    console.log(`✅ Created vault with public key: ${publicKey}`);

    // Verify public key is valid Solana address
    new PublicKey(publicKey);
    console.log('✅ Public key is valid Solana address');

    return { success: true, projectId: actualProjectId, publicKey };
  } catch (error: any) {
    console.error('❌ Failed to create vault:', error.message);
    return { success: false };
  }
}

/**
 * Test 3: Retrieve vault
 */
async function testRetrieveVault(projectId: string, expectedPublicKey: string): Promise<boolean> {
  console.log('\n🔍 Test 3: Retrieve Vault');
  console.log('─'.repeat(50));

  try {
    const keypair = await getVaultKeypairForProject(projectId);
    console.log(`✅ Retrieved keypair for project ${projectId}`);

    // Verify public key matches
    if (keypair.publicKey.toString() !== expectedPublicKey) {
      throw new Error(
        `Public key mismatch! Expected: ${expectedPublicKey}, Got: ${keypair.publicKey.toString()}`
      );
    }
    console.log('✅ Public key matches expected value');

    return true;
  } catch (error: any) {
    console.error('❌ Failed to retrieve vault:', error.message);
    return false;
  }
}

/**
 * Test 4: Sign transaction
 */
async function testSignTransaction(projectId: string): Promise<boolean> {
  console.log('\n✍️  Test 4: Sign Transaction');
  console.log('─'.repeat(50));

  try {
    const connection = new Connection(config.rpcEndpoint, 'confirmed');
    const keypair = await getVaultKeypairForProject(projectId);

    // Create a simple transaction (just transfer 0 SOL to self)
    const { Transaction, SystemProgram } = await import('@solana/web3.js');
    
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: keypair.publicKey,
        lamports: 0,
      })
    );

    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = keypair.publicKey;

    // Sign transaction
    transaction.sign(keypair);

    console.log('✅ Successfully signed transaction');
    console.log(`   Transaction signature: ${transaction.signature?.toString('hex').substring(0, 16)}...`);

    // Verify signature
    const verified = transaction.verifySignatures();
    if (!verified) {
      throw new Error('Signature verification failed');
    }
    console.log('✅ Signature verification passed');

    return true;
  } catch (error: any) {
    console.error('❌ Failed to sign transaction:', error.message);
    return false;
  }
}

/**
 * Test 5: Verify vault integrity
 */
async function testVaultIntegrity(projectId: string): Promise<boolean> {
  console.log('\n🔒 Test 5: Vault Integrity Check');
  console.log('─'.repeat(50));

  try {
    const isValid = await verifyVaultIntegrity(projectId);
    if (!isValid) {
      throw new Error('Vault integrity check failed');
    }
    console.log('✅ Vault integrity verified');
    return true;
  } catch (error: any) {
    console.error('❌ Vault integrity check failed:', error.message);
    return false;
  }
}

/**
 * Test 6: Delete vault
 */
async function testDeleteVault(projectId: string): Promise<boolean> {
  console.log('\n🗑️  Test 6: Delete Vault');
  console.log('─'.repeat(50));

  try {
    await deleteProjectVault(projectId);
    console.log(`✅ Deleted vault for project ${projectId}`);

    // Verify key is deleted (should throw error)
    try {
      await getVaultKeypairForProject(projectId);
      throw new Error('Key should not exist after deletion');
    } catch (error: any) {
      if (error.message.includes('should not exist')) {
        throw error;
      }
      console.log('✅ Confirmed key is deleted from Infisical');
    }

    return true;
  } catch (error: any) {
    console.error('❌ Failed to delete vault:', error.message);
    return false;
  }
}

/**
 * Main test runner
 */
async function main() {
  console.log('🧪 INFISICAL INTEGRATION TEST SUITE');
  console.log('═'.repeat(50));
  console.log('Testing treasury vault operations with Infisical Cloud\n');

  // Cleanup before tests
  await cleanup();

  const results: Record<string, boolean> = {};

  // Test 1: Connection
  results['connection'] = await testInfisicalConnection();
  if (!results['connection']) {
    console.error('\n💥 Cannot proceed without Infisical connection');
    process.exit(1);
  }

  // Test 2: Create vault
  const createResult = await testCreateVault();
  results['create'] = createResult.success;
  
  if (!createResult.success || !createResult.projectId || !createResult.publicKey) {
    console.error('\n💥 Cannot proceed without successful vault creation');
    process.exit(1);
  }

  const { projectId, publicKey } = createResult;

  // Test 3: Retrieve vault
  results['retrieve'] = await testRetrieveVault(projectId, publicKey);

  // Test 4: Sign transaction
  results['sign'] = await testSignTransaction(projectId);

  // Test 5: Vault integrity
  results['integrity'] = await testVaultIntegrity(projectId);

  // Test 6: Delete vault
  results['delete'] = await testDeleteVault(projectId);

  // Cleanup after tests
  await cleanup();

  // Print summary
  console.log('\n' + '═'.repeat(50));
  console.log('📊 TEST SUMMARY');
  console.log('═'.repeat(50));

  const tests = [
    { name: 'Infisical Connection', key: 'connection' },
    { name: 'Create Vault', key: 'create' },
    { name: 'Retrieve Vault', key: 'retrieve' },
    { name: 'Sign Transaction', key: 'sign' },
    { name: 'Vault Integrity', key: 'integrity' },
    { name: 'Delete Vault', key: 'delete' },
  ];

  let passed = 0;
  let failed = 0;

  tests.forEach(test => {
    const result = results[test.key];
    const icon = result ? '✅' : '❌';
    console.log(`${icon} ${test.name}`);
    if (result) {
      passed++;
    } else {
      failed++;
    }
  });

  console.log('─'.repeat(50));
  console.log(`Passed: ${passed}/${tests.length}`);
  console.log(`Failed: ${failed}/${tests.length}`);
  console.log('═'.repeat(50));

  if (failed === 0) {
    console.log('\n🎉 ALL TESTS PASSED!');
    console.log('   Infisical integration is working correctly.');
    process.exit(0);
  } else {
    console.log('\n❌ SOME TESTS FAILED');
    console.log('   Please review the errors above.');
    process.exit(1);
  }
}

// Run tests
main().catch(error => {
  console.error('💥 Test suite crashed:', error);
  process.exit(1);
});
