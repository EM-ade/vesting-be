/**
 * Cleanup test projects created during integration testing
 */

import { getSupabaseClient } from '../src/lib/supabaseClient';

async function cleanup() {
  const supabase = getSupabaseClient();
  
  console.log('🧹 Cleaning up test projects...\n');

  // Delete test projects (those named "Infisical Test Project")
  const { data: testProjects } = await supabase
    .from('projects')
    .select('id, name')
    .eq('name', 'Infisical Test Project');

  if (testProjects && testProjects.length > 0) {
    console.log(`Found ${testProjects.length} test projects to delete:\n`);
    
    for (const project of testProjects) {
      console.log(`   Deleting: ${project.name} (${project.id})`);
      
      const { error } = await supabase
        .from('projects')
        .delete()
        .eq('id', project.id);

      if (error) {
        console.error(`   ❌ Error: ${error.message}`);
      } else {
        console.log(`   ✅ Deleted`);
      }
    }
    
    console.log('\n✅ Cleanup complete!\n');
  } else {
    console.log('ℹ️  No test projects found.\n');
  }

  // Show remaining projects
  const { data: remaining } = await supabase
    .from('projects')
    .select('id, name, uses_infisical')
    .order('created_at', { ascending: true });

  console.log('📊 Remaining projects:\n');
  remaining?.forEach((p, i) => {
    const storage = p.uses_infisical ? '✅ Infisical' : '🔐 vault_keys';
    console.log(`   ${i + 1}. ${p.name} - ${storage}`);
  });
  console.log('');
}

cleanup();
