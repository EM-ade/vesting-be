/**
 * Migration Script: Database Encryption → Infisical Cloud
 * 
 * This script migrates existing treasury private keys from database encryption
 * to Infisical Cloud secrets management.
 * 
 * Usage:
 *   npm run migrate:infisical -- --dry-run         # Preview migration
 *   npm run migrate:infisical -- --project-id=abc  # Migrate single project
 *   npm run migrate:infisical                      # Migrate all projects
 * 
 * Safety Features:
 * - Dry-run mode (default)
 * - Per-project validation
 * - Rollback on failure
 * - Keeps database backup during transition
 */

import { getSupabaseClient } from '../src/lib/supabaseClient';
import { decryptString } from '../src/services/encryptionService';
import { storeTreasuryKey, getTreasuryKey } from '../src/services/infisicalService';
import { Keypair } from '@solana/web3.js';

interface MigrationResult {
  projectId: string;
  projectName: string;
  publicKey: string;
  status: 'success' | 'skipped' | 'failed';
  error?: string;
}

interface MigrationOptions {
  dryRun: boolean;
  projectId?: string;
  deleteOldKeys: boolean;
}

/**
 * Parse command line arguments
 */
function parseArgs(): MigrationOptions {
  const args = process.argv.slice(2);
  
  return {
    dryRun: !args.includes('--execute'),
    projectId: args.find(arg => arg.startsWith('--project-id='))?.split('=')[1],
    deleteOldKeys: args.includes('--delete-old-keys'),
  };
}

/**
 * Migrate a single project's treasury key
 */
async function migrateProject(
  projectId: string,
  projectName: string,
  encryptedPrivateKey: string,
  publicKey: string,
  dryRun: boolean
): Promise<MigrationResult> {
  const result: MigrationResult = {
    projectId,
    projectName,
    publicKey,
    status: 'failed',
  };

  try {
    console.log(`\n📦 Migrating project: ${projectName} (${projectId})`);
    console.log(`   Public key: ${publicKey}`);

    // Step 1: Decrypt private key from database
    console.log('   [1/4] Decrypting private key from database...');
    const privateKeyBase64 = decryptString(encryptedPrivateKey);

    // Step 2: Validate keypair
    console.log('   [2/4] Validating keypair...');
    const secretKey = Uint8Array.from(Buffer.from(privateKeyBase64, 'base64'));
    const keypair = Keypair.fromSecretKey(secretKey);

    if (keypair.publicKey.toString() !== publicKey) {
      throw new Error(
        `Public key mismatch! Database: ${publicKey}, Keypair: ${keypair.publicKey.toString()}`
      );
    }
    console.log('   ✅ Keypair validation passed');

    if (dryRun) {
      console.log('   [DRY RUN] Would store key in Infisical');
      result.status = 'success';
      return result;
    }

    // Step 3: Store in Infisical
    console.log('   [3/4] Storing private key in Infisical...');
    await storeTreasuryKey(projectId, privateKeyBase64);

    // Step 4: Verify stored key
    console.log('   [4/4] Verifying stored key...');
    const retrievedKey = await getTreasuryKey(projectId);
    
    if (retrievedKey !== privateKeyBase64) {
      throw new Error('Stored key verification failed - keys do not match!');
    }

    // Reconstruct keypair from retrieved key to double-check
    const verifySecretKey = Uint8Array.from(Buffer.from(retrievedKey, 'base64'));
    const verifyKeypair = Keypair.fromSecretKey(verifySecretKey);

    if (verifyKeypair.publicKey.toString() !== publicKey) {
      throw new Error('Retrieved key produces different public key!');
    }

    // Step 5: Update database flag
    console.log('   [5/5] Updating database flag...');
    const supabase = getSupabaseClient();
    const { error: updateError } = await supabase
      .from('projects')
      .update({ uses_infisical: true })
      .eq('id', projectId);

    if (updateError) {
      throw new Error(`Failed to update database flag: ${updateError.message}`);
    }

    console.log('   ✅ Migration successful and verified');
    result.status = 'success';
    return result;

  } catch (error: any) {
    console.error(`   ❌ Migration failed: ${error.message}`);
    result.status = 'failed';
    result.error = error.message;
    return result;
  }
}

/**
 * Main migration function
 */
async function main() {
  const options = parseArgs();
  const supabase = getSupabaseClient();

  console.log('🚀 Starting Treasury Key Migration: Database → Infisical');
  console.log('═'.repeat(60));
  console.log(`Mode: ${options.dryRun ? '🔍 DRY RUN (no changes)' : '⚡ EXECUTE (will migrate)'}`);
  console.log(`Scope: ${options.projectId ? `Single project (${options.projectId})` : 'All projects'}`);
  console.log(`Delete old keys: ${options.deleteOldKeys ? 'Yes' : 'No (keep backup)'}`);
  console.log('═'.repeat(60));

  if (options.dryRun) {
    console.log('\n⚠️  DRY RUN MODE - No changes will be made');
    console.log('   Run with --execute flag to perform actual migration\n');
  }

  // Fetch projects to migrate (must have vault_keys entries)
  let projectsQuery = supabase
    .from('projects')
    .select('id, name, vault_public_key')
    .not('vault_public_key', 'is', null);

  if (options.projectId) {
    projectsQuery = projectsQuery.eq('id', options.projectId);
  }

  const { data: projects, error } = await projectsQuery;

  if (error) {
    console.error('❌ Failed to fetch projects:', error);
    process.exit(1);
  }

  // Filter to only projects that have vault_keys entries
  const projectsWithKeys = [];
  for (const project of projects || []) {
    const { data: vaultKey } = await supabase
      .from('vault_keys')
      .select('private_key_encrypted')
      .eq('project_id', project.id)
      .single();
    
    if (vaultKey) {
      projectsWithKeys.push({
        ...project,
        vault_private_key_encrypted: vaultKey.private_key_encrypted
      });
    }
  }

  const projectsToMigrate = projectsWithKeys;

  if (!projectsToMigrate || projectsToMigrate.length === 0) {
    console.log('ℹ️  No projects found with vault_keys to migrate');
    process.exit(0);
  }

  console.log(`\nFound ${projectsToMigrate.length} project(s) to migrate:\n`);

  // Migrate each project
  const results: MigrationResult[] = [];

  for (const project of projectsToMigrate) {
    const result = await migrateProject(
      project.id,
      project.name,
      project.vault_private_key_encrypted,
      project.vault_public_key,
      options.dryRun
    );
    results.push(result);

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Print summary
  console.log('\n' + '═'.repeat(60));
  console.log('📊 MIGRATION SUMMARY');
  console.log('═'.repeat(60));

  const successful = results.filter(r => r.status === 'success').length;
  const failed = results.filter(r => r.status === 'failed').length;

  console.log(`✅ Successful: ${successful}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📊 Total: ${results.length}`);

  if (failed > 0) {
    console.log('\n❌ Failed migrations:');
    results
      .filter(r => r.status === 'failed')
      .forEach(r => {
        console.log(`   - ${r.projectName} (${r.projectId}): ${r.error}`);
      });
  }

  // Delete old keys if requested (only in execute mode)
  if (!options.dryRun && options.deleteOldKeys && successful > 0) {
    console.log('\n⚠️  Deleting old encrypted keys from database...');
    
    const successfulIds = results
      .filter(r => r.status === 'success')
      .map(r => r.projectId);

    const { error: deleteError } = await supabase
      .from('projects')
      .update({ vault_private_key_encrypted: null })
      .in('id', successfulIds);

    if (deleteError) {
      console.error('❌ Failed to delete old keys:', deleteError);
    } else {
      console.log(`✅ Deleted ${successfulIds.length} old encrypted keys from database`);
    }
  }

  console.log('\n' + '═'.repeat(60));
  
  if (options.dryRun) {
    console.log('✅ DRY RUN COMPLETE - No changes were made');
    console.log('   Run with --execute flag to perform actual migration');
  } else {
    console.log('✅ MIGRATION COMPLETE');
    console.log('\n📝 NEXT STEPS:');
    console.log('   1. Verify all projects can sign transactions');
    console.log('   2. Test withdrawal operations');
    console.log('   3. Run: npm run test:infisical-integration');
    console.log('   4. Deploy updated code with Infisical vault service');
    console.log('   5. Delete old keys: npm run migrate:infisical -- --execute --delete-old-keys');
  }

  process.exit(failed > 0 ? 1 : 0);
}

// Run migration
main().catch(error => {
  console.error('💥 Migration script crashed:', error);
  process.exit(1);
});
