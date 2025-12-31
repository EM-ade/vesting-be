-- ============================================================================
-- MIGRATION: Add Infisical Support
-- ============================================================================
-- Description: Adds column to track which projects use Infisical for key storage
-- and creates audit log table for vault access tracking
-- 
-- Run with: psql -d vesting_db -f migrations/07_add_infisical_support.sql
-- ============================================================================

-- Step 1: Add flag to track migration status
ALTER TABLE projects 
ADD COLUMN IF NOT EXISTS uses_infisical BOOLEAN DEFAULT FALSE;

-- Add comment
COMMENT ON COLUMN projects.uses_infisical IS 
  'TRUE if project uses Infisical for key storage, FALSE if using database encryption';

-- Step 2: Add column to track last key access (for monitoring)
ALTER TABLE projects
ADD COLUMN IF NOT EXISTS vault_last_accessed TIMESTAMPTZ;

COMMENT ON COLUMN projects.vault_last_accessed IS 
  'Timestamp of last vault key access (for debugging and monitoring)';

-- Step 3: Create audit log for key access
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

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_vault_access_log_project_id 
  ON vault_access_log(project_id);

CREATE INDEX IF NOT EXISTS idx_vault_access_log_accessed_at 
  ON vault_access_log(accessed_at DESC);

CREATE INDEX IF NOT EXISTS idx_vault_access_log_success 
  ON vault_access_log(success) WHERE success = FALSE;

-- Add comments
COMMENT ON TABLE vault_access_log IS 
  'Audit trail for all vault key access attempts (both database and Infisical)';

COMMENT ON COLUMN vault_access_log.access_type IS 
  'Type of operation: create (new vault), retrieve (get key), delete (remove vault), rotate (change key)';

-- Step 4: Create index for uses_infisical flag
CREATE INDEX IF NOT EXISTS idx_projects_uses_infisical 
  ON projects(uses_infisical);

-- Step 5: Set existing projects to use database encryption
UPDATE projects 
SET uses_infisical = FALSE 
WHERE vault_private_key_encrypted IS NOT NULL 
  AND uses_infisical IS NULL;

-- Step 6: Create view for monitoring migration progress
CREATE OR REPLACE VIEW migration_progress AS
SELECT 
  COUNT(*) as total_projects,
  COUNT(*) FILTER (WHERE uses_infisical = TRUE) as using_infisical,
  COUNT(*) FILTER (WHERE uses_infisical = FALSE) as using_database,
  COUNT(*) FILTER (WHERE vault_private_key_encrypted IS NOT NULL) as has_db_backup,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE uses_infisical = TRUE) / NULLIF(COUNT(*), 0), 
    2
  ) as percent_migrated
FROM projects 
WHERE is_active = TRUE;

COMMENT ON VIEW migration_progress IS 
  'Shows migration progress from database encryption to Infisical';

-- Step 7: Create function to log vault access
CREATE OR REPLACE FUNCTION log_vault_access(
  p_project_id UUID,
  p_access_type TEXT,
  p_success BOOLEAN,
  p_error_message TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
  v_log_id UUID;
BEGIN
  INSERT INTO vault_access_log (
    project_id,
    access_type,
    success,
    error_message
  ) VALUES (
    p_project_id,
    p_access_type,
    p_success,
    p_error_message
  ) RETURNING id INTO v_log_id;
  
  -- Update last accessed timestamp on project
  IF p_success AND p_access_type = 'retrieve' THEN
    UPDATE projects 
    SET vault_last_accessed = NOW() 
    WHERE id = p_project_id;
  END IF;
  
  RETURN v_log_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION log_vault_access IS 
  'Helper function to log vault access attempts and update project last_accessed timestamp';

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- Check migration progress
SELECT * FROM migration_progress;

-- Check recent vault access attempts
SELECT 
  val.accessed_at,
  p.name as project_name,
  val.access_type,
  val.success,
  val.error_message
FROM vault_access_log val
JOIN projects p ON p.id = val.project_id
ORDER BY val.accessed_at DESC
LIMIT 10;

-- Show projects by storage type
SELECT 
  uses_infisical,
  COUNT(*) as count,
  ARRAY_AGG(name ORDER BY name) as project_names
FROM projects 
WHERE is_active = TRUE
GROUP BY uses_infisical;

-- ============================================================================
-- ROLLBACK SCRIPT (if needed)
-- ============================================================================
-- 
-- DROP VIEW IF EXISTS migration_progress;
-- DROP FUNCTION IF EXISTS log_vault_access;
-- DROP TABLE IF EXISTS vault_access_log;
-- ALTER TABLE projects DROP COLUMN IF EXISTS vault_last_accessed;
-- ALTER TABLE projects DROP COLUMN IF EXISTS uses_infisical;
-- 
-- ============================================================================

\echo '✅ Migration 07_add_infisical_support.sql completed successfully'
\echo ''
\echo '📊 Current migration status:'
SELECT * FROM migration_progress;
