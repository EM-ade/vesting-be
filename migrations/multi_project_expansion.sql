-- Create projects table
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    mint_address TEXT NOT NULL, -- Can be non-unique globally, but maybe unique per project if it's the main token? Let's keep it simple.
    logo_url TEXT,
    description TEXT,
    website_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    vault_public_key TEXT, -- Nullable initially
    vault_private_key_encrypted TEXT, -- Nullable initially
    vault_balance_token NUMERIC DEFAULT 0,
    vault_balance_sol NUMERIC DEFAULT 0,
    claim_fee_lamports BIGINT NOT NULL DEFAULT 1000000,
    fee_recipient_address TEXT -- Where fees go
);

-- Create user_project_access table
CREATE TABLE IF NOT EXISTS user_project_access (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL, -- referencing auth.users but we might not have FK constraint if auth schema is separate. usually auth.users(id).
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, project_id)
);

-- Create manual_uploads table
CREATE TABLE IF NOT EXISTS manual_uploads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
    filename TEXT NOT NULL,
    processed_data JSONB, -- To store the rows temporarily
    processed_at TIMESTAMPTZ DEFAULT NOW(),
    uploaded_by UUID -- referencing auth.users
);

-- Add Project ID to existing tables
ALTER TABLE vesting_streams ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id);
ALTER TABLE claim_history ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id);
-- ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id); -- Snapshot table unknown, skipping
ALTER TABLE vestings ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id);

-- Add Pool Type and State to vesting_streams
ALTER TABLE vesting_streams 
ADD COLUMN IF NOT EXISTS pool_type TEXT NOT NULL DEFAULT 'SNAPSHOT' CHECK (pool_type IN ('SNAPSHOT', 'DYNAMIC', 'MANUAL')),
ADD COLUMN IF NOT EXISTS state TEXT DEFAULT 'STABLE' CHECK (state IN ('STABLE', 'PENDING_RECALCULATION', 'RECALCULATING')),
ADD COLUMN IF NOT EXISTS snapshot_config_id UUID, -- REFERENCES snapshot_configs(id) -- table unknown
ADD COLUMN IF NOT EXISTS dynamic_rule_set JSONB,
ADD COLUMN IF NOT EXISTS manual_upload_id UUID REFERENCES manual_uploads(id);

-- Add Allocation Tracking Columns
ALTER TABLE vestings 
ADD COLUMN IF NOT EXISTS is_dynamic BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS last_eligibility_check TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS is_eligible BOOLEAN DEFAULT TRUE;

-- Create dynamic_pool_rules table
CREATE TABLE IF NOT EXISTS dynamic_pool_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id UUID REFERENCES vesting_streams(id) ON DELETE CASCADE NOT NULL,
    rule_type TEXT NOT NULL CHECK (rule_type IN ('NFT_HOLDING', 'TOKEN_BALANCE', 'STAKE')),
    rule_config JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(pool_id)
);

-- Row Level Security Policies (Draft)
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_project_access ENABLE ROW LEVEL SECURITY;

-- Backfill Strategy (Commented out logic)
-- INSERT INTO projects (name, symbol, mint_address) VALUES ('LilGarg', 'GARG', 'ExistingMintAddress');
-- UPDATE vesting_streams SET project_id = (SELECT id FROM projects WHERE name = 'LilGarg' LIMIT 1) WHERE project_id IS NULL;
