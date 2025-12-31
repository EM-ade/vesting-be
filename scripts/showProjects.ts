import { getSupabaseClient } from '../src/lib/supabaseClient';

async function showProjects() {
  const supabase = getSupabaseClient();
  
  const { data: projects, error } = await supabase
    .from('projects')
    .select('id, name, uses_infisical')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching projects:', error);
    return;
  }

  console.log('\n📊 Your Current Projects:\n');
  projects?.forEach((p, i) => {
    const storage = p.uses_infisical ? '✅ Infisical' : '🔐 vault_keys';
    console.log(`   ${i + 1}. ${p.name}`);
    console.log(`      Storage: ${storage}`);
    console.log(`      ID: ${p.id}\n`);
  });
}

showProjects();
