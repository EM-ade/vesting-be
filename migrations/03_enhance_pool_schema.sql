-- Phase 2: Enhance pool schema for allocation tracking
-- Migration: 03_enhance_pool_schema.sql

-- Add allocation type tracking to vestings table
ALTER TABLE vestings 
ADD COLUMN IF NOT EXISTS allocation_type TEXT CHECK (allocation_type IN ('percentage', 'fixed')),
ADD COLUMN IF NOT EXISTS allocation_value NUMERIC,
ADD COLUMN IF NOT EXISTS original_percentage NUMERIC;

-- Add comment for clarity
COMMENT ON COLUMN vestings.allocation_type IS 'Original allocation type: percentage or fixed';
COMMENT ON COLUMN vestings.allocation_value IS 'Original allocation value (either % or token amount)';
COMMENT ON COLUMN vestings.original_percentage IS 'Original percentage if type was percentage';

-- Add pool editing history table
CREATE TABLE IF NOT EXISTS pool_edit_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id UUID REFERENCES vesting_streams(id) ON DELETE CASCADE,
  field_changed TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT,
  changed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pool_edit_history_pool_id ON pool_edit_history(pool_id);
CREATE INDEX IF NOT EXISTS idx_pool_edit_history_changed_at ON pool_edit_history(changed_at DESC);

-- Add treasury transaction history table
CREATE TABLE IF NOT EXISTS treasury_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  token_mint TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  transaction_type TEXT CHECK (transaction_type IN ('deposit', 'withdrawal', 'claim', 'refund')) NOT NULL,
  transaction_signature TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_treasury_transactions_project_id ON treasury_transactions(project_id);
CREATE INDEX IF NOT EXISTS idx_treasury_transactions_type ON treasury_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_treasury_transactions_created_at ON treasury_transactions(created_at DESC);

-- Add dynamic pool recalculation tracking
CREATE TABLE IF NOT EXISTS dynamic_pool_recalculations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id UUID REFERENCES vesting_streams(id) ON DELETE CASCADE,
  recalculation_type TEXT CHECK (recalculation_type IN ('scheduled', 'manual', 'triggered')) NOT NULL,
  changes_detected BOOLEAN DEFAULT FALSE,
  users_added INTEGER DEFAULT 0,
  users_removed INTEGER DEFAULT 0,
  allocations_changed INTEGER DEFAULT 0,
  total_allocated_before NUMERIC,
  total_allocated_after NUMERIC,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT CHECK (status IN ('running', 'completed', 'failed')) DEFAULT 'running',
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_dynamic_pool_recalc_pool_id ON dynamic_pool_recalculations(pool_id);
CREATE INDEX IF NOT EXISTS idx_dynamic_pool_recalc_started_at ON dynamic_pool_recalculations(started_at DESC);
