-- vesting-be/migrations/10_add_weight_support_to_nft_requirements.sql
-- Add weight support to NFT requirements for weighted distribution
-- Migration Date: 2026-02-21

-- The weight field is stored within the nft_requirements JSONB structure
-- No schema alteration needed - weight is added as a new JSON field
-- Example structure after migration:
-- nft_requirements = [
--   {
--     "name": "OG Holders",
--     "nftContract": "ABC123...",
--     "threshold": 1,
--     "allocationType": "PERCENTAGE",
--     "allocationValue": 50,
--     "enabled": true,
--     "weight": 2.0,
--     "description": "OG NFT collection - premium holders"
--   }
-- ]

-- Add GIN index for better JSON querying (supports weight-based queries)
CREATE INDEX IF NOT EXISTS idx_vesting_streams_nft_requirements_gin
ON vesting_streams USING GIN (nft_requirements);

-- Update column comment to document weight field
COMMENT ON COLUMN vesting_streams.nft_requirements IS 'NFT holding requirements for pool eligibility. Each rule includes: name, nftContract, threshold, allocationType, allocationValue, enabled, weight (default 1.0, higher = larger share), description';
