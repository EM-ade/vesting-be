/**
 * Calculate locked tokens across all active pools for a project
 * @param projectId - Project ID
 * @param supabase - Supabase client
 * @returns Total locked tokens
 */
export async function calculateLockedTokens(projectId: string, supabase: any): Promise<number> {
    // Get all active pools for this project
    const { data: pools, error: poolsError } = await supabase
        .from('vesting_streams')
        .select('id, total_pool_amount')
        .eq('project_id', projectId)
        .eq('is_active', true);

    if (poolsError) {
        throw new Error(`Failed to fetch pools: ${poolsError.message}`);
    }

    if (!pools || pools.length === 0) {
        return 0;
    }

    // Sum up all pool amounts
    const totalLocked = pools.reduce((sum: number, pool: any) => {
        return sum + Number(pool.total_pool_amount);
    }, 0);

    return totalLocked;
}

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
        .from('projects')
        .select('vault_public_key, vault_balance_token')
        .eq('id', projectId)
        .single();

    if (projectError || !project) {
        throw new Error('Project not found');
    }

    // Calculate locked tokens
    const lockedInPools = await calculateLockedTokens(projectId, supabase);

    // Get actual on-chain balance
    const { PublicKey } = await import('@solana/web3.js');
    const { getAssociatedTokenAddress, getAccount } = await import('@solana/spl-token');

    const vaultPubkey = new PublicKey(project.vault_public_key);
    const mintPubkey = new PublicKey(tokenMint);
    const tokenAccount = await getAssociatedTokenAddress(mintPubkey, vaultPubkey);

    let totalBalance = 0;
    try {
        const accountInfo = await getAccount(connection, tokenAccount);
        totalBalance = Number(accountInfo.amount) / Math.pow(10, 9); // Assuming 9 decimals
    } catch (err) {
        // Token account doesn't exist or has 0 balance
        totalBalance = 0;
    }

    const available = Math.max(0, totalBalance - lockedInPools);

    return {
        totalBalance,
        lockedInPools,
        available,
        vaultAddress: project.vault_public_key,
    };
}
