/**
 * Calculate locked tokens across all active pools for a project (excluding claimed amounts)
 * @param projectId - Project ID
 * @param tokenMint - Optional token mint to filter by
 * @param supabase - Supabase client
 * @returns Total locked tokens (allocated - claimed)
 */
export async function calculateLockedTokens(
  projectId: string,
  supabase: any,
  tokenMint?: string
): Promise<number> {
  const TOKEN_DECIMALS = 9;
  const TOKEN_DIVISOR = Math.pow(10, TOKEN_DECIMALS);

  // Get all active pools for this project (includes PAUSED, excludes CANCELLED)
  let poolsQuery = supabase
    .from("vesting_streams")
    .select("id, total_pool_amount, token_mint")
    .eq("project_id", projectId)
    .eq("is_active", true);

  // Filter by token mint if provided
  if (tokenMint) {
    poolsQuery = poolsQuery.eq("token_mint", tokenMint);
  }

  const { data: pools, error: poolsError } = await poolsQuery;

  if (poolsError) {
    throw new Error(`Failed to fetch pools: ${poolsError.message}`);
  }

  if (!pools || pools.length === 0) {
    return 0;
  }

  // Optimization: Batch fetch vestings and claims to avoid N+1 queries
  const poolIds = pools.map((p: any) => p.id);

  // 1. Get all vestings for these pools
  const { data: vestings } = await supabase
    .from("vestings")
    .select("id, vesting_stream_id")
    .in("vesting_stream_id", poolIds);

  const vestingIds = vestings?.map((v: any) => v.id) || [];
  const vestingsByPool = new Map<string, string[]>(); // poolId -> vestingIds[]

  vestings?.forEach((v: any) => {
    const current = vestingsByPool.get(v.vesting_stream_id) || [];
    current.push(v.id);
    vestingsByPool.set(v.vesting_stream_id, current);
  });

  // 2. Get all claims for these vestings
  let allClaims: any[] = [];
  if (vestingIds.length > 0) {
    // Fetch in chunks if too many vestings (though standard limits apply)
    const { data: claims } = await supabase
      .from("claim_history")
      .select("amount_claimed, vesting_id")
      .in("vesting_id", vestingIds);
    allClaims = claims || [];
  }

  // Map claims to vesting IDs for quick lookup/summing
  const claimsByVesting = new Map<string, number>();
  allClaims.forEach((c: any) => {
    const current = claimsByVesting.get(c.vesting_id) || 0;
    claimsByVesting.set(c.vesting_id, current + Number(c.amount_claimed));
  });

  let totalLocked = 0;

  for (const pool of pools) {
    // USE TOTAL POOL AMOUNT (Reserve full capacity, including unallocated)
    const poolTotal = pool.total_pool_amount;

    // Calculate total claimed for this pool
    let poolClaimedRaw = 0;
    const poolVestingIds = vestingsByPool.get(pool.id) || [];

    for (const vid of poolVestingIds) {
      poolClaimedRaw += claimsByVesting.get(vid) || 0;
    }

    const poolClaimed = poolClaimedRaw / TOKEN_DIVISOR;

    // Locked = Total Capacity - Total Claimed
    // This ensures unallocated tokens in active pools are still treated as locked
    totalLocked += Math.max(0, poolTotal - poolClaimed);
  }

  return totalLocked;
}

/**
 * Native SOL mint address constant
 */
const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Calculate available tokens for withdrawal
 * @param projectId - Project ID
 * @param tokenMint - Token mint address
 * @param supabase - Supabase client
 * @param connection - Solana connection
 * @returns Available balance info
 */
export async function calculateAvailableBalance(
  projectId: string,
  tokenMint: string,
  supabase: any,
  connection: any
): Promise<{
  totalBalance: number;
  lockedInPools: number;
  available: number;
  vaultAddress: string;
}> {
  // Get project vault info
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("vault_public_key, vault_balance_token")
    .eq("id", projectId)
    .single();

  if (projectError || !project) {
    throw new Error("Project not found");
  }

  // Calculate locked tokens for this specific token
  const lockedInPools = await calculateLockedTokens(
    projectId,
    supabase,
    tokenMint
  );

  // Get actual on-chain balance
  const { PublicKey, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
  const vaultPubkey = new PublicKey(project.vault_public_key);

  let totalBalance = 0;

  // ✅ FIX: Handle native SOL differently from SPL tokens
  if (tokenMint === NATIVE_SOL_MINT) {
    // Native SOL: Use getBalance() directly on the wallet address
    try {
      const lamports = await connection.getBalance(vaultPubkey);
      totalBalance = lamports / LAMPORTS_PER_SOL;
      console.log(`[TREASURY] Native SOL balance: ${totalBalance} SOL (${lamports} lamports)`);
    } catch (err) {
      console.warn(`[TREASURY] Could not fetch SOL balance:`, err);
      totalBalance = 0;
    }
  } else {
    // SPL Token: Use token account
    const { getAssociatedTokenAddress, getAccount } = await import(
      "@solana/spl-token"
    );

    const mintPubkey = new PublicKey(tokenMint);
    const tokenAccount = await getAssociatedTokenAddress(mintPubkey, vaultPubkey);

    try {
      const accountInfo = await getAccount(connection, tokenAccount);
      
      // Get actual token decimals from the mint instead of assuming 9
      const { getMint } = await import("@solana/spl-token");
      const mintInfo = await getMint(connection, mintPubkey);
      const decimals = mintInfo.decimals;
      
      totalBalance = Number(accountInfo.amount) / Math.pow(10, decimals);
      console.log(`[TREASURY] Token ${tokenMint} balance: ${totalBalance} (${decimals} decimals)`);
    } catch (err) {
      // Token account doesn't exist or has 0 balance
      console.warn(`[TREASURY] Could not fetch balance for ${tokenMint}:`, err);
      totalBalance = 0;
    }
  }

  const available = Math.max(0, totalBalance - lockedInPools);

  return {
    totalBalance,
    lockedInPools,
    available,
    vaultAddress: project.vault_public_key,
  };
}
