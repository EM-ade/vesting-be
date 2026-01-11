-- Migration: Add pool creation fee support
-- This adds pool_creation_fee_usd to config table (charged when creating pools)
-- Similar to claim_fee_usd but for pool creation instead of claims

-- Add pool_creation_fee_usd to config table (in USD, converted to SOL at creation time)
ALTER TABLE config ADD COLUMN IF NOT EXISTS pool_creation_fee_usd DECIMAL(10,2) DEFAULT 0;

-- Add comment for documentation
COMMENT ON COLUMN config.pool_creation_fee_usd IS 'Fee charged in USD when creating a vesting pool. Converted to SOL at creation time using real-time price.';

-- Add fee_wallet column if not exists (where fees are sent)
ALTER TABLE config ADD COLUMN IF NOT EXISTS fee_wallet VARCHAR(255);

-- Track pool creation fees paid in vesting_streams
ALTER TABLE vesting_streams ADD COLUMN IF NOT EXISTS creation_fee_paid DECIMAL(20,9) DEFAULT 0;
ALTER TABLE vesting_streams ADD COLUMN IF NOT EXISTS creation_fee_tx VARCHAR(255);

COMMENT ON COLUMN vesting_streams.creation_fee_paid IS 'Pool creation fee paid in SOL';
COMMENT ON COLUMN vesting_streams.creation_fee_tx IS 'Transaction signature for pool creation fee payment';

-- Set a default pool creation fee (e.g., $5 USD) - adjust as needed
UPDATE config SET pool_creation_fee_usd = 5.00 WHERE pool_creation_fee_usd IS NULL OR pool_creation_fee_usd = 0;
