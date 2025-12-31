/**
 * Run Infisical Migration - Direct Approach
 * 
 * Uses individual Supabase queries to apply migration
 */

import { getSupabaseClient } from '../src/lib/supabaseClient';

async function runMigration() {
  console.log('🚀 Running Infisical Support Migration (Direct Approach)...\n');

  const supabase = getSupabaseClient();

  try {
    // Step 1: Check if columns already exist
    console.log('Step 1: Checking existing schema...');
    const { data: testProject } = await supabase
      .from('projects')
      .select('*')
      .limit(1)
      .single();

    const hasUsesInfisical = testProject && 'uses_infisical' in testProject;
    const hasVaultLastAccessed = testProject && 'vault_last_accessed' in testProject;

    console.log(`  uses_infisical column: ${hasUsesInfisical ? '✅ exists' : '❌ missing'}`);
    console.log(`  vault_last_accessed column: ${hasVaultLastAccessed ? '✅ exists' : '❌ missing'}`);

    if (!hasUsesInfisical || !hasVaultLastAccessed) {
      console.log('\n⚠️  Required columns are missing!');
      console.log('\nPlease run this SQL in Supabase SQL Editor:');
      console.log('https://supabase.com/dashboard/project/irxfajjcwhdgamzqqfyf/sql');
      console.log('\n' + '='.repeat(60));
      console.log(`
-- Add Infisical support columns
ALTER TABLE projects 
ADD COLUMN IF NOT EXISTS uses_infisical BOOLEAN DEFAULT FALSE;

ALTER TABLE projects
ADD COLUMN IF NOT EXISTS vault_last_accessed TIMESTAMPTZ;

-- Create index
CREATE INDEX IF NOT EXISTS idx_projects_uses_infisical 
  ON projects(uses_infisical);

-- Set existing projects to use database encryption
UPDATE projects 
SET uses_infisical = FALSE 
WHERE vault_private_key_encrypted IS NOT NULL 
  AND uses_infisical IS NULL;
      `.trim());
      console.log('='.repeat(60));
      console.log('\nAfter running the SQL, run this script again.\n');
      return;
    }

    // Step 2: Update existing projects (check vault_keys table, not column)
    console.log('\nStep 2: Setting existing projects to use vault_keys table...');
    
    // Get projects that have vault keys
    const { data: projectsWithKeys, error: vaultKeysError } = await supabase
      .from('vault_keys')
      .select('project_id');

    if (vaultKeysError) {
      console.error('  ⚠️  Could not check vault_keys table:', vaultKeysError.message);
    } else if (projectsWithKeys && projectsWithKeys.length > 0) {
      const projectIds = projectsWithKeys.map(vk => vk.project_id);
      
      const { error: updateError } = await supabase
        .from('projects')
        .update({ uses_infisical: false })
        .in('id', projectIds);

      if (updateError) {
        console.error('  ❌ Error:', updateError.message);
      } else {
        console.log(`  ✅ Updated ${projectIds.length} existing projects to use vault_keys table`);
      }
    } else {
      console.log('  ℹ️  No projects with vault_keys entries found');
    }

    // Step 3: Check for vault_access_log table
    console.log('\nStep 3: Checking vault_access_log table...');
    const { error: logError } = await supabase
      .from('vault_access_log')
      .select('id')
      .limit(1);

    if (logError) {
      console.log('  ❌ Table does not exist');
      console.log('\nPlease run this SQL in Supabase SQL Editor:');
      console.log('\n' + '='.repeat(60));
      console.log(`
-- Create audit log table
CREATE TABLE IF NOT EXISTS vault_access_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  accessed_at TIMESTAMPTZ DEFAULT NOW(),
  access_type TEXT CHECK (access_type IN ('create', 'retrieve', 'delete', 'rotate')),
  success BOOLEAN NOT NULL,
  error_message TEXT,
  ip_address TEXT,
  user_agent TEXT
);

-- Add indexes
CREATE INDEX IF NOT EXISTS idx_vault_access_log_project_id 
  ON vault_access_log(project_id);

CREATE INDEX IF NOT EXISTS idx_vault_access_log_accessed_at 
  ON vault_access_log(accessed_at DESC);

CREATE INDEX IF NOT EXISTS idx_vault_access_log_success 
  ON vault_access_log(success) WHERE success = FALSE;
      `.trim());
      console.log('='.repeat(60));
    } else {
      console.log('  ✅ Table exists');
    }

    // Step 4: Show migration status
    console.log('\n📊 Current Migration Status:');
    const { data: allProjects } = await supabase
      .from('projects')
      .select('id, name, uses_infisical');

    // Get vault_keys count
    const { data: vaultKeysData } = await supabase
      .from('vault_keys')
      .select('project_id');

    if (allProjects) {
      const total = allProjects.length;
      const usingInfisical = allProjects.filter(p => p.uses_infisical === true).length;
      const usingVaultKeys = allProjects.filter(p => p.uses_infisical === false).length;
      const notSet = allProjects.filter(p => p.uses_infisical === null).length;
      const hasVaultKey = vaultKeysData ? vaultKeysData.length : 0;

      console.log(`   Total projects: ${total}`);
      console.log(`   Using Infisical: ${usingInfisical}`);
      console.log(`   Using vault_keys: ${usingVaultKeys}`);
      console.log(`   Not set: ${notSet}`);
      console.log(`   Has vault_keys backup: ${hasVaultKey}`);
      
      // Show project names if not too many
      if (total <= 10) {
        console.log('\n   Project details:');
        allProjects.forEach(p => {
          const storage = p.uses_infisical === true ? 'Infisical' : 
                         p.uses_infisical === false ? 'vault_keys' : 'not set';
          console.log(`     • ${p.name}: ${storage}`);
        });
      }
    }

    console.log('\n✅ Migration check completed!\n');
    console.log('Next steps:');
    console.log('  1. Ensure all SQL statements above are run (if any were shown)');
    console.log('  2. Set up Infisical account (see .env.infisical.template)');
    console.log('  3. Add credentials to .env file');
    console.log('  4. Run: npm run infisical:health\n');

  } catch (error: any) {
    console.error('💥 Migration check failed:', error.message);
    process.exit(1);
  }
}

// Run migration
runMigration().catch(error => {
  console.error('💥 Script failed:', error);
  process.exit(1);
});
