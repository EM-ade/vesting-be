-- ============================================================================
-- FINAL CORRECT SCHEMA - Matches Backend Code Expectations
-- ============================================================================
-- Run this to drop old tables and create fresh schema
-- WARNING: This will delete all existing data
-- ============================================================================

-- Drop all tables (CASCADE removes dependencies)
DROP TABLE IF EXISTS claim_attempts CASCADE;
DROP TABLE IF EXISTS claim_history CASCADE;
DROP TABLE IF EXISTS vestings CASCADE;
DROP TABLE IF EXISTS vesting_streams CASCADE;
DROP TABLE IF EXISTS eligibility_checks CASCADE;
DROP TABLE IF EXISTS sync_logs CASCADE;
DROP TABLE IF EXISTS admin_logs CASCADE;
DROP TABLE IF EXISTS config CASCADE;

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- CONFIG TABLE (Single Row)
-- ============================================================================
CREATE TABLE config (
  id INT PRIMARY KEY DEFAULT 1,
  admin_wallet TEXT NOT NULL,
  token_mint TEXT NOT NULL,
  fee_wallet TEXT,
  claim_fee_sol NUMERIC DEFAULT 0.01,
  claim_fee_usd NUMERIC DEFAULT 10.00,
  vesting_mode TEXT DEFAULT 'snapshot',
  snapshot_date TIMESTAMPTZ,
  allow_mode_switch BOOLEAN DEFAULT true,
  grace_period_days INT DEFAULT 30,
  require_nft_on_claim BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT single_row CHECK (id = 1),
  CONSTRAINT valid_mode CHECK (vesting_mode IN ('snapshot', 'dynamic'))
);

-- ============================================================================
-- VESTING STREAMS TABLE (Pool Configurations)
-- ============================================================================
CREATE TABLE vesting_streams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  description TEXT,
  nft_requirements JSONB NOT NULL,
  tier_allocations JSONB NOT NULL,
  total_pool_amount NUMERIC NOT NULL,
  vesting_duration_days INT NOT NULL,
  cliff_duration_days INT NOT NULL,
  grace_period_days INT NOT NULL DEFAULT 30,
  streamflow_stream_id TEXT UNIQUE,
  vesting_mode TEXT DEFAULT 'snapshot',
  is_active BOOLEAN DEFAULT true,
  require_nft_on_claim BOOLEAN DEFAULT true,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  snapshot_date TIMESTAMPTZ,
  claim_fee_lamports BIGINT NOT NULL DEFAULT 1000000,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT positive_amounts CHECK (
    total_pool_amount > 0 AND
    vesting_duration_days > 0 AND
    cliff_duration_days >= 0 AND
    grace_period_days >= 0 AND
    claim_fee_lamports >= 0
  ),
  CONSTRAINT valid_vesting_mode CHECK (vesting_mode IN ('snapshot', 'dynamic'))
);

-- ============================================================================
-- VESTINGS TABLE (Individual User Allocations)
-- ============================================================================
CREATE TABLE vestings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vesting_stream_id UUID REFERENCES vesting_streams(id) ON DELETE CASCADE,
  user_wallet TEXT NOT NULL,
  nft_count INT NOT NULL DEFAULT 0,
  tier INT NOT NULL,
  streamflow_stream_id TEXT,
  token_amount NUMERIC NOT NULL,
  share_percentage NUMERIC,
  is_active BOOLEAN DEFAULT TRUE,
  is_cancelled BOOLEAN DEFAULT FALSE,
  last_verified TIMESTAMPTZ DEFAULT NOW(),
  vesting_mode TEXT DEFAULT 'snapshot',
  snapshot_locked BOOLEAN DEFAULT false,
  claim_verification_enabled BOOLEAN DEFAULT true,
  grace_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  CONSTRAINT positive_amount CHECK (token_amount > 0),
  CONSTRAINT positive_nft_count CHECK (nft_count >= 0),
  CONSTRAINT unique_user_per_stream UNIQUE(vesting_stream_id, user_wallet)
);

-- ============================================================================
-- CLAIM HISTORY TABLE
-- ============================================================================
CREATE TABLE claim_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_wallet TEXT NOT NULL,
  vesting_id UUID REFERENCES vestings(id),
  amount_claimed NUMERIC NOT NULL,
  fee_paid NUMERIC NOT NULL,
  transaction_signature TEXT NOT NULL,
  claimed_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT positive_claim_amount CHECK (amount_claimed > 0),
  CONSTRAINT positive_fee CHECK (fee_paid >= 0),
  CONSTRAINT unique_claim_per_wallet_signature UNIQUE (user_wallet, transaction_signature)
);

-- ============================================================================
-- ADMIN LOGS TABLE
-- ============================================================================
CREATE TABLE admin_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  action TEXT NOT NULL,
  admin_wallet TEXT NOT NULL,
  target_wallet TEXT,
  details JSONB,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- ELIGIBILITY CHECKS TABLE
-- ============================================================================
CREATE TABLE eligibility_checks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet TEXT NOT NULL,
  nft_count INT NOT NULL,
  eligible BOOLEAN NOT NULL,
  checked_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT positive_nft_count_check CHECK (nft_count >= 0)
);

-- ============================================================================
-- SYNC LOGS TABLE
-- ============================================================================
CREATE TABLE sync_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sync_type TEXT NOT NULL,
  wallets_checked INT NOT NULL DEFAULT 0,
  streams_created INT NOT NULL DEFAULT 0,
  streams_cancelled INT NOT NULL DEFAULT 0,
  wallets_updated INT NOT NULL DEFAULT 0,
  errors INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ DEFAULT NOW(),
  details JSONB,
  CONSTRAINT positive_counts CHECK (
    wallets_checked >= 0 AND 
    streams_created >= 0 AND 
    streams_cancelled >= 0 AND
    wallets_updated >= 0 AND
    errors >= 0
  )
);

-- ============================================================================
-- CLAIM ATTEMPTS TABLE
-- ============================================================================
CREATE TABLE claim_attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_wallet TEXT NOT NULL,
  attempted_at TIMESTAMPTZ DEFAULT NOW(),
  nft_count INT NOT NULL,
  required_nft_count INT NOT NULL,
  success BOOLEAN NOT NULL,
  reason TEXT,
  amount_attempted NUMERIC,
  CONSTRAINT positive_nft_counts CHECK (nft_count >= 0 AND required_nft_count >= 0)
);

-- ============================================================================
-- INDEXES
-- ============================================================================
CREATE INDEX idx_vesting_streams_is_active ON vesting_streams(is_active);
CREATE INDEX idx_vesting_streams_vesting_mode ON vesting_streams(vesting_mode);
CREATE INDEX idx_vesting_streams_streamflow_id ON vesting_streams(streamflow_stream_id);

CREATE INDEX idx_vestings_stream_id ON vestings(vesting_stream_id);
CREATE INDEX idx_vestings_user_wallet ON vestings(user_wallet);
CREATE INDEX idx_vestings_is_active ON vestings(is_active);
CREATE INDEX idx_vestings_tier ON vestings(tier);
CREATE INDEX idx_vestings_is_cancelled ON vestings(is_cancelled);

CREATE INDEX idx_claim_history_user_wallet ON claim_history(user_wallet);
CREATE INDEX idx_claim_history_vesting_id ON claim_history(vesting_id);
CREATE INDEX idx_claim_history_claimed_at ON claim_history(claimed_at DESC);

CREATE INDEX idx_admin_logs_action ON admin_logs(action);
CREATE INDEX idx_admin_logs_admin_wallet ON admin_logs(admin_wallet);
CREATE INDEX idx_admin_logs_created_at ON admin_logs(created_at DESC);

CREATE INDEX idx_eligibility_checks_wallet ON eligibility_checks(wallet);
CREATE INDEX idx_eligibility_checks_checked_at ON eligibility_checks(checked_at DESC);
CREATE INDEX idx_eligibility_checks_eligible ON eligibility_checks(eligible);

CREATE INDEX idx_sync_logs_sync_type ON sync_logs(sync_type);
CREATE INDEX idx_sync_logs_started_at ON sync_logs(started_at DESC);

CREATE INDEX idx_claim_attempts_wallet ON claim_attempts(user_wallet);
CREATE INDEX idx_claim_attempts_attempted_at ON claim_attempts(attempted_at DESC);
CREATE INDEX idx_claim_attempts_success ON claim_attempts(success);

-- ============================================================================
-- TRIGGERS
-- ============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_config_updated_at
BEFORE UPDATE ON config
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_vesting_streams_updated_at
BEFORE UPDATE ON vesting_streams
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================
ALTER TABLE config ENABLE ROW LEVEL SECURITY;
ALTER TABLE vesting_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE vestings ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE eligibility_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_attempts ENABLE ROW LEVEL SECURITY;

-- Config policies
CREATE POLICY "Config viewable by authenticated users"
ON config FOR SELECT TO authenticated USING (true);

CREATE POLICY "Config editable by service role only"
ON config FOR ALL TO service_role USING (true);

-- Vesting streams policies
CREATE POLICY "Vesting streams viewable by authenticated users"
ON vesting_streams FOR SELECT TO authenticated USING (true);

CREATE POLICY "Vesting streams manageable by service role only"
ON vesting_streams FOR ALL TO service_role USING (true);

-- Vestings policies
CREATE POLICY "Users can view their own vesting"
ON vestings FOR SELECT TO authenticated
USING (user_wallet = current_setting('request.jwt.claims', true)::json->>'wallet');

CREATE POLICY "Service role can manage all vestings"
ON vestings FOR ALL TO service_role USING (true);

-- Claim history policies
CREATE POLICY "Users can view their own claim history"
ON claim_history FOR SELECT TO authenticated
USING (user_wallet = current_setting('request.jwt.claims', true)::json->>'wallet');

CREATE POLICY "Service role can manage all claim history"
ON claim_history FOR ALL TO service_role USING (true);

-- Admin logs policies (service role only)
CREATE POLICY "Admin logs viewable by service role only"
ON admin_logs FOR SELECT TO service_role USING (true);

CREATE POLICY "Admin logs insertable by service role only"
ON admin_logs FOR INSERT TO service_role WITH CHECK (true);

-- Eligibility checks policies (service role only)
CREATE POLICY "Eligibility checks viewable by service role only"
ON eligibility_checks FOR SELECT TO service_role USING (true);

CREATE POLICY "Eligibility checks insertable by service role only"
ON eligibility_checks FOR INSERT TO service_role WITH CHECK (true);

-- Sync logs policies (service role only)
CREATE POLICY "Sync logs viewable by service role only"
ON sync_logs FOR SELECT TO service_role USING (true);

CREATE POLICY "Sync logs insertable by service role only"
ON sync_logs FOR INSERT TO service_role WITH CHECK (true);

CREATE POLICY "Sync logs updatable by service role only"
ON sync_logs FOR UPDATE TO service_role USING (true);

-- Claim attempts policies (service role only)
CREATE POLICY "Claim attempts viewable by service role only"
ON claim_attempts FOR SELECT TO service_role USING (true);

CREATE POLICY "Claim attempts insertable by service role only"
ON claim_attempts FOR INSERT TO service_role WITH CHECK (true);

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================
-- Drop existing functions first
DROP FUNCTION IF EXISTS get_user_vesting(TEXT);
DROP FUNCTION IF EXISTS get_active_vestings_count();
DROP FUNCTION IF EXISTS get_total_tokens_vested();
DROP FUNCTION IF EXISTS get_total_tokens_claimed();
DROP FUNCTION IF EXISTS get_latest_eligibility(TEXT);

CREATE OR REPLACE FUNCTION get_user_vesting(wallet_address TEXT)
RETURNS TABLE (
  vesting_id UUID,
  user_wallet TEXT,
  nft_count INT,
  tier INT,
  streamflow_stream_id TEXT,
  token_amount NUMERIC,
  share_percentage NUMERIC,
  is_active BOOLEAN,
  is_cancelled BOOLEAN,
  total_claimed NUMERIC,
  last_claim_date TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    v.id,
    v.user_wallet,
    v.nft_count,
    v.tier,
    v.streamflow_stream_id,
    v.token_amount,
    v.share_percentage,
    v.is_active,
    v.is_cancelled,
    COALESCE(SUM(ch.amount_claimed), 0) as total_claimed,
    MAX(ch.claimed_at) as last_claim_date
  FROM vestings v
  LEFT JOIN claim_history ch ON v.id = ch.vesting_id
  WHERE v.user_wallet = wallet_address
  GROUP BY v.id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_active_vestings_count()
RETURNS INT AS $$
BEGIN
  RETURN (SELECT COUNT(*) FROM vestings WHERE is_active = TRUE AND is_cancelled = FALSE);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_total_tokens_vested()
RETURNS NUMERIC AS $$
BEGIN
  RETURN (SELECT COALESCE(SUM(token_amount), 0) FROM vestings WHERE is_cancelled = FALSE);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_total_tokens_claimed()
RETURNS NUMERIC AS $$
BEGIN
  RETURN (SELECT COALESCE(SUM(amount_claimed), 0) FROM claim_history);
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- INSERT DEFAULT CONFIG
-- ============================================================================
INSERT INTO config (
  id,
  admin_wallet,
  token_mint,
  fee_wallet,
  claim_fee_sol,
  claim_fee_usd,
  vesting_mode,
  allow_mode_switch,
  grace_period_days,
  require_nft_on_claim
)
VALUES (
  1,
  'REPLACE_WITH_YOUR_ADMIN_WALLET',
  'REPLACE_WITH_YOUR_TOKEN_MINT',
  'REPLACE_WITH_YOUR_FEE_WALLET',
  0.01,
  10.00,
  'snapshot',
  true,
  30,
  true
);

-- ============================================================================
-- DONE!
-- ============================================================================
-- Schema created successfully
-- Remember to replace the placeholder wallet addresses in the config row
