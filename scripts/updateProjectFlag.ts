/**
 * Update uses_infisical flag for a project
 */

import { getSupabaseClient } from '../src/lib/supabaseClient';

async function updateFlag(projectId: string) {
  const supabase = getSupabaseClient();
  
  console.log(`Updating uses_infisical flag for project: ${projectId}\n`);
  
  const { error } = await supabase
    .from('projects')
    .update({ uses_infisical: true })
    .eq('id', projectId);

  if (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }

  console.log('✅ Flag updated successfully\n');

  // Verify
  const { data: project } = await supabase
    .from('projects')
    .select('id, name, uses_infisical')
    .eq('id', projectId)
    .single();

  if (project) {
    console.log('Verification:');
    console.log(`  Project: ${project.name}`);
    console.log(`  Uses Infisical: ${project.uses_infisical ? '✅ Yes' : '❌ No'}\n`);
  }
}

const projectId = process.argv[2] || 'd0fe85c4-c11f-401f-9d65-5c2611e96bae';
updateFlag(projectId);
