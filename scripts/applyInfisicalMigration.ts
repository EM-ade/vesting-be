/**
 * Apply Infisical Migration using Supabase Admin API
 * 
 * This script uses the Supabase Management API to run raw SQL
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

async function applyMigration() {
  console.log('🚀 Applying Infisical Migration via Supabase API...\n');

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }

  // Extract project reference from URL
  const projectRef = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
  
  if (!projectRef) {
    console.error('❌ Could not extract project reference from SUPABASE_URL');
    process.exit(1);
  }

  console.log(`Project Reference: ${projectRef}`);
  console.log(`Supabase URL: ${supabaseUrl}\n`);

  // SQL to execute
  const sql = `
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
WHERE vault_private_key_encrypted IS NOT NULL;

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
  `.trim();

  console.log('SQL to execute:');
  console.log('='.repeat(60));
  console.log(sql);
  console.log('='.repeat(60));
  console.log('\n⚠️  Unfortunately, Supabase does not provide a public API to run arbitrary SQL.');
  console.log('You need to run this SQL manually in the Supabase SQL Editor.\n');
  console.log('📋 Steps:');
  console.log(`1. Go to: https://supabase.com/dashboard/project/${projectRef}/sql`);
  console.log('2. Paste the SQL above');
  console.log('3. Click "Run" button');
  console.log('4. Verify the changes');
  console.log('5. Run: npx ts-node scripts/runInfisicalMigrationDirect.ts (to verify)\n');
  
  console.log('✅ SQL prepared. Please apply manually in Supabase Dashboard.\n');
}

applyMigration().catch(error => {
  console.error('💥 Error:', error);
  process.exit(1);
});
