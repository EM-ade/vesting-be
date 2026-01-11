-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public._migrations (
  id integer NOT NULL DEFAULT nextval('_migrations_id_seq'::regclass),
  name text NOT NULL UNIQUE,
  executed_at timestamp with time zone DEFAULT now(),
  CONSTRAINT _migrations_pkey PRIMARY KEY (id)
);
CREATE TABLE public.admin_logs (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  action text NOT NULL,
  admin_wallet text NOT NULL,
  target_wallet text,
  details jsonb,
  ip_address text,
  user_agent text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT admin_logs_pkey PRIMARY KEY (id)
);
CREATE TABLE public.auth_users (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  wallet_address text NOT NULL UNIQUE,
  created_at timestamp with time zone DEFAULT now(),
  last_login_at timestamp with time zone,
  CONSTRAINT auth_users_pkey PRIMARY KEY (id)
);
CREATE TABLE public.claim_attempts (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_wallet text NOT NULL,
  attempted_at timestamp with time zone DEFAULT now(),
  nft_count integer NOT NULL,
  required_nft_count integer NOT NULL,
  success boolean NOT NULL,
  reason text,
  amount_attempted numeric,
  CONSTRAINT claim_attempts_pkey PRIMARY KEY (id)
);
CREATE TABLE public.claim_history (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_wallet text NOT NULL,
  vesting_id uuid,
  amount_claimed numeric NOT NULL CHECK (amount_claimed > 0::numeric),
  fee_paid numeric NOT NULL CHECK (fee_paid >= 0::numeric),
  transaction_signature text NOT NULL,
  claimed_at timestamp with time zone DEFAULT now(),
  project_id uuid,
  CONSTRAINT claim_history_pkey PRIMARY KEY (id),
  CONSTRAINT claim_history_vesting_id_fkey FOREIGN KEY (vesting_id) REFERENCES public.vestings(id),
  CONSTRAINT claim_history_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);
CREATE TABLE public.config (
  id integer NOT NULL DEFAULT 1 CHECK (id = 1),
  admin_wallet text NOT NULL,
  token_mint text NOT NULL,
  fee_wallet text,
  claim_fee_sol numeric DEFAULT 0.01,
  claim_fee_usd numeric DEFAULT 10.00,
  vesting_mode text DEFAULT 'snapshot'::text CHECK (vesting_mode = ANY (ARRAY['snapshot'::text, 'dynamic'::text, 'manual'::text])),
  snapshot_date timestamp with time zone,
  allow_mode_switch boolean DEFAULT true,
  grace_period_days integer DEFAULT 30,
  require_nft_on_claim boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  enable_claims boolean DEFAULT true,
  cooldown_days integer DEFAULT 1,
  pool_creation_fee_usd numeric DEFAULT 0,
  CONSTRAINT config_pkey PRIMARY KEY (id)
);
CREATE TABLE public.dynamic_pool_recalculations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  pool_id uuid,
  recalculation_type text NOT NULL CHECK (recalculation_type = ANY (ARRAY['scheduled'::text, 'manual'::text, 'triggered'::text])),
  changes_detected boolean DEFAULT false,
  users_added integer DEFAULT 0,
  users_removed integer DEFAULT 0,
  allocations_changed integer DEFAULT 0,
  total_allocated_before numeric,
  total_allocated_after numeric,
  started_at timestamp with time zone DEFAULT now(),
  completed_at timestamp with time zone,
  status text DEFAULT 'running'::text CHECK (status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text])),
  error_message text,
  CONSTRAINT dynamic_pool_recalculations_pkey PRIMARY KEY (id),
  CONSTRAINT dynamic_pool_recalculations_pool_id_fkey FOREIGN KEY (pool_id) REFERENCES public.vesting_streams(id)
);
CREATE TABLE public.dynamic_pool_rules (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL UNIQUE,
  rule_type text NOT NULL CHECK (rule_type = ANY (ARRAY['NFT_HOLDING'::text, 'TOKEN_BALANCE'::text, 'STAKE'::text])),
  rule_config jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT dynamic_pool_rules_pkey PRIMARY KEY (id),
  CONSTRAINT dynamic_pool_rules_pool_id_fkey FOREIGN KEY (pool_id) REFERENCES public.vesting_streams(id)
);
CREATE TABLE public.eligibility_checks (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  wallet text NOT NULL,
  nft_count integer NOT NULL CHECK (nft_count >= 0),
  eligible boolean NOT NULL,
  checked_at timestamp with time zone DEFAULT now(),
  CONSTRAINT eligibility_checks_pkey PRIMARY KEY (id)
);
CREATE TABLE public.manual_uploads (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  filename text NOT NULL,
  processed_data jsonb,
  processed_at timestamp with time zone DEFAULT now(),
  uploaded_by uuid,
  CONSTRAINT manual_uploads_pkey PRIMARY KEY (id),
  CONSTRAINT manual_uploads_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);
CREATE TABLE public.pool_edit_history (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  pool_id uuid,
  field_changed text NOT NULL,
  old_value text,
  new_value text,
  changed_by text,
  changed_at timestamp with time zone DEFAULT now(),
  CONSTRAINT pool_edit_history_pkey PRIMARY KEY (id),
  CONSTRAINT pool_edit_history_pool_id_fkey FOREIGN KEY (pool_id) REFERENCES public.vesting_streams(id)
);
CREATE TABLE public.projects (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  symbol text NOT NULL,
  mint_address text NOT NULL,
  logo_url text,
  description text,
  website_url text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  is_active boolean DEFAULT true,
  vault_public_key text,
  vault_balance_token numeric DEFAULT 0,
  vault_balance_sol numeric DEFAULT 0,
  claim_fee_lamports bigint NOT NULL DEFAULT 1000000,
  fee_recipient_address text,
  uses_infisical boolean DEFAULT false,
  vault_last_accessed timestamp with time zone,
  CONSTRAINT projects_pkey PRIMARY KEY (id)
);
CREATE TABLE public.sync_logs (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  sync_type text NOT NULL,
  wallets_checked integer NOT NULL DEFAULT 0,
  streams_created integer NOT NULL DEFAULT 0,
  streams_cancelled integer NOT NULL DEFAULT 0,
  wallets_updated integer NOT NULL DEFAULT 0,
  errors integer NOT NULL DEFAULT 0,
  started_at timestamp with time zone NOT NULL,
  completed_at timestamp with time zone DEFAULT now(),
  details jsonb,
  CONSTRAINT sync_logs_pkey PRIMARY KEY (id)
);
CREATE TABLE public.treasury_transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid,
  token_mint text NOT NULL,
  amount numeric NOT NULL,
  transaction_type text NOT NULL CHECK (transaction_type = ANY (ARRAY['deposit'::text, 'withdrawal'::text, 'claim'::text, 'refund'::text])),
  transaction_signature text,
  notes text,
  created_by text,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT treasury_transactions_pkey PRIMARY KEY (id),
  CONSTRAINT treasury_transactions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);
CREATE TABLE public.user_project_access (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid NOT NULL,
  role text NOT NULL CHECK (role = ANY (ARRAY['owner'::text, 'admin'::text, 'viewer'::text])),
  created_at timestamp with time zone DEFAULT now(),
  wallet_address text,
  CONSTRAINT user_project_access_pkey PRIMARY KEY (id),
  CONSTRAINT user_project_access_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);
CREATE TABLE public.vault_access_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid,
  accessed_at timestamp with time zone DEFAULT now(),
  access_type text CHECK (access_type = ANY (ARRAY['create'::text, 'retrieve'::text, 'delete'::text, 'rotate'::text])),
  success boolean NOT NULL,
  error_message text,
  ip_address text,
  user_agent text,
  CONSTRAINT vault_access_log_pkey PRIMARY KEY (id),
  CONSTRAINT vault_access_log_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);
CREATE TABLE public.vault_keys (
  project_id uuid NOT NULL,
  private_key_encrypted text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  last_accessed timestamp with time zone,
  access_count integer DEFAULT 0,
  created_by text,
  rotation_history jsonb DEFAULT '[]'::jsonb,
  CONSTRAINT vault_keys_pkey PRIMARY KEY (project_id),
  CONSTRAINT vault_keys_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);
CREATE TABLE public.vesting_streams (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name text NOT NULL,
  description text,
  nft_requirements jsonb NOT NULL,
  tier_allocations jsonb NOT NULL,
  total_pool_amount numeric NOT NULL,
  vesting_duration_days integer NOT NULL,
  cliff_duration_days integer NOT NULL,
  grace_period_days integer NOT NULL DEFAULT 30,
  streamflow_stream_id text UNIQUE,
  vesting_mode text DEFAULT 'snapshot'::text CHECK (vesting_mode = ANY (ARRAY['snapshot'::text, 'dynamic'::text, 'manual'::text])),
  is_active boolean DEFAULT true,
  require_nft_on_claim boolean DEFAULT true,
  start_time timestamp with time zone,
  end_time timestamp with time zone,
  snapshot_date timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  cliff_duration_seconds bigint NOT NULL DEFAULT 0,
  vesting_duration_seconds bigint NOT NULL DEFAULT 2592000,
  snapshot_taken boolean DEFAULT false,
  project_id uuid,
  pool_type text NOT NULL DEFAULT 'SNAPSHOT'::text CHECK (pool_type = ANY (ARRAY['SNAPSHOT'::text, 'DYNAMIC'::text, 'MANUAL'::text])),
  state text DEFAULT 'active'::text CHECK (state = ANY (ARRAY['active'::text, 'paused'::text, 'cancelled'::text])),
  snapshot_config_id uuid,
  dynamic_rule_set jsonb,
  manual_upload_id uuid,
  token_mint text,
  claim_fee_lamports bigint DEFAULT 1000000,
  custom_fee numeric DEFAULT 0 CHECK (custom_fee >= 0::numeric AND custom_fee <= 100::numeric),
  creation_fee_paid numeric DEFAULT 0,
  creation_fee_tx character varying,
  CONSTRAINT vesting_streams_pkey PRIMARY KEY (id),
  CONSTRAINT vesting_streams_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id),
  CONSTRAINT vesting_streams_manual_upload_id_fkey FOREIGN KEY (manual_upload_id) REFERENCES public.manual_uploads(id)
);
CREATE TABLE public.vestings (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  vesting_stream_id uuid,
  user_wallet text NOT NULL,
  nft_count integer NOT NULL DEFAULT 0 CHECK (nft_count >= 0),
  tier integer NOT NULL,
  streamflow_stream_id text,
  token_amount numeric NOT NULL CHECK (token_amount > 0::numeric),
  share_percentage numeric,
  is_active boolean DEFAULT true,
  is_cancelled boolean DEFAULT false,
  last_verified timestamp with time zone DEFAULT now(),
  vesting_mode text DEFAULT 'snapshot'::text,
  snapshot_locked boolean DEFAULT false,
  claim_verification_enabled boolean DEFAULT true,
  grace_period_end timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  cancelled_at timestamp with time zone,
  cancellation_reason text,
  project_id uuid,
  is_dynamic boolean DEFAULT false,
  last_eligibility_check timestamp with time zone,
  is_eligible boolean DEFAULT true,
  allocation_type text CHECK (allocation_type = ANY (ARRAY['percentage'::text, 'fixed'::text])),
  allocation_value numeric,
  original_percentage numeric,
  CONSTRAINT vestings_pkey PRIMARY KEY (id),
  CONSTRAINT vestings_vesting_stream_id_fkey FOREIGN KEY (vesting_stream_id) REFERENCES public.vesting_streams(id),
  CONSTRAINT vestings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id)
);