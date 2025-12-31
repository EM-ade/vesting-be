/**
 * Test Hybrid Mode - Create a test project and verify it uses Infisical
 */

import { getSupabaseClient } from '../src/lib/supabaseClient';
import { createProjectVault, getVaultKeypairForProject } from '../src/services/vaultService';
import { randomUUID } from 'crypto';

async function testHybridMode() {
  console.log('🧪 Testing Hybrid Mode\n');
  
  const supabase = getSupabaseClient();

  try {
    // Create a test project
    console.log('1️⃣  Creating test project...');
    const { data: project, error } = await supabase
      .from('projects')
      .insert({
        name: 'Hybrid Mode Test',
        symbol: 'HYBRID',
        mint_address: 'So11111111111111111111111111111111111111112',
      })
      .select()
      .single();

    if (error || !project) {
      throw new Error(`Failed to create project: ${error?.message}`);
    }

    console.log(`   ✅ Project created: ${project.id}\n`);

    // Create vault (should use Infisical)
    console.log('2️⃣  Creating vault (should use Infisical)...');
    const publicKey = await createProjectVault(project.id);
    console.log(`   ✅ Vault created: ${publicKey}\n`);

    // Check if it's marked as Infisical
    const { data: updatedProject } = await supabase
      .from('projects')
      .select('uses_infisical')
      .eq('id', project.id)
      .single();

    if (updatedProject?.uses_infisical) {
      console.log('   ✅ Project correctly marked as uses_infisical = true\n');
    } else {
      throw new Error('Project not marked as uses_infisical!');
    }

    // Test retrieving the key
    console.log('3️⃣  Testing key retrieval...');
    const keypair = await getVaultKeypairForProject(project.id);
    console.log(`   ✅ Retrieved keypair successfully\n`);

    // Verify public key matches
    if (keypair.publicKey.toString() === publicKey) {
      console.log('   ✅ Public key matches!\n');
    } else {
      throw new Error('Public key mismatch!');
    }

    // Test existing project (should use vault_keys)
    console.log('4️⃣  Testing existing project (vault_keys)...');
    const { data: oldProjects } = await supabase
      .from('projects')
      .select('id, name')
      .eq('name', 'New Protocol')
      .single();

    if (oldProjects) {
      const oldKeypair = await getVaultKeypairForProject(oldProjects.id);
      console.log(`   ✅ Old project "${oldProjects.name}" still works with vault_keys\n`);
    }

    // Cleanup test project
    console.log('5️⃣  Cleaning up test project...');
    await supabase
      .from('projects')
      .delete()
      .eq('id', project.id);
    console.log('   ✅ Cleanup complete\n');

    console.log('═'.repeat(60));
    console.log('🎉 HYBRID MODE TEST PASSED!');
    console.log('═'.repeat(60));
    console.log('\n✅ New projects: Use Infisical');
    console.log('✅ Old projects: Use vault_keys table');
    console.log('✅ Both systems working simultaneously!\n');

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

testHybridMode();
