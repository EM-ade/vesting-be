-- Create auth_users table to link wallets to Supabase Auth (or just internal user IDs)
-- This is needed because we are using wallet-based auth but Supabase uses UUIDs.
-- We can use this table to map wallet addresses to our own internal User UUIDs if Supabase Auth is not fully integrated.

CREATE TABLE IF NOT EXISTS auth_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

CREATE INDEX idx_auth_users_wallet ON auth_users(wallet_address);

-- Update user_project_access to reference auth_users(id) instead of auth.users(id) if we are not using Supabase Auth
-- Or we can keep it as is if we plan to use Supabase Auth.
-- Let's assume for now we want to support wallet-only auth.

-- If user_project_access.user_id is already referencing auth.users, we might have a conflict.
-- Let's check if we can add a wallet_address column to user_project_access for easier lookup.

ALTER TABLE user_project_access ADD COLUMN IF NOT EXISTS wallet_address TEXT;
CREATE INDEX idx_user_project_access_wallet ON user_project_access(wallet_address);

-- Create projects table triggers or functions if needed
