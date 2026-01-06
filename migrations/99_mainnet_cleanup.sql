-- ============================================================================
-- MAINNET CLEANUP SCRIPT
-- ============================================================================
-- WARNING: This will DELETE ALL DATA from your database!
-- Use this when moving from testnet/devnet to mainnet to start fresh.
-- 
-- This script:
-- 1. Deletes all data from all tables
-- 2. Resets all sequences
-- 3. Preserves the schema, indexes, and RLS policies
-- 
-- IMPORTANT: Make a backup before running if you want to keep any data!
--
-- To run:
-- psql $DATABASE_URL -f migrations/99_mainnet_cleanup.sql
-- ============================================================================

-- Disable triggers temporarily for faster deletion
SET session_replication_role = 'replica';

-- ============================================================================
-- Step 1: Delete all data from tables (in correct order to respect foreign keys)
-- ============================================================================

TRUNCATE TABLE claim_history CASCADE;
TRUNCATE TABLE vestings CASCADE;
TRUNCATE TABLE vesting_streams CASCADE;
TRUNCATE TABLE user_project_access CASCADE;
TRUNCATE TABLE projects CASCADE;
TRUNCATE TABLE admin_logs CASCADE;

-- Note: auth_users table is NOT truncated - you may want to keep admin accounts
-- If you want to clear auth_users too, uncomment:
-- TRUNCATE TABLE auth_users CASCADE;

-- ============================================================================
-- Step 2: Reset sequences (IDs will start from 1 again)
-- ============================================================================

-- No sequences to reset (all tables use UUIDs)

-- ============================================================================
-- Step 3: Re-enable triggers
-- ============================================================================

SET session_replication_role = 'origin';

-- ============================================================================
-- Step 4: Verify cleanup
-- ============================================================================

DO $$
DECLARE
    claim_count INTEGER;
    vesting_count INTEGER;
    stream_count INTEGER;
    project_count INTEGER;
    access_count INTEGER;
    log_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO claim_count FROM claim_history;
    SELECT COUNT(*) INTO vesting_count FROM vestings;
    SELECT COUNT(*) INTO stream_count FROM vesting_streams;
    SELECT COUNT(*) INTO project_count FROM projects;
    SELECT COUNT(*) INTO access_count FROM user_project_access;
    SELECT COUNT(*) INTO log_count FROM admin_logs;
    
    RAISE NOTICE '===========================================';
    RAISE NOTICE 'CLEANUP COMPLETE - Verification:';
    RAISE NOTICE '===========================================';
    RAISE NOTICE 'claim_history: % rows', claim_count;
    RAISE NOTICE 'vestings: % rows', vesting_count;
    RAISE NOTICE 'vesting_streams: % rows', stream_count;
    RAISE NOTICE 'projects: % rows', project_count;
    RAISE NOTICE 'user_project_access: % rows', access_count;
    RAISE NOTICE 'admin_logs: % rows', log_count;
    RAISE NOTICE '===========================================';
    
    IF claim_count = 0 AND vesting_count = 0 AND stream_count = 0 AND 
       project_count = 0 AND access_count = 0 AND log_count = 0 THEN
        RAISE NOTICE '✅ All data cleared successfully!';
        RAISE NOTICE 'Your database is ready for mainnet.';
    ELSE
        RAISE WARNING '⚠️ Some tables still have data. Please check.';
    END IF;
    
    RAISE NOTICE '===========================================';
END $$;

-- ============================================================================
-- Step 5: Vacuum tables to reclaim space
-- ============================================================================
-- Note: VACUUM commands removed because they cannot run inside a transaction block
-- Run these separately if needed:
-- VACUUM FULL claim_history;
-- VACUUM FULL vestings;
-- VACUUM FULL vesting_streams;
-- VACUUM FULL user_project_access;
-- VACUUM FULL projects;
-- VACUUM FULL admin_logs;

-- ============================================================================
-- NOTES:
-- ============================================================================
-- 1. All indexes are preserved
-- 2. All RLS policies are preserved
-- 3. All triggers are preserved
-- 4. Schema structure is unchanged
-- 5. auth_users table is NOT cleared (keep your admin accounts)
--
-- After running this script:
-- 1. Create your first mainnet project in the UI
-- 2. Set up your mainnet treasury wallet
-- 3. Start creating pools for real users!
-- ============================================================================
