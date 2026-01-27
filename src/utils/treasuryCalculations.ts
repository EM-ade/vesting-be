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
  // DO NOT hardcode decimals - fetch from mint for accurate calculations

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

  // Get decimals for each unique token mint in pools
  const uniqueMints: string[] = [...new Set(pools.map((p: any) => p.token_mint).filter((m: any) => m && typeof m === 'string') as string[])];
  const decimalsByMint = new Map<string, number>();
  
  // Import dependencies dynamically to avoid circular dependencies
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const { getMint } = await import("@solana/spl-token");
  const configModule = await import("../config");
  
  // Get RPC connection (use global config)
  const rpcConfig = configModule.getRPCConfig();
  const connection = new Connection(rpcConfig.getRPCEndpoint(), 'confirmed');
  
  // Fetch decimals for each unique mint
  for (const mint of uniqueMints) {
    try {
      const mintPubkey = new PublicKey(mint);
      const mintInfo = await getMint(connection, mintPubkey);
      decimalsByMint.set(mint, mintInfo.decimals);
      console.log(`[LOCKED-TOKENS] Mint ${mint} has ${mintInfo.decimals} decimals`);
    } catch (err) {
      console.warn(`[LOCKED-TOKENS] Failed to get decimals for ${mint}, using default 9:`, err);
      decimalsByMint.set(mint, 9);
    }
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

    // Get decimals for this pool's token mint
    const poolDecimals = decimalsByMint.get(pool.token_mint) || 9;
    const poolDivisor = Math.pow(10, poolDecimals);

    // Calculate total claimed for this pool
    let poolClaimedRaw = 0;
    const poolVestingIds = vestingsByPool.get(pool.id) || [];

    for (const vid of poolVestingIds) {
      poolClaimedRaw += claimsByVesting.get(vid) || 0;
    }

    const poolClaimed = poolClaimedRaw / poolDivisor;

    // Locked = Total Capacity - Total Claimed
    // This ensures unallocated tokens in active pools are still treated as locked
    const poolLocked = Math.max(0, poolTotal - poolClaimed);
    totalLocked += poolLocked;
    
    console.log(`[LOCKED-TOKENS] Pool ${pool.id}: ${poolLocked} tokens locked (${poolDecimals} decimals)`);
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

  // Normalize token mint for comparison (handle both string and PublicKey)
  const tokenMintStr = typeof tokenMint === 'string' ? tokenMint : (tokenMint as any).toString();
  const isNativeSOL = tokenMintStr === NATIVE_SOL_MINT;

  console.log(`[TREASURY] calculateAvailableBalance called with tokenMint: "${tokenMintStr}", isNativeSOL: ${isNativeSOL}`);

  // ✅ FIX: Handle native SOL differently from SPL tokens
  if (isNativeSOL) {
    // Native SOL: Use getBalance() directly on the wallet address
    // Native SOL doesn't have a token account - balance is stored as lamports in the wallet
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
    } catch (err: any) {
      // Token account doesn't exist or has 0 balance - this is expected for unfunded accounts
      // Check for TokenAccountNotFoundError by name or message content
      const isTokenAccountNotFound = 
        err?.name === 'TokenAccountNotFoundError' || 
        err?.constructor?.name === 'TokenAccountNotFoundError' ||
        err?.message?.includes('could not find account') ||
        err?.message?.includes('TokenAccountNotFoundError');
      
      if (isTokenAccountNotFound) {
        console.log(`[TREASURY] Token account not found for ${tokenMint} - balance is 0 (this is normal for unfunded accounts)`);
      } else {
        console.warn(`[TREASURY] Could not fetch balance for ${tokenMint}:`, err);
      }
      totalBalance = 0;
    }
  }

  // Calculate available with floating-point precision handling
  const rawAvailable = totalBalance - lockedInPools;
  
  // Use epsilon tolerance for floating-point comparison (1e-9 = 0.000000001)
  // This handles cases like 0.0009999999999763531 which should be 0.001
  const EPSILON = 1e-9;
  
  // Round to 9 decimal places to avoid floating-point precision issues
  // SOL has 9 decimal places (lamports), so this is the maximum precision we need
  const available = Math.max(0, Math.round(rawAvailable * 1e9) / 1e9);
  
  console.log(`[TREASURY] Available calculation: totalBalance=${totalBalance}, lockedInPools=${lockedInPools}, rawAvailable=${rawAvailable}, rounded=${available}`);

  return {
    totalBalance: Math.round(totalBalance * 1e9) / 1e9,
    lockedInPools: Math.round(lockedInPools * 1e9) / 1e9,
    available,
    vaultAddress: project.vault_public_key,
  };
}
