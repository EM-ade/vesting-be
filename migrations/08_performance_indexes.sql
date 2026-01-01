-- Performance Optimization Migration
-- Adds critical indexes to speed up dashboard and admin queries
-- Expected improvement: 50-70% faster query times on large datasets

-- ============================================================================
-- INDEX 1: vesting_streams - project and active status
-- ============================================================================
-- Speeds up: Pool listing, dashboard metrics, treasury calculations
-- Usage: WHERE project_id = X AND is_active = true
CREATE INDEX IF NOT EXISTS idx_vesting_streams_project_active 
  ON vesting_streams(project_id, is_active) 
  WHERE is_active = true;

-- ============================================================================
-- INDEX 2: vesting_streams - composite for token queries
-- ============================================================================
-- Speeds up: Multi-token metrics, token filtering
-- Usage: WHERE project_id = X AND is_active = true AND token_mint = Y
CREATE INDEX IF NOT EXISTS idx_vesting_streams_token_mint 
  ON vesting_streams(project_id, token_mint, is_active) 
  WHERE is_active = true;

-- ============================================================================
-- INDEX 3: vestings - stream and project lookup
-- ============================================================================
-- Speeds up: Allocation calculations, member lookups
-- Usage: WHERE vesting_stream_id = X AND project_id = Y AND is_active = true
CREATE INDEX IF NOT EXISTS idx_vestings_stream_project 
  ON vestings(vesting_stream_id, project_id, is_active) 
  WHERE is_active = true;

-- ============================================================================
-- INDEX 4: vestings - cancelled status
-- ============================================================================
-- Speeds up: Filtering out cancelled vestings
-- Usage: WHERE is_active = true AND is_cancelled = false
CREATE INDEX IF NOT EXISTS idx_vestings_active_not_cancelled 
  ON vestings(is_active, is_cancelled) 
  WHERE is_active = true AND is_cancelled = false;

-- ============================================================================
-- INDEX 5: claim_history - vesting and project lookup
-- ============================================================================
-- Speeds up: Claim aggregation, treasury calculations
-- Usage: WHERE vesting_id IN (...) or WHERE project_id = X
CREATE INDEX IF NOT EXISTS idx_claim_history_vesting_project 
  ON claim_history(vesting_id, project_id);

-- ============================================================================
-- INDEX 6: claim_history - time-based queries
-- ============================================================================
-- Speeds up: Recent claims, claim history charts
-- Usage: WHERE project_id = X AND claimed_at >= Y ORDER BY claimed_at DESC
CREATE INDEX IF NOT EXISTS idx_claim_history_project_time 
  ON claim_history(project_id, claimed_at DESC);

-- ============================================================================
-- INDEX 7: admin_logs - project filtering with JSONB
-- ============================================================================
-- Speeds up: Activity log filtering by project
-- Usage: WHERE (details->>'project_id') = X ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_admin_logs_project_time 
  ON admin_logs((details->>'project_id'), created_at DESC);

-- ============================================================================
-- INDEX 8: admin_logs - action type filtering
-- ============================================================================
-- Speeds up: Filtering logs by action type
-- Usage: WHERE action = 'CLAIM_COMPLETED' AND (details->>'project_id') = X
CREATE INDEX IF NOT EXISTS idx_admin_logs_action_project 
  ON admin_logs(action, (details->>'project_id'), created_at DESC);

-- ============================================================================
-- Analyze tables to update statistics for query planner
-- ============================================================================
ANALYZE vesting_streams;
ANALYZE vestings;
ANALYZE claim_history;
ANALYZE admin_logs;

-- ============================================================================
-- OPTIONAL: Create RPC function for optimized claim aggregation
-- ============================================================================
-- This function allows database-level aggregation of claims by stream
-- Significantly faster than client-side aggregation for large datasets

CREATE OR REPLACE FUNCTION get_claims_by_stream(stream_ids uuid[])
RETURNS TABLE (
  stream_id uuid,
  total_claimed numeric
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    v.vesting_stream_id as stream_id,
    COALESCE(SUM(ch.amount_claimed), 0) as total_claimed
  FROM vestings v
  LEFT JOIN claim_history ch ON ch.vesting_id = v.id
  WHERE v.vesting_stream_id = ANY(stream_ids)
    AND v.is_active = true
  GROUP BY v.vesting_stream_id;
END;
$$ LANGUAGE plpgsql STABLE;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION get_claims_by_stream(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION get_claims_by_stream(uuid[]) TO service_role;

-- ============================================================================
-- Performance Notes:
-- ============================================================================
-- 1. Partial indexes (WHERE clauses) save space and improve speed
-- 2. DESC ordering in time-based indexes matches common query patterns
-- 3. JSONB indexes enable fast filtering on JSON fields
-- 4. The RPC function reduces network roundtrips and client-side processing
-- 5. Run ANALYZE after creating indexes to update query planner statistics
--
-- Expected Results:
-- - Dashboard load time: 2-3 seconds (down from 30+ seconds)
-- - Pool listing: < 1 second (down from 2-5 seconds)
-- - Claims queries: < 500ms (down from 1-2 seconds)
-- - Activity log: < 300ms (down from 500-1000ms)
