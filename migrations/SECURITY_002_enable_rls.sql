-- ============================================
-- SECURITY MIGRATION: Enable Row-Level Security
-- ============================================
-- Purpose: Enforce data isolation between projects and users
-- Security: Prevents cross-project data access
-- Impact: CRITICAL - Database-level access control
-- ============================================
-- Supabase SQL Editor Compatible
-- Run this entire script in Supabase SQL editor
-- ============================================

-- ============================================
-- PROJECTS TABLE RLS
-- ============================================

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

-- Policy 1: Users see only projects they have access to
DROP POLICY IF EXISTS "users_see_accessible_projects" ON projects;
CREATE POLICY "users_see_accessible_projects"
ON projects FOR SELECT
USING (
  id IN (
    SELECT project_id 
    FROM user_project_access 
    WHERE wallet_address = current_setting('request.jwt.claims', true)::json->>'wallet_address'
  )
);

COMMENT ON POLICY "users_see_accessible_projects" ON projects IS 
  'Users can only view projects where they have explicit access. Prevents cross-project data leakage.';

-- Policy 2: Only owners can update projects
DROP POLICY IF EXISTS "only_owners_update_projects" ON projects;
CREATE POLICY "only_owners_update_projects"
ON projects FOR UPDATE
USING (
  id IN (
    SELECT project_id 
    FROM user_project_access 
    WHERE wallet_address = current_setting('request.jwt.claims', true)::json->>'wallet_address'
      AND role = 'owner'
  )
);

COMMENT ON POLICY "only_owners_update_projects" ON projects IS 
  'Only project owners can update project settings. Prevents unauthorized modifications.';

-- Policy 3: Only owners can delete projects
DROP POLICY IF EXISTS "only_owners_delete_projects" ON projects;
CREATE POLICY "only_owners_delete_projects"
ON projects FOR DELETE
USING (
  id IN (
    SELECT project_id 
    FROM user_project_access 
    WHERE wallet_address = current_setting('request.jwt.claims', true)::json->>'wallet_address'
      AND role = 'owner'
  )
);

-- ============================================
-- USER_PROJECT_ACCESS TABLE RLS
-- ============================================

ALTER TABLE user_project_access ENABLE ROW LEVEL SECURITY;

-- Policy 4: Users see their own access records
DROP POLICY IF EXISTS "users_see_own_access" ON user_project_access;
CREATE POLICY "users_see_own_access"
ON user_project_access FOR SELECT
USING (
  wallet_address = current_setting('request.jwt.claims', true)::json->>'wallet_address'
);

-- Policy 5: Owners can manage access for their projects
DROP POLICY IF EXISTS "owners_manage_project_access" ON user_project_access;
CREATE POLICY "owners_manage_project_access"
ON user_project_access FOR ALL
USING (
  project_id IN (
    SELECT project_id 
    FROM user_project_access 
    WHERE wallet_address = current_setting('request.jwt.claims', true)::json->>'wallet_address'
      AND role = 'owner'
  )
);

COMMENT ON POLICY "owners_manage_project_access" ON user_project_access IS
  'Project owners can add/remove admins and manage roles for their project only.';

-- ============================================
-- VESTING_STREAMS (POOLS) TABLE RLS
-- ============================================

ALTER TABLE vesting_streams ENABLE ROW LEVEL SECURITY;

-- Policy 6: Admins manage their project pools
DROP POLICY IF EXISTS "admins_manage_project_pools" ON vesting_streams;
CREATE POLICY "admins_manage_project_pools"
ON vesting_streams FOR ALL
USING (
  project_id IN (
    SELECT project_id 
    FROM user_project_access 
    WHERE wallet_address = current_setting('request.jwt.claims', true)::json->>'wallet_address'
      AND role IN ('admin', 'owner')
  )
);

COMMENT ON POLICY "admins_manage_project_pools" ON vesting_streams IS
  'Admins and owners can create/read/update/delete pools for their projects. Project isolation enforced.';

-- Policy 7: Users see pools they have vestings in
DROP POLICY IF EXISTS "users_see_pools_with_vestings" ON vesting_streams;
CREATE POLICY "users_see_pools_with_vestings"
ON vesting_streams FOR SELECT
USING (
  id IN (
    SELECT vesting_stream_id 
    FROM vestings 
    WHERE user_wallet = current_setting('request.jwt.claims', true)::json->>'wallet_address'
      AND is_active = true
  )
);

COMMENT ON POLICY "users_see_pools_with_vestings" ON vesting_streams IS
  'Users can view pool details for pools where they have active vestings. Needed for claim UI.';

-- ============================================
-- VESTINGS TABLE RLS
-- ============================================

ALTER TABLE vestings ENABLE ROW LEVEL SECURITY;

-- Policy 8: Users see only their own vestings
DROP POLICY IF EXISTS "users_see_own_vestings" ON vestings;
CREATE POLICY "users_see_own_vestings"
ON vestings FOR SELECT
USING (
  user_wallet = current_setting('request.jwt.claims', true)::json->>'wallet_address'
);

COMMENT ON POLICY "users_see_own_vestings" ON vestings IS
  'Users can only view their own vesting allocations. Privacy protection.';

-- Policy 9: Admins see vestings for their project pools
DROP POLICY IF EXISTS "admins_see_project_vestings" ON vestings;
CREATE POLICY "admins_see_project_vestings"
ON vestings FOR SELECT
USING (
  vesting_stream_id IN (
    SELECT id 
    FROM vesting_streams 
    WHERE project_id IN (
      SELECT project_id 
      FROM user_project_access 
      WHERE wallet_address = current_setting('request.jwt.claims', true)::json->>'wallet_address'
        AND role IN ('admin', 'owner')
    )
  )
);

-- Policy 10a: Admins insert vestings for their pools
DROP POLICY IF EXISTS "admins_insert_project_vestings" ON vestings;
CREATE POLICY "admins_insert_project_vestings"
ON vestings FOR INSERT
WITH CHECK (
  vesting_stream_id IN (
    SELECT id 
    FROM vesting_streams 
    WHERE project_id IN (
      SELECT project_id 
      FROM user_project_access 
      WHERE wallet_address = current_setting('request.jwt.claims', true)::json->>'wallet_address'
        AND role IN ('admin', 'owner')
    )
  )
);

-- Policy 10b: Admins update vestings for their pools
DROP POLICY IF EXISTS "admins_update_project_vestings" ON vestings;
CREATE POLICY "admins_update_project_vestings"
ON vestings FOR UPDATE
USING (
  vesting_stream_id IN (
    SELECT id 
    FROM vesting_streams 
    WHERE project_id IN (
      SELECT project_id 
      FROM user_project_access 
      WHERE wallet_address = current_setting('request.jwt.claims', true)::json->>'wallet_address'
        AND role IN ('admin', 'owner')
    )
  )
);

-- Policy 10c: Admins delete vestings for their pools
DROP POLICY IF EXISTS "admins_delete_project_vestings" ON vestings;
CREATE POLICY "admins_delete_project_vestings"
ON vestings FOR DELETE
USING (
  vesting_stream_id IN (
    SELECT id 
    FROM vesting_streams 
    WHERE project_id IN (
      SELECT project_id 
      FROM user_project_access 
      WHERE wallet_address = current_setting('request.jwt.claims', true)::json->>'wallet_address'
        AND role IN ('admin', 'owner')
    )
  )
);

COMMENT ON POLICY "admins_insert_project_vestings" ON vestings IS
  'Admins can create vestings for pools in their projects. Required for allocation management.';
COMMENT ON POLICY "admins_update_project_vestings" ON vestings IS
  'Admins can update vestings for pools in their projects. Required for allocation management.';
COMMENT ON POLICY "admins_delete_project_vestings" ON vestings IS
  'Admins can delete vestings for pools in their projects. Required for allocation management.';

-- ============================================
-- CLAIM_HISTORY TABLE RLS
-- ============================================

ALTER TABLE claim_history ENABLE ROW LEVEL SECURITY;

-- Policy 11: Users see only their claim history
DROP POLICY IF EXISTS "users_see_own_claims" ON claim_history;
CREATE POLICY "users_see_own_claims"
ON claim_history FOR SELECT
USING (
  user_wallet = current_setting('request.jwt.claims', true)::json->>'wallet_address'
);

COMMENT ON POLICY "users_see_own_claims" ON claim_history IS
  'Users can view their own claim history. Privacy and transparency.';

-- Policy 12: Admins see claim history for their projects
DROP POLICY IF EXISTS "admins_see_project_claims" ON claim_history;
CREATE POLICY "admins_see_project_claims"
ON claim_history FOR SELECT
USING (
  project_id IN (
    SELECT project_id 
    FROM user_project_access 
    WHERE wallet_address = current_setting('request.jwt.claims', true)::json->>'wallet_address'
      AND role IN ('admin', 'owner')
  )
);

COMMENT ON POLICY "admins_see_project_claims" ON claim_history IS
  'Admins can monitor all claims for their projects. Auditing and analytics.';

-- ============================================
-- ADMIN_LOGS TABLE RLS
-- ============================================

ALTER TABLE admin_logs ENABLE ROW LEVEL SECURITY;

-- Policy 13: Admins see logs for their projects
DROP POLICY IF EXISTS "admins_see_project_logs" ON admin_logs;
CREATE POLICY "admins_see_project_logs"
ON admin_logs FOR SELECT
USING (
  project_id IN (
    SELECT project_id 
    FROM user_project_access 
    WHERE wallet_address = current_setting('request.jwt.claims', true)::json->>'wallet_address'
      AND role IN ('admin', 'owner')
  )
);

COMMENT ON POLICY "admins_see_project_logs" ON admin_logs IS
  'Admins can view audit logs for their projects. Transparency and accountability.';

-- ============================================
-- VERIFICATION
-- ============================================

DO $$
DECLARE
  rls_enabled_count INT;
BEGIN
  SELECT COUNT(*) INTO rls_enabled_count
  FROM pg_class
  WHERE relname IN ('projects', 'user_project_access', 'vesting_streams', 'vestings', 'claim_history', 'admin_logs')
    AND relrowsecurity = true;
  
  IF rls_enabled_count != 6 THEN
    RAISE EXCEPTION 'RLS verification failed: Expected 6 tables with RLS enabled, got %', rls_enabled_count;
  END IF;
  
  RAISE NOTICE '✅ RLS enabled on 6 tables: projects, user_project_access, vesting_streams, vestings, claim_history, admin_logs';
END;
$$;

-- ============================================
-- TEST QUERIES (Run to verify RLS works)
-- ============================================
-- These should be run with client API key (not service role)

-- Test 1: User can only see their projects
-- SET request.jwt.claims = '{"wallet_address": "TestWallet123"}';
-- SELECT * FROM projects; -- Should only show projects where TestWallet123 has access

-- Test 2: User can only see their vestings
-- SELECT * FROM vestings; -- Should only show vestings where user_wallet = TestWallet123

-- Test 3: Admin can see their project data
-- SELECT * FROM vesting_streams WHERE project_id = 'their-project-id';

-- ============================================
-- ROLLBACK PROCEDURE
-- ============================================
/*
DROP POLICY IF EXISTS "users_see_accessible_projects" ON projects;
DROP POLICY IF EXISTS "only_owners_update_projects" ON projects;
DROP POLICY IF EXISTS "only_owners_delete_projects" ON projects;
ALTER TABLE projects DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_see_own_access" ON user_project_access;
DROP POLICY IF EXISTS "owners_manage_project_access" ON user_project_access;
ALTER TABLE user_project_access DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_manage_project_pools" ON vesting_streams;
DROP POLICY IF EXISTS "users_see_pools_with_vestings" ON vesting_streams;
ALTER TABLE vesting_streams DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_see_own_vestings" ON vestings;
DROP POLICY IF EXISTS "admins_see_project_vestings" ON vestings;
DROP POLICY IF EXISTS "admins_insert_project_vestings" ON vestings;
DROP POLICY IF EXISTS "admins_update_project_vestings" ON vestings;
DROP POLICY IF EXISTS "admins_delete_project_vestings" ON vestings;
ALTER TABLE vestings DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_see_own_claims" ON claim_history;
DROP POLICY IF EXISTS "admins_see_project_claims" ON claim_history;
ALTER TABLE claim_history DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_see_project_logs" ON admin_logs;
ALTER TABLE admin_logs DISABLE ROW LEVEL SECURITY;
*/
