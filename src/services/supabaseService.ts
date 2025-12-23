import { PublicKey } from "@solana/web3.js";

/**
 * Supabase Service
 *
 * This is a TypeScript interface for the Supabase database.
 * Install: npm install @supabase/supabase-js
 *
 * Usage:
 * import { createClient } from '@supabase/supabase-js';
 * import { SupabaseService } from './services/supabaseService';
 *
 * const supabase = createClient(
 *   process.env.SUPABASE_URL!,
 *   process.env.SUPABASE_SERVICE_ROLE_KEY!
 * );
 *
 * const dbService = new SupabaseService(supabase);
 */

// Database types
export interface DatabaseConfig {
  id: number;
  admin_wallet: string;
  token_mint: string;
  nft_threshold?: number;
  total_vesting_amount?: number;
  vesting_start_time?: string;
  vesting_cliff_time?: string;
  vesting_end_time?: string;
  fee_wallet?: string;
  claim_fee_sol: number;
  claim_fee_usd?: number;
  vesting_mode?: string;
  snapshot_date?: string;
  allow_mode_switch?: boolean;
  grace_period_days?: number;
  require_nft_on_claim?: boolean;
  cooldown_days?: number;
  enable_claims?: boolean;
  created_at: string;
  updated_at: string;
}

export interface DatabaseVesting {
  id: string;
  vesting_stream_id?: string;
  user_wallet: string;
  nft_count: number;
  tier?: number;
  streamflow_stream_id: string | null;
  token_amount: number;
  share_percentage?: number;
  is_active: boolean;
  is_cancelled: boolean;
  last_verified: string;
  created_at: string;
  cancelled_at: string | null;
  vesting_mode?: string;
  snapshot_locked?: boolean;
  claim_verification_enabled?: boolean;
  grace_period_end?: string;
  cancellation_reason?: string;
}

export interface DatabaseClaimHistory {
  id: string;
  user_wallet: string;
  vesting_id: string;
  project_id: string;
  amount_claimed: number;
  fee_paid: number;
  transaction_signature: string;
  claimed_at: string;
}

export interface DatabaseAdminLog {
  id: string;
  action: string;
  admin_wallet: string;
  target_wallet: string | null;
  details: any;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface CreateVestingInput {
  vesting_stream_id?: string | number;
  user_wallet: string;
  nft_count: number;
  tier?: number;
  streamflow_stream_id?: string;
  token_amount: number;
  vesting_mode?: string;
  snapshot_locked?: boolean;
  claim_verification_enabled?: boolean;
  grace_period_end?: string;
}

export interface UpdateVestingInput {
  nft_count?: number;
  is_active?: boolean;
  is_cancelled?: boolean;
  last_verified?: string;
  cancelled_at?: string;
  token_amount?: number;
  tier?: number;
  vesting_mode?: string;
  snapshot_locked?: boolean;
  claim_verification_enabled?: boolean;
  grace_period_end?: string;
  cancellation_reason?: string;
}

export interface CreateClaimInput {
  user_wallet: string;
  vesting_id: string;
  project_id: string;
  amount_claimed: number;
  fee_paid: number;
  transaction_signature: string;
}

export interface LogAdminActionInput {
  action: string;
  admin_wallet: string;
  target_wallet?: string;
  details?: any;
  ip_address?: string;
  user_agent?: string;
}

/**
 * Supabase Service Class
 *
 * Note: This is a template. You need to install @supabase/supabase-js
 * and pass a Supabase client instance to use this service.
 */
export class SupabaseService {
  public supabase: any; // Replace with SupabaseClient type when installed

  constructor(supabaseClient: any) {
    this.supabase = supabaseClient;
  }

  /**
   * Retry wrapper for Supabase operations
   * Handles intermittent network/connection issues
   */
  private async retryOperation<T>(
    operation: () => Promise<{ data: T; error: any }>,
    maxRetries = 3,
    delayMs = 1000
  ): Promise<{ data: T; error: any }> {
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await operation();

        // If successful or non-retryable error, return immediately
        if (!result.error || !this.isRetryableError(result.error)) {
          return result;
        }

        lastError = result.error;
        console.warn(
          `Supabase operation failed (attempt ${attempt}/${maxRetries}):`,
          result.error.message
        );

        // Wait before retrying (exponential backoff)
        if (attempt < maxRetries) {
          await new Promise((resolve) =>
            setTimeout(resolve, delayMs * attempt)
          );
        }
      } catch (err) {
        lastError = err;
        console.warn(
          `Supabase operation threw error (attempt ${attempt}/${maxRetries}):`,
          err
        );

        if (attempt < maxRetries) {
          await new Promise((resolve) =>
            setTimeout(resolve, delayMs * attempt)
          );
        }
      }
    }

    // All retries failed
    return { data: null as any, error: lastError };
  }

  /**
   * Check if error is retryable (network/connection issues)
   */
  private isRetryableError(error: any): boolean {
    if (!error) return false;

    const retryableMessages = [
      "fetch failed",
      "network",
      "timeout",
      "ECONNREFUSED",
      "ENOTFOUND",
      "ETIMEDOUT",
      "EAI_AGAIN",
    ];

    const errorMessage = error.message?.toLowerCase() || "";
    return retryableMessages.some((msg) =>
      errorMessage.includes(msg.toLowerCase())
    );
  }

  // Config operations
  async getConfig(): Promise<DatabaseConfig | null> {
    const result = await this.retryOperation<DatabaseConfig>(() =>
      this.supabase.from("config").select("*").single()
    );

    if (result.error) {
      console.error("Failed to get config after retries:", result.error);
      throw result.error;
    }

    return result.data as DatabaseConfig | null;
  }

  async updateConfig(config: Partial<DatabaseConfig>): Promise<void> {
    const { error } = await this.supabase
      .from("config")
      .update(config)
      .eq("id", 1);

    if (error) throw error;
  }

  // Vesting operations
  async getVesting(userWallet: string): Promise<DatabaseVesting | null> {
    // Get the most recent active vesting for this wallet
    const { data, error } = await this.supabase
      .from("vestings")
      .select("*")
      .eq("user_wallet", userWallet)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) throw error;
    return data && data.length > 0 ? data[0] : null;
  }

  async getVestingForPool(
    userWallet: string,
    poolId: string
  ): Promise<DatabaseVesting | null> {
    const { data, error } = await this.supabase
      .from("vestings")
      .select("*")
      .eq("user_wallet", userWallet)
      .eq("vesting_stream_id", poolId)
      .single();

    if (error && error.code !== "PGRST116") throw error;
    return data;
  }

  async createVesting(input: CreateVestingInput): Promise<DatabaseVesting> {
    const { data, error } = await this.supabase
      .from("vestings")
      .insert(input)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async updateVesting(
    userWallet: string,
    updates: UpdateVestingInput
  ): Promise<void> {
    const { error } = await this.supabase
      .from("vestings")
      .update(updates)
      .eq("user_wallet", userWallet);

    if (error) throw error;
  }

  async getAllVestings(): Promise<DatabaseVesting[]> {
    const { data, error } = await this.supabase
      .from("vestings")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;
    return data || [];
  }

  async getActiveVestings(): Promise<DatabaseVesting[]> {
    const { data, error } = await this.supabase
      .from("vestings")
      .select("*")
      .eq("is_active", true)
      .eq("is_cancelled", false)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return data || [];
  }

  async getVestingsByStreamId(
    streamId: string
  ): Promise<DatabaseVesting | null> {
    const { data, error } = await this.supabase
      .from("vestings")
      .select("*")
      .eq("streamflow_stream_id", streamId)
      .single();

    if (error && error.code !== "PGRST116") throw error;
    return data;
  }

  // Claim history operations
  async createClaim(input: CreateClaimInput): Promise<DatabaseClaimHistory> {
    const { data, error } = await this.supabase
      .from("claim_history")
      .insert(input)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async getClaimHistory(userWallet: string): Promise<DatabaseClaimHistory[]> {
    const { data, error } = await this.supabase
      .from("claim_history")
      .select("*")
      .eq("user_wallet", userWallet)
      .order("claimed_at", { ascending: false });

    if (error) throw error;
    return data || [];
  }

  async getAllClaimHistory(): Promise<DatabaseClaimHistory[]> {
    const { data, error } = await this.supabase
      .from("claim_history")
      .select("*")
      .order("claimed_at", { ascending: false });

    if (error) throw error;
    return data || [];
  }

  // Admin log operations
  async logAdminAction(input: LogAdminActionInput): Promise<void> {
    const { error } = await this.supabase.from("admin_logs").insert(input);

    if (error) throw error;
  }

  async getAdminLogs(limit: number = 100): Promise<DatabaseAdminLog[]> {
    const { data, error } = await this.supabase
      .from("admin_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }

  // Helper functions
  async getUserVestingInfo(userWallet: string) {
    const { data, error } = await this.supabase.rpc("get_user_vesting", {
      wallet_address: userWallet,
    });

    if (error) throw error;
    return data;
  }

  async getStats() {
    const [activeCount, totalVested, totalClaimed] = await Promise.all([
      this.supabase.rpc("get_active_vestings_count"),
      this.supabase.rpc("get_total_tokens_vested"),
      this.supabase.rpc("get_total_tokens_claimed"),
    ]);

    return {
      activeVestings: activeCount.data || 0,
      totalTokensVested: totalVested.data || 0,
      totalTokensClaimed: totalClaimed.data || 0,
    };
  }

  // Batch operations
  async batchCreateVestings(
    vestings: CreateVestingInput[]
  ): Promise<DatabaseVesting[]> {
    const { data, error } = await this.supabase
      .from("vestings")
      .insert(vestings)
      .select();

    if (error) throw error;
    return data || [];
  }

  async batchUpdateVestings(
    updates: Array<{ user_wallet: string; updates: UpdateVestingInput }>
  ): Promise<void> {
    // Supabase doesn't support batch updates directly, so we do them sequentially
    for (const { user_wallet, updates: vestingUpdates } of updates) {
      await this.updateVesting(user_wallet, vestingUpdates);
    }
  }

  // Pool management operations
  async getPoolMembers(poolId: string): Promise<DatabaseVesting[]> {
    const { data, error } = await this.supabase
      .from("vestings")
      .select("*")
      .eq("vesting_stream_id", poolId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return data || [];
  }

  async updatePoolMember(
    poolId: string,
    userWallet: string,
    updates: UpdateVestingInput
  ): Promise<void> {
    const { error } = await this.supabase
      .from("vestings")
      .update(updates)
      .eq("vesting_stream_id", poolId)
      .eq("user_wallet", userWallet);

    if (error) throw error;
  }

  async removePoolMember(poolId: string, userWallet: string): Promise<void> {
    const { error } = await this.supabase
      .from("vestings")
      .update({
        is_active: false,
        is_cancelled: true,
        cancellation_reason: "Removed by admin",
      })
      .eq("vesting_stream_id", poolId)
      .eq("user_wallet", userWallet);

    if (error) throw error;
  }

  // Pool state management operations
  async getPoolState(poolId: string): Promise<{ state: string }> {
    const { data, error } = await this.supabase
      .from("vesting_streams")
      .select("state")
      .eq("id", poolId)
      .single();

    if (error) throw error;
    return data || { state: "active" };
  }

  async updatePoolState(poolId: string, state: string): Promise<void> {
    const { error } = await this.supabase
      .from("vesting_streams")
      .update({ state })
      .eq("id", poolId);

    if (error) throw error;
  }
}
