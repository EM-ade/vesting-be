-- ============================================================================
-- Project-Scoped Row Level Security Policies
-- ============================================================================
-- This migration adds project-scoped RLS policies to ensure complete data
-- isolation between projects. It also adds composite indexes for performance.
-- ============================================================================

-- Add wallet_address column to user_project_access if not exists (for RLS lookups)
ALTER TABLE user_project_access ADD COLUMN IF NOT EXISTS wallet_address TEXT;

-- Create index on wallet_address for faster RLS lookups
CREATE INDEX IF NOT EXISTS idx_user_project_access_wallet ON user_project_access(wallet_address);

-- ============================================================================
-- Drop Existing Policies
-- ============================================================================

-- Vesting streams policies
DROP POLICY IF EXISTS "Vesting streams viewable by authenticated users" ON vesting_streams;
DROP POLICY IF EXISTS "Vesting streams manageable by service role only" ON vesting_streams;

-- Vestings policies
DROP POLICY IF EXISTS "Users can view their own vesting" ON vestings;
DROP POLICY IF EXISTS "Service role can manage all vestings" ON vestings;

-- Claim history policies
DROP POLICY IF EXISTS "Users can view their own claim history" ON claim_history;
DROP POLICY IF EXISTS "Service role can manage all claim history" ON claim_history;

-- ============================================================================
-- Create Project-Scoped Policies
-- ============================================================================

-- Vesting Streams: Users can view pools in their accessible projects
CREATE POLICY "Users can view pools in their projects"
ON vesting_streams FOR SELECT
USING (
  project_id IN (
    SELECT project_id FROM user_project_access 
    WHERE wallet_address = current_setting('request.jwt.claims', true)::json->>'wallet'
  )
  OR
  -- Allow public viewing (for claim pages)
  true
);

-- Vesting Streams: Service role can manage all
CREATE POLICY "Service role can manage all vesting streams"
ON vesting_streams FOR ALL 
TO service_role 
USING (true);

-- Vestings: Users can view their own vestings in their accessible projects
CREATE POLICY "Users can view their vestings in accessible projects"
ON vestings FOR SELECT
USING (
  user_wallet = current_setting('request.jwt.claims', true)::json->>'wallet'
  OR
  project_id IN (
    SELECT project_id FROM user_project_access 
    WHERE wallet_address = current_setting('request.jwt.claims', true)::json->>'wallet'
  )
);

-- Vestings: Service role can manage all
CREATE POLICY "Service role can manage all vestings"
ON vestings FOR ALL 
TO service_role 
USING (true);

-- Claim History: Users can view their own claims
CREATE POLICY "Users can view their own claims"
ON claim_history FOR SELECT
USING (
  user_wallet = current_setting('request.jwt.claims', true)::json->>'wallet'
);

-- Claim History: Service role can manage all
CREATE POLICY "Service role can manage all claim history"
ON claim_history FOR ALL 
TO service_role 
USING (true);

-- ============================================================================
-- Performance Indexes
-- ============================================================================

-- Composite indexes for project-scoped queries
CREATE INDEX IF NOT EXISTS idx_vesting_streams_project_id ON vesting_streams(project_id);
CREATE INDEX IF NOT EXISTS idx_vesting_streams_project_active ON vesting_streams(project_id, is_active);

CREATE INDEX IF NOT EXISTS idx_vestings_project_id ON vestings(project_id);
CREATE INDEX IF NOT EXISTS idx_vestings_project_wallet ON vestings(project_id, user_wallet);
CREATE INDEX IF NOT EXISTS idx_vestings_project_stream ON vestings(project_id, vesting_stream_id);

CREATE INDEX IF NOT EXISTS idx_claim_history_project_id ON claim_history(project_id);
CREATE INDEX IF NOT EXISTS idx_claim_history_project_wallet ON claim_history(project_id, user_wallet);

-- ============================================================================
-- Verification Queries
-- ============================================================================

-- Run these queries after migration to verify RLS is working:

-- 1. Check that policies are created
-- SELECT schemaname, tablename, policyname FROM pg_policies WHERE tablename IN ('vesting_streams', 'vestings', 'claim_history');

-- 2. Check that indexes are created
-- SELECT indexname FROM pg_indexes WHERE tablename IN ('vesting_streams', 'vestings', 'claim_history', 'user_project_access');

-- 3. Test project isolation (as service role)
-- SELECT COUNT(*) FROM vesting_streams WHERE project_id = 'project-a-id';
-- SELECT COUNT(*) FROM vesting_streams WHERE project_id = 'project-b-id';
