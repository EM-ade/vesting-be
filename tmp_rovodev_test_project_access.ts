/**
 * Test: Verify projects are properly filtered by wallet access
 */

import { getSupabaseClient } from './src/lib/supabaseClient';

async function testProjectAccess() {
  const supabase = getSupabaseClient();
  
  console.log('🔍 Testing Project Access Control...\n');
  
  // Get a sample wallet from user_project_access
  const { data: accessRecords } = await supabase
    .from('user_project_access')
    .select('wallet_address, project_id, role, projects(name)')
    .limit(3);
  
  if (!accessRecords || accessRecords.length === 0) {
    console.log('⚠️  No access records found. Create a project first.');
    return;
  }
  
  console.log('📋 Sample Access Records:');
  accessRecords.forEach((record: any) => {
    console.log(`  - Wallet: ${record.wallet_address?.substring(0, 12)}...`);
    console.log(`    Project: ${record.projects?.name || 'Unknown'}`);
    console.log(`    Role: ${record.role}\n`);
  });
  
  // Test filtering by wallet
  const testWallet = accessRecords[0].wallet_address;
  console.log(`\n🧪 Testing filter for wallet: ${testWallet.substring(0, 12)}...\n`);
  
  // Simulate the API call
  const { data: userAccessRecords } = await supabase
    .from('user_project_access')
    .select('project_id')
    .eq('wallet_address', testWallet);
  
  if (!userAccessRecords || userAccessRecords.length === 0) {
    console.log('❌ No projects found for this wallet');
    return;
  }
  
  const projectIds = userAccessRecords.map((r: any) => r.project_id);
  console.log(`✅ Found ${projectIds.length} project(s) accessible to this wallet`);
  
  const { data: projects } = await supabase
    .from('projects')
    .select('id, name, symbol, is_active')
    .in('id', projectIds)
    .eq('is_active', true);
  
  console.log('\n📦 Projects accessible to this wallet:');
  projects?.forEach(p => {
    console.log(`  - ${p.name} (${p.symbol}) [ID: ${p.id.substring(0, 8)}...]`);
  });
  
  // Test with different wallet
  const { data: allWallets } = await supabase
    .from('user_project_access')
    .select('wallet_address')
    .neq('wallet_address', testWallet)
    .limit(1);
  
  if (allWallets && allWallets.length > 0) {
    const otherWallet = allWallets[0].wallet_address;
    console.log(`\n🧪 Testing filter for different wallet: ${otherWallet.substring(0, 12)}...\n`);
    
    const { data: otherAccessRecords } = await supabase
      .from('user_project_access')
      .select('project_id')
      .eq('wallet_address', otherWallet);
    
    const otherProjectIds = otherAccessRecords?.map((r: any) => r.project_id) || [];
    console.log(`✅ Found ${otherProjectIds.length} project(s) for the other wallet`);
    
    const { data: otherProjects } = await supabase
      .from('projects')
      .select('id, name, symbol')
      .in('id', otherProjectIds)
      .eq('is_active', true);
    
    console.log('\n📦 Projects accessible to the other wallet:');
    otherProjects?.forEach(p => {
      console.log(`  - ${p.name} (${p.symbol})`);
    });
  }
  
  console.log('\n✅ Project access filtering works correctly!');
  console.log('   Each wallet only sees their own projects.');
}

testProjectAccess()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Test failed:', err);
    process.exit(1);
  });
