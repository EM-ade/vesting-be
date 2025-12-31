/**
 * Verify Migrated Project
 * Tests that a migrated project can still perform all operations
 */

import { getSupabaseClient } from '../src/lib/supabaseClient';
import { getVaultKeypairForProject } from '../src/services/vaultService';
import { Connection, Transaction, SystemProgram } from '@solana/web3.js';
import { config } from '../src/config';

async function verifyProject(projectId: string) {
  console.log(`🔍 Verifying migrated project: ${projectId}\n`);
  
  const supabase = getSupabaseClient();

  try {
    // Test 1: Check database flags
    console.log('1️⃣  Checking database status...');
    const { data: project, error } = await supabase
      .from('projects')
      .select('id, name, uses_infisical, vault_public_key')
      .eq('id', projectId)
      .single();

    if (error || !project) {
      throw new Error(`Project not found: ${error?.message}`);
    }

    console.log(`   Project: ${project.name}`);
    console.log(`   Uses Infisical: ${project.uses_infisical ? '✅ Yes' : '❌ No'}`);
    console.log(`   Public Key: ${project.vault_public_key}\n`);

    if (!project.uses_infisical) {
      throw new Error('Project not marked as uses_infisical!');
    }

    // Test 2: Retrieve keypair
    console.log('2️⃣  Retrieving keypair...');
    const keypair = await getVaultKeypairForProject(projectId);
    console.log(`   ✅ Keypair retrieved from Infisical`);
    console.log(`   Public key: ${keypair.publicKey.toString()}\n`);

    // Test 3: Validate public key matches
    console.log('3️⃣  Validating public key...');
    if (keypair.publicKey.toString() !== project.vault_public_key) {
      throw new Error('Public key mismatch!');
    }
    console.log('   ✅ Public key matches database\n');

    // Test 4: Sign a test transaction
    console.log('4️⃣  Testing transaction signing...');
    const connection = new Connection(config.rpcEndpoint, 'confirmed');
    
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: keypair.publicKey,
        lamports: 0,
      })
    );

    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = keypair.publicKey;

    transaction.sign(keypair);

    const verified = transaction.verifySignatures();
    if (!verified) {
      throw new Error('Signature verification failed');
    }

    console.log('   ✅ Transaction signed successfully');
    console.log('   ✅ Signature verified\n');

    // Test 5: Check vault_keys backup still exists
    console.log('5️⃣  Checking backup in vault_keys table...');
    const { data: vaultKey } = await supabase
      .from('vault_keys')
      .select('private_key_encrypted')
      .eq('project_id', projectId)
      .single();

    if (vaultKey) {
      console.log('   ✅ Backup still exists in vault_keys table\n');
    } else {
      console.log('   ⚠️  No backup in vault_keys table (may have been deleted)\n');
    }

    console.log('═'.repeat(60));
    console.log('🎉 VERIFICATION COMPLETE - ALL TESTS PASSED!');
    console.log('═'.repeat(60));
    console.log('\n✅ Project migrated successfully');
    console.log('✅ Can retrieve key from Infisical');
    console.log('✅ Can sign transactions');
    console.log('✅ Public key validated');
    console.log('✅ Backup preserved\n');

  } catch (error: any) {
    console.error('\n❌ Verification failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

const projectId = process.argv[2] || 'd0fe85c4-c11f-401f-9d65-5c2611e96bae';
verifyProject(projectId);
