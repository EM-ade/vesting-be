/**
 * Mainnet Cleanup Script
 * 
 * DANGER: This will DELETE ALL DATA from the database!
 * Use this when moving from testnet/devnet to mainnet to start fresh.
 * 
 * Usage:
 *   npx ts-node scripts/cleanupForMainnet.ts
 * 
 * With confirmation bypass (DANGEROUS):
 *   npx ts-node scripts/cleanupForMainnet.ts --yes-i-am-sure
 */

import { createClient } from '@supabase/supabase-js';
import * as readline from 'readline';
import * as dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Error: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function askConfirmation(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes');
    });
  });
}

async function cleanupDatabase() {
  console.log('\n' + '='.repeat(60));
  console.log('🚨 MAINNET CLEANUP SCRIPT 🚨');
  console.log('='.repeat(60));
  console.log('\nThis will DELETE ALL DATA from your database!');
  console.log('\nTables to be cleared:');
  console.log('  - claim_history');
  console.log('  - vestings');
  console.log('  - vesting_streams');
  console.log('  - user_project_access');
  console.log('  - projects');
  console.log('  - admin_logs');
  console.log('\nTables that will NOT be cleared:');
  console.log('  - auth_users (your admin accounts will be preserved)');
  console.log('\n' + '='.repeat(60));

  // Check if bypass flag is set
  const bypassConfirmation = process.argv.includes('--yes-i-am-sure');

  if (!bypassConfirmation) {
    // First confirmation
    const confirm1 = await askConfirmation('\nAre you ABSOLUTELY SURE you want to delete all data? (type "yes"): ');
    
    if (!confirm1) {
      console.log('\n❌ Cleanup cancelled. No data was deleted.');
      process.exit(0);
    }

    // Get current counts
    console.log('\n📊 Current database state:');
    const { data: projects } = await supabase.from('projects').select('id', { count: 'exact', head: true });
    const { data: streams } = await supabase.from('vesting_streams').select('id', { count: 'exact', head: true });
    const { data: vestings } = await supabase.from('vestings').select('id', { count: 'exact', head: true });
    const { data: claims } = await supabase.from('claim_history').select('id', { count: 'exact', head: true });
    
    console.log(`  - Projects: ${(projects as any)?.count || 0}`);
    console.log(`  - Pools: ${(streams as any)?.count || 0}`);
    console.log(`  - Vestings: ${(vestings as any)?.count || 0}`);
    console.log(`  - Claims: ${(claims as any)?.count || 0}`);

    // Second confirmation
    const confirm2 = await askConfirmation('\nThis is your LAST CHANCE. Type "DELETE EVERYTHING" to proceed: ');
    
    if (confirm2 !== true) {
      console.log('\n❌ Cleanup cancelled. No data was deleted.');
      process.exit(0);
    }
  } else {
    console.log('\n⚠️ Bypass flag detected. Skipping confirmations...');
  }

  console.log('\n🗑️ Starting cleanup...\n');

  try {
    // Delete in order (respecting foreign keys)
    console.log('Deleting claim_history...');
    const { error: claimsError } = await supabase.from('claim_history').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (claimsError) throw claimsError;
    console.log('✅ claim_history cleared');

    console.log('Deleting vestings...');
    const { error: vestingsError } = await supabase.from('vestings').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (vestingsError) throw vestingsError;
    console.log('✅ vestings cleared');

    console.log('Deleting vesting_streams...');
    const { error: streamsError } = await supabase.from('vesting_streams').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (streamsError) throw streamsError;
    console.log('✅ vesting_streams cleared');

    console.log('Deleting user_project_access...');
    const { error: accessError } = await supabase.from('user_project_access').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (accessError) throw accessError;
    console.log('✅ user_project_access cleared');

    console.log('Deleting projects...');
    const { error: projectsError } = await supabase.from('projects').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (projectsError) throw projectsError;
    console.log('✅ projects cleared');

    console.log('Deleting admin_logs...');
    const { error: logsError } = await supabase.from('admin_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (logsError) throw logsError;
    console.log('✅ admin_logs cleared');

    console.log('\n' + '='.repeat(60));
    console.log('✅ CLEANUP COMPLETE!');
    console.log('='.repeat(60));
    console.log('\nYour database is now clean and ready for mainnet.');
    console.log('\nNext steps:');
    console.log('1. Switch your wallet to Solana mainnet');
    console.log('2. Create your first mainnet project in the UI');
    console.log('3. Set up your mainnet treasury wallet');
    console.log('4. Start creating pools for real users!');
    console.log('\n' + '='.repeat(60) + '\n');

  } catch (error) {
    console.error('\n❌ Error during cleanup:', error);
    process.exit(1);
  }
}

cleanupDatabase();
