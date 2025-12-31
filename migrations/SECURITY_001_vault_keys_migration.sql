-- ============================================
-- SECURITY MIGRATION: Separate Private Keys
-- ============================================
-- Purpose: Move vault_private_key_encrypted to backend-only table
-- Security: Physical separation prevents client API access
-- Impact: CRITICAL - Protects $500k-$5M in treasury funds
-- Rollback: See end of file
-- ============================================
-- Supabase SQL Editor Compatible
-- Run this entire script in Supabase SQL editor
-- ============================================

-- ============================================
-- STEP 1: Create vault_keys table (backend-only)
-- ============================================
CREATE TABLE IF NOT EXISTS vault_keys (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  private_key_encrypted TEXT NOT NULL,
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_accessed TIMESTAMPTZ,
  access_count INT DEFAULT 0,
  
  -- Audit trail
  created_by TEXT, -- Wallet that created project
  rotation_history JSONB DEFAULT '[]'::jsonb -- Track key rotations
);

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_vault_keys_last_accessed ON vault_keys(last_accessed DESC);

COMMENT ON TABLE vault_keys IS 'Backend-only storage for encrypted vault private keys. NO RLS = client cannot access.';
COMMENT ON COLUMN vault_keys.private_key_encrypted IS 'AES-256-GCM encrypted Solana private key. Never expose to frontend.';

-- ============================================
-- STEP 2: Migrate existing keys
-- ============================================
INSERT INTO vault_keys (project_id, private_key_encrypted, created_at, created_by)
SELECT 
  id, 
  vault_private_key_encrypted, 
  created_at,
  (SELECT wallet_address FROM user_project_access WHERE project_id = projects.id AND role = 'owner' LIMIT 1)
FROM projects
WHERE vault_private_key_encrypted IS NOT NULL
ON CONFLICT (project_id) DO NOTHING;

-- Verify migration success
DO $$
DECLARE
  projects_with_keys INT;
  migrated_keys INT;
BEGIN
  SELECT COUNT(*) INTO projects_with_keys FROM projects WHERE vault_private_key_encrypted IS NOT NULL;
  SELECT COUNT(*) INTO migrated_keys FROM vault_keys;
  
  IF projects_with_keys != migrated_keys THEN
    RAISE EXCEPTION 'Migration verification failed: % projects have keys but only % migrated', 
      projects_with_keys, migrated_keys;
  END IF;
  
  RAISE NOTICE 'Migration successful: % vault keys migrated', migrated_keys;
END;
$$;

-- ============================================
-- STEP 3: Drop old column (CRITICAL STEP)
-- ============================================
-- WARNING: This permanently removes private keys from projects table
-- Ensure vault_keys table has all data before running

ALTER TABLE projects DROP COLUMN IF EXISTS vault_private_key_encrypted;

-- ============================================
-- STEP 4: Create access logging function
-- ============================================
CREATE OR REPLACE FUNCTION log_vault_key_access(p_project_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE vault_keys
  SET 
    last_accessed = NOW(),
    access_count = access_count + 1
  WHERE project_id = p_project_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION log_vault_key_access IS 'Logs every time a vault key is accessed. Call from backend before decrypting.';

-- ============================================
-- STEP 5: NO RLS ON vault_keys
-- ============================================
-- CRITICAL: Do NOT enable RLS on vault_keys
-- Only backend service role should access this table
-- Client API keys should never see this table

-- Verify RLS is disabled
DO $$
BEGIN
  IF (SELECT relrowsecurity FROM pg_class WHERE relname = 'vault_keys') THEN
    RAISE EXCEPTION 'SECURITY ERROR: RLS must NOT be enabled on vault_keys table';
  END IF;
  
  RAISE NOTICE '✅ Verified: RLS is disabled on vault_keys (correct state)';
END;
$$;

-- ============================================
-- STEP 6: Grant permissions (backend only)
-- ============================================
-- Only service role (backend) can access
REVOKE ALL ON vault_keys FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON vault_keys TO service_role;

-- ============================================
-- VERIFICATION QUERIES (Run after migration)
-- ============================================
-- Check migration success:
-- SELECT COUNT(*) FROM vault_keys;
-- SELECT project_id, created_at, access_count FROM vault_keys LIMIT 5;

-- Verify old column is gone:
-- SELECT column_name FROM information_schema.columns 
-- WHERE table_name = 'projects' AND column_name = 'vault_private_key_encrypted';
-- Should return 0 rows

-- ============================================
-- ROLLBACK PROCEDURE (Emergency only)
-- ============================================
-- WARNING: Only use if migration fails
-- This re-adds the column but data may be lost

/*
BEGIN;

-- Re-add column
ALTER TABLE projects ADD COLUMN vault_private_key_encrypted TEXT;

-- Restore data
UPDATE projects p
SET vault_private_key_encrypted = vk.private_key_encrypted
FROM vault_keys vk
WHERE p.id = vk.project_id;

-- Drop vault_keys table
DROP TABLE vault_keys;

COMMIT;
*/
