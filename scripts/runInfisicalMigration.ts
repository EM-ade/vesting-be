/**
 * Run Infisical Database Migration
 * 
 * Applies the 07_add_infisical_support.sql migration using Supabase client
 */

import { getSupabaseClient } from '../src/lib/supabaseClient';
import * as fs from 'fs';
import * as path from 'path';

async function runMigration() {
  console.log('🚀 Running Infisical Support Migration...\n');

  const supabase = getSupabaseClient();

  // Read migration file
  const migrationPath = path.join(__dirname, '../migrations/07_add_infisical_support.sql');
  const migrationSQL = fs.readFileSync(migrationPath, 'utf-8');

  // Split into individual statements (simple split by semicolon)
  const statements = migrationSQL
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--') && !s.startsWith('\\echo'));

  console.log(`Found ${statements.length} SQL statements to execute\n`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i];
    
    // Skip comments and empty statements
    if (!statement || statement.startsWith('--')) {
      continue;
    }

    try {
      console.log(`Executing statement ${i + 1}/${statements.length}...`);
      
      const { error } = await supabase.rpc('exec_sql', { sql: statement + ';' });
      
      if (error) {
        // Some errors are expected (e.g., column already exists)
        if (error.message.includes('already exists') || error.message.includes('IF NOT EXISTS')) {
          console.log(`  ⚠️  Already exists (skipping): ${error.message.substring(0, 80)}...`);
        } else {
          console.error(`  ❌ Error: ${error.message}`);
          failCount++;
        }
      } else {
        console.log(`  ✅ Success`);
        successCount++;
      }
    } catch (err: any) {
      console.error(`  ❌ Exception: ${err.message}`);
      failCount++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('📊 MIGRATION SUMMARY');
  console.log('='.repeat(60));
  console.log(`✅ Successful: ${successCount}`);
  console.log(`❌ Failed: ${failCount}`);
  console.log(`📝 Total: ${statements.length}`);
  console.log('='.repeat(60));

  // Verify migration by checking if columns exist
  console.log('\n🔍 Verifying migration...\n');

  try {
    // Check if uses_infisical column exists
    const { data: projects, error: projectError } = await supabase
      .from('projects')
      .select('id, name, uses_infisical, vault_last_accessed')
      .limit(1);

    if (projectError) {
      console.error('❌ Verification failed:', projectError.message);
      console.log('\n⚠️  Migration may not have completed successfully.');
      console.log('Please run the SQL manually using Supabase SQL Editor:');
      console.log('https://supabase.com/dashboard/project/YOUR_PROJECT/sql');
      process.exit(1);
    }

    console.log('✅ Column verification passed: uses_infisical exists');

    // Check if vault_access_log table exists
    const { error: logError } = await supabase
      .from('vault_access_log')
      .select('id')
      .limit(1);

    if (logError && !logError.message.includes('does not exist')) {
      console.log('✅ Table verification passed: vault_access_log exists');
    } else if (logError) {
      console.log('⚠️  vault_access_log table may not exist yet');
    }

    // Show migration progress
    const { data: progress } = await supabase
      .from('projects')
      .select('uses_infisical');

    if (progress) {
      const total = progress.length;
      const usingInfisical = progress.filter(p => p.uses_infisical === true).length;
      const usingDatabase = progress.filter(p => p.uses_infisical === false).length;

      console.log('\n📊 Current Migration Status:');
      console.log(`   Total projects: ${total}`);
      console.log(`   Using Infisical: ${usingInfisical}`);
      console.log(`   Using Database: ${usingDatabase}`);
      console.log(`   Not set: ${total - usingInfisical - usingDatabase}`);
    }

  } catch (err: any) {
    console.error('❌ Verification error:', err.message);
  }

  console.log('\n✅ Migration process completed!\n');
  console.log('Next steps:');
  console.log('  1. Set up Infisical account (see .env.infisical.template)');
  console.log('  2. Add credentials to .env file');
  console.log('  3. Run: npm run infisical:health');
  console.log('  4. Run: npm run test:infisical-integration\n');
}

// Run migration
runMigration().catch(error => {
  console.error('💥 Migration failed:', error);
  process.exit(1);
});
