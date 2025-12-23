-- Migration: Add claim_fee_lamports to vesting_streams (pool-level claim fees)
-- This allows each pool to have its own claim fee instead of using global config

-- Add claim_fee_lamports column to vesting_streams
ALTER TABLE vesting_streams 
ADD COLUMN IF NOT EXISTS claim_fee_lamports BIGINT NOT NULL DEFAULT 1000000;

-- Add comment for documentation
COMMENT ON COLUMN vesting_streams.claim_fee_lamports IS 'Claim fee for this pool in lamports (1 SOL = 1,000,000,000 lamports). Default: 1,000,000 (0.001 SOL)';

-- Update existing pools to use the default value (0.001 SOL = 1,000,000 lamports)
UPDATE vesting_streams 
SET claim_fee_lamports = 1000000 
WHERE claim_fee_lamports IS NULL;
