-- Fix conflicting state constraints and normalize data

-- 1. Drop potential conflicting constraints
-- 'vesting_streams_state_check' is likely the default name from the multi_project_expansion migration
ALTER TABLE vesting_streams DROP CONSTRAINT IF EXISTS vesting_streams_state_check;
-- 'valid_state' is the name from the add_pool_state migration
ALTER TABLE vesting_streams DROP CONSTRAINT IF EXISTS valid_state;

-- 2. Normalize existing state values to lowercase allowed values
-- Map legacy/uppercase statuses to 'active', 'paused', or 'cancelled'
UPDATE vesting_streams 
SET state = 'active' 
WHERE state IS NULL 
   OR state IN ('STABLE', 'stable',` 'ACTIVE', 'PENDING_RECALCULATION', 'RECALCULATING');

UPDATE vesting_streams 
SET state = 'paused' 
WHERE state IN ('PAUSED');

UPDATE vesting_streams 
SET state = 'cancelled' 
WHERE state IN ('CANCELLED', 'completed', 'COMPLETED');

-- 3. Ensure default is 'active'
ALTER TABLE vesting_streams ALTER COLUMN state SET DEFAULT 'active';

-- 4. Add the definitive constraint matching the application logic
ALTER TABLE vesting_streams ADD CONSTRAINT valid_state CHECK (state IN ('active', 'paused', 'cancelled'));

-- 5. Optional: Fix vesting_mode/pool_type casing if needed (safe update)
-- This ensures consistency if the user manually entered uppercase values previously
UPDATE vesting_streams SET vesting_mode = lower(vesting_mode) WHERE vesting_mode IS NOT NULL;
