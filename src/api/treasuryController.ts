import { Request, Response } from "express";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import bs58 from "bs58";
import { SupabaseService } from "../services/supabaseService";
import { config } from "../config";
import { getSupabaseClient } from "../lib/supabaseClient";

/**
 * Treasury Management API Controller
 * Monitors treasury wallet balance vs allocated/claimed amounts
 */
export class TreasuryController {
  private dbService: SupabaseService;
  private connection: Connection;

  constructor() {
    const supabaseClient = getSupabaseClient();
    this.dbService = new SupabaseService(supabaseClient);
    this.connection = new Connection(config.rpcEndpoint, "confirmed");
  }

  /**
   * GET /api/treasury/status
   * Get treasury wallet status and allocation tracking with comprehensive metrics
   */
  async getTreasuryStatus(req: Request, res: Response) {
    try {
      // 1. Determine Treasury Public Key and Token Mint
      let treasuryPublicKey: PublicKey;
      let tokenMint: PublicKey;

      // Check for project context first
      const projectId = req.projectId || (req.query.projectId as string);
      const poolId = req.query.poolId as string;
      const poolIds = req.query.poolIds as string;

      // Store project data for later use
      let projectData: {
        vault_public_key: string;
        mint_address?: string;
        symbol?: string;
      } | null = null;

      if (projectId) {
        // Multi-project mode: Fetch from database
        try {
          const { data: project, error } = await this.dbService.supabase
            .from("projects")
            .select("vault_public_key, mint_address, symbol")
            .eq("id", projectId)
            .single();

          if (error || !project) {
            console.warn(
              `Project ${projectId} not found, falling back to legacy config`
            );
            throw new Error("Project not found");
          }

          if (!project.vault_public_key) {
            // This happens if vault generation failed or is pending - return empty data instead of error
            console.warn(`Project ${projectId} vault not generated yet - returning empty treasury status`);
            return res.json({
              success: true,
              data: {
                currentBalance: 0,
                totalClaimed: 0,
                claimCount: 0,
                averageClaimSize: 0,
                recentClaims: [],
              },
              treasury: { address: "", balance: 0, tokenMint: "" },
              allocations: {
                totalAllocated: 0,
                totalClaimed: 0,
                remainingNeeded: 0,
              },
              status: {
                health: "pending_setup",
                buffer: 0,
                bufferPercentage: 0,
                sufficientFunds: true,
              },
              streamflow: { deployed: false, poolBalance: 0 },
              recommendations: ["Project vault is being set up. Please check back shortly."],
            });
          }

          projectData = project;
          treasuryPublicKey = new PublicKey(project.vault_public_key);
          tokenMint = project.mint_address
            ? new PublicKey(project.mint_address)
            : new PublicKey(config.customTokenMint!);
        } catch (err) {
          // If project lookup fails, we can't proceed for this request if it was meant to be project-scoped
          console.error("Failed to get project vault:", err);
          return res
            .status(500)
            .json({ error: "Failed to access project vault" });
        }
      } else {
        // Legacy mode: Use env config
        // This path is only for backward compatibility or "platform admin" view
        try {
          if (config.treasuryPrivateKey.startsWith("[")) {
            const secretKey = Uint8Array.from(
              JSON.parse(config.treasuryPrivateKey)
            );
            const keypair = Keypair.fromSecretKey(secretKey);
            treasuryPublicKey = keypair.publicKey;
          } else {
            const decoded = bs58.decode(config.treasuryPrivateKey);
            const keypair = Keypair.fromSecretKey(decoded);
            treasuryPublicKey = keypair.publicKey;
          }
          tokenMint = new PublicKey(config.customTokenMint!);
        } catch (err) {
          console.error("Failed to parse legacy treasury key:", err);
          // If no key configured, return placeholder for platform admin view (not an error)
          if (!config.treasuryPrivateKey || config.treasuryPrivateKey === '') {
            // Just return empty status if no global treasury configured
            return res.json({
              success: true,
              data: {
                currentBalance: 0,
                totalClaimed: 0,
                claimCount: 0,
                averageClaimSize: 0,
                recentClaims: [],
              },
              treasury: { address: "", balance: 0, tokenMint: "" },
              allocations: {
                totalAllocated: 0,
                totalClaimed: 0,
                remainingNeeded: 0,
              },
              status: {
                health: "healthy",
                buffer: 0,
                bufferPercentage: 0,
                sufficientFunds: true,
              },
              streamflow: { deployed: false, poolBalance: 0 },
              recommendations: [],
            });
          }
          // Only return error if key exists but is malformed
          console.warn("Treasury key exists but is malformed - this is expected in project-scoped mode");
          return res.json({
            success: true,
            data: {
              currentBalance: 0,
              totalClaimed: 0,
              claimCount: 0,
              averageClaimSize: 0,
              recentClaims: [],
            },
            treasury: { address: "", balance: 0, tokenMint: "" },
            allocations: {
              totalAllocated: 0,
              totalClaimed: 0,
              remainingNeeded: 0,
            },
            status: {
              health: "healthy",
              buffer: 0,
              bufferPercentage: 0,
              sufficientFunds: true,
            },
            streamflow: { deployed: false, poolBalance: 0 },
            recommendations: [],
          });
        }
      }

      // Get treasury token balance
      const treasuryTokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        treasuryPublicKey
      );

      let treasuryBalance = 0;
      const TOKEN_DECIMALS = 9;
      const TOKEN_DIVISOR = Math.pow(10, TOKEN_DECIMALS);

      try {
        const accountInfo = await getAccount(
          this.connection,
          treasuryTokenAccount
        );
        // Convert from base units to human-readable tokens
        treasuryBalance = Number(accountInfo.amount) / TOKEN_DIVISOR;
      } catch (err) {
        // Token account doesn't exist yet
        treasuryBalance = 0;
      }

      // Get SOL balance
      const solBalance =
        (await this.connection.getBalance(treasuryPublicKey)) / 1e9; // Convert lamports to SOL

      // Get all token accounts for this treasury wallet
      let tokens: { symbol: string; balance: number; mint: string }[] = [];

      // Add SOL first
      tokens.push({
        symbol: "SOL",
        balance: solBalance,
        mint: "So11111111111111111111111111111111111111112",
      });

      try {
        const tokenAccounts =
          await this.connection.getParsedTokenAccountsByOwner(
            treasuryPublicKey,
            {
              programId: new PublicKey(
                "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
              ), // SPL Token Program
            }
          );

        const spl_tokens = tokenAccounts.value
          .map((accountInfo) => {
            const parsedInfo = accountInfo.account.data.parsed.info;
            const mintAddress = parsedInfo.mint;
            const amount = parsedInfo.tokenAmount.uiAmount;

            // Determine symbol
            let symbol = "Unknown";

            // Check against project token mint
            if (mintAddress === tokenMint.toBase58()) {
              // Use project symbol if available
              symbol = projectData?.symbol || "Token";
            } else if (
              mintAddress === "So11111111111111111111111111111111111111112"
            ) {
              symbol = "SOL";
            } else if (
              mintAddress === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
            ) {
              symbol = "USDC";
            }

            return {
              symbol,
              balance: amount,
              mint: mintAddress,
            };
          })
          .filter((t) => t.balance > 0);

        // Add SPL tokens to the list
        tokens = [...tokens, ...spl_tokens];
      } catch (err) {
        console.warn("Failed to fetch SPL token accounts for treasury:", err);
      }

      // Get total allocated from database (Scoped to project if applicable)
      // GROUP BY token_mint for multi-token support
      let vestingQuery = this.dbService.supabase
        .from("vesting_streams")
        .select("total_pool_amount, token_mint")
        .eq("is_active", true);

      if (projectId) {
        vestingQuery = vestingQuery.eq("project_id", projectId);
      }
      if (poolId && poolId !== "all") {
        vestingQuery = vestingQuery.eq("id", poolId);
      } else if (poolIds && poolIds !== "") {
        const ids = poolIds.split(",").filter(Boolean);
        if (ids.length > 0) {
          vestingQuery = vestingQuery.in("id", ids);
        }
      }

      const { data: activeStreams } = await vestingQuery;

      // Group allocations by token_mint
      const allocationsByToken = new Map<string, number>();
      activeStreams?.forEach((s: any) => {
        const mint = s.token_mint || tokenMint.toBase58();
        const current = allocationsByToken.get(mint) || 0;
        allocationsByToken.set(mint, current + s.total_pool_amount);
      });

      // Sum total_pool_amount from all active streams (for backward compatibility)
      const totalAllocated =
        activeStreams?.reduce(
          (sum: number, s: any) => sum + s.total_pool_amount,
          0
        ) || 0;

      // Get total claimed with proper decimal conversion (FIX: use claim_history table)
      let claimsQuery = this.dbService.supabase
        .from("claim_history")
        .select(
          "amount_claimed, claimed_at, transaction_signature, user_wallet, vesting_id"
        )
        .order("claimed_at", { ascending: false });

      if (projectId) {
        claimsQuery = claimsQuery.eq("project_id", projectId);
      }

      // If filtering by pool, we need to filter claims that belong to vestings in this pool
      if ((poolId && poolId !== "all") || (poolIds && poolIds !== "")) {
        // First get all vesting IDs for these pools
        let vestingsQuery = this.dbService.supabase
          .from("vestings")
          .select("id");

        if (poolId && poolId !== "all") {
          vestingsQuery = vestingsQuery.eq("vesting_stream_id", poolId);
        } else if (poolIds) {
          const ids = poolIds.split(",").filter(Boolean);
          if (ids.length > 0) {
            vestingsQuery = vestingsQuery.in("vesting_stream_id", ids);
          }
        }

        const { data: poolVestings } = await vestingsQuery;

        const vestingIds = poolVestings?.map((v: { id: string }) => v.id) || [];

        if (vestingIds.length > 0) {
          claimsQuery = claimsQuery.in("vesting_id", vestingIds);
        } else {
          claimsQuery = claimsQuery.in("vesting_id", [-1]); // Safe fallback
        }
      }

      const { data: claims } = await claimsQuery;

      // OPTIMIZATION: Batch fetch vestings to avoid N+1 queries
      const uniqueVestingIds = [
        ...new Set(claims?.map((c: any) => c.vesting_id)),
      ] as string[];
      const vestingsMap = new Map<string, string>(); // vesting_id -> token_mint

      if (uniqueVestingIds.length > 0) {
        // Fetch vestings with their stream info
        // Process in chunks if necessary, but 1000s usually fine for Postgres
        const { data: vestingsInfo } = await this.dbService.supabase
          .from("vestings")
          .select("id, vesting_stream_id, vesting_streams(token_mint)")
          .in("id", uniqueVestingIds);

        vestingsInfo?.forEach((v: any) => {
          if (v.vesting_streams) {
            const mint = (v.vesting_streams as any).token_mint;
            if (mint) {
              vestingsMap.set(v.id, mint);
            }
          }
        });
      }

      // Group claims by token_mint
      const claimsByToken = new Map<string, number>();

      for (const claim of claims || []) {
        const mint = vestingsMap.get(claim.vesting_id) || tokenMint.toBase58();
        const current = claimsByToken.get(mint) || 0;
        claimsByToken.set(
          mint,
          current + Number(claim.amount_claimed) / TOKEN_DIVISOR
        );
      }

      const totalClaimedRaw =
        claims?.reduce(
          (sum: number, c: any) => sum + Number(c.amount_claimed),
          0
        ) || 0;
      // FIX: Divide by TOKEN_DIVISOR to convert from base units to human-readable tokens
      const totalClaimed = totalClaimedRaw / TOKEN_DIVISOR;

      // Calculate claim metrics
      const claimCount = claims?.length || 0;
      const averageClaimSize = claimCount > 0 ? totalClaimed / claimCount : 0;

      // Get 10 most recent claims
      const recentClaims = (claims || []).slice(0, 10).map((claim: any) => ({
        amount: Number(claim.amount_claimed) / TOKEN_DIVISOR,
        date: claim.claimed_at,
        signature: claim.transaction_signature,
        wallet: claim.user_wallet,
      }));

      // Calculate metrics
      const remainingNeeded = totalAllocated - totalClaimed;
      const buffer = treasuryBalance - remainingNeeded;
      const bufferPercentage =
        remainingNeeded > 0 ? (buffer / remainingNeeded) * 100 : 0;

      // Determine status
      let status: "healthy" | "warning" | "critical";
      if (buffer >= remainingNeeded * 0.2) {
        status = "healthy"; // 20%+ buffer
      } else if (buffer >= 0) {
        status = "warning"; // Some buffer but less than 20%
      } else {
        status = "critical"; // Insufficient funds
      }

      // Get Streamflow pool info if deployed
      let streamflowPoolBalance = 0;
      try {
        let poolQuery = this.dbService.supabase
          .from("vesting_streams")
          .select("streamflow_stream_id, total_pool_amount")
          .eq("is_active", true);

        if (projectId) {
          poolQuery = poolQuery.eq("project_id", projectId);
        }

        const { data: activePools } = await poolQuery;

        if (activePools) {
          // Sum up all active pools for this project
          streamflowPoolBalance = activePools.reduce(
            (sum: number, pool: any) => {
              return pool.streamflow_stream_id
                ? sum + pool.total_pool_amount
                : sum;
            },
            0
          );
        }
      } catch (err) {
        // No active pool or Streamflow not deployed
      }

      // Build token breakdown (allocations + claims per token)
      const tokenBreakdown = [];

      // Get all unique token mints
      const allTokenMints = new Set<string>();
      allocationsByToken.forEach((_, mint) => allTokenMints.add(mint));
      claimsByToken.forEach((_, mint) => allTokenMints.add(mint));

      for (const mint of allTokenMints) {
        const allocated = allocationsByToken.get(mint) || 0;
        const claimed = claimsByToken.get(mint) || 0;
        const balance = tokens.find((t) => t.mint === mint)?.balance || 0;
        const symbol = this.getTokenSymbol(mint);

        tokenBreakdown.push({
          tokenMint: mint,
          tokenSymbol: symbol,
          balance,
          totalAllocated: allocated,
          totalClaimed: claimed,
          locked: allocated - claimed,
          available: balance - (allocated - claimed),
        });
      }

      res.json({
        success: true,
        data: {
          currentBalance: treasuryBalance,
          totalClaimed,
          claimCount,
          averageClaimSize: Math.round(averageClaimSize * 100) / 100,
          recentClaims,
        },
        treasury: {
          address: treasuryPublicKey.toBase58(),
          balance: treasuryBalance,
          tokenMint: tokenMint.toBase58(),
          tokens, // Include tokens list in response
        },
        allocations: {
          totalAllocated,
          totalClaimed,
          remainingNeeded,
        },
        tokenBreakdown, // NEW: Per-token breakdown
        metrics: {
          claimCount,
          averageClaimSize: Math.round(averageClaimSize * 100) / 100,
          recentClaims,
        },
        status: {
          health: status,
          buffer,
          bufferPercentage: Math.round(bufferPercentage),
          sufficientFunds: buffer >= 0,
        },
        streamflow: {
          deployed: streamflowPoolBalance > 0,
          poolBalance: streamflowPoolBalance,
        },
        recommendations: this.getRecommendations(
          status,
          buffer,
          remainingNeeded
        ),
      });
    } catch (error) {
      console.error("Failed to get treasury status:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * GET /api/treasury/pools
   * Get treasury allocation breakdown by pool with multi-token support
   */
  async getPoolBreakdown(req: Request, res: Response) {
    try {
      const TOKEN_DECIMALS = 9;
      const TOKEN_DIVISOR = Math.pow(10, TOKEN_DECIMALS);

      // Check for project context first
      const projectId = req.projectId || (req.query.projectId as string);

      let streamsQuery = this.dbService.supabase
        .from("vesting_streams")
        .select("*")
        .eq("is_active", true);

      if (projectId) {
        streamsQuery = streamsQuery.eq("project_id", projectId);
      }

      const { data: streams } = await streamsQuery;

      if (!streams || streams.length === 0) {
        return res.json({
          success: true,
          pools: [],
          tokenBreakdown: [],
          summary: {
            totalPools: 0,
            totalAllocated: 0,
            totalClaimed: 0,
            totalUsers: 0,
            uniqueTokens: 0,
          },
        });
      }

      // OPTIMIZATION: Batch fetch vestings and claims
      const streamIds = streams.map((s: { id: string }) => s.id);

      const { data: allVestings } = await this.dbService.supabase
        .from("vestings")
        .select("id, token_amount, user_wallet, vesting_stream_id")
        .in("vesting_stream_id", streamIds)
        .eq("is_active", true);

      // Map vestings to their stream
      const vestingsByStream = new Map<string, any[]>();
      const allVestingIds: string[] = [];

      allVestings?.forEach((v: any) => {
        const streamId = v.vesting_stream_id;
        if (!vestingsByStream.has(streamId)) {
          vestingsByStream.set(streamId, []);
        }
        vestingsByStream.get(streamId)?.push(v);
        allVestingIds.push(v.id);
      });

      // Batch fetch claims
      let allClaims: any[] = [];
      if (allVestingIds.length > 0) {
        const { data: claimsData } = await this.dbService.supabase
          .from("claim_history")
          .select("amount_claimed, vesting_id")
          .in("vesting_id", allVestingIds);
        allClaims = claimsData || [];
      }

      // Map claims to vesting (aggregate sum per vesting)
      const claimsByVesting = new Map<string, number>();
      allClaims.forEach((c: any) => {
        const current = claimsByVesting.get(c.vesting_id) || 0;
        claimsByVesting.set(c.vesting_id, current + Number(c.amount_claimed));
      });

      const poolBreakdown = [];
      const tokenTotals = new Map<
        string,
        { totalAllocated: number; totalClaimed: number; poolCount: number }
      >();

      for (const stream of streams) {
        // Get allocations for this pool from memory map
        const vestings = vestingsByStream.get(stream.id) || [];

        const totalAllocated = vestings.reduce(
          (sum: number, v: any) => sum + v.token_amount,
          0
        );
        const userCount = vestings.length;

        // Get claims for this pool from memory sum
        let totalClaimedRaw = 0;
        vestings.forEach((v: any) => {
          totalClaimedRaw += claimsByVesting.get(v.id) || 0;
        });

        const totalClaimed = totalClaimedRaw / TOKEN_DIVISOR;

        // Determine token mint for this pool
        const tokenMint =
          stream.token_mint || (await this.getProjectDefaultMint(projectId));
        const tokenSymbol = this.getTokenSymbol(tokenMint);

        // Update token totals
        if (!tokenTotals.has(tokenMint)) {
          tokenTotals.set(tokenMint, {
            totalAllocated: 0,
            totalClaimed: 0,
            poolCount: 0,
          });
        }
        const tokenTotal = tokenTotals.get(tokenMint)!;
        tokenTotal.totalAllocated += totalAllocated;
        tokenTotal.totalClaimed += totalClaimed;
        tokenTotal.poolCount += 1;

        poolBreakdown.push({
          id: stream.id,
          name: stream.name,
          description: stream.description,
          tokenMint,
          tokenSymbol,
          totalAllocated,
          totalClaimed,
          remainingNeeded: totalAllocated - totalClaimed,
          userCount,
          vestingDuration: stream.vesting_duration_days,
          cliffDuration: stream.cliff_duration_days,
          startTime: stream.start_time,
          endTime: stream.end_time,
          vestingMode: stream.vesting_mode,
        });
      }

      // Build per-token summary
      const tokenBreakdown = Array.from(tokenTotals.entries()).map(
        ([mint, totals]) => ({
          tokenMint: mint,
          tokenSymbol: this.getTokenSymbol(mint),
          totalAllocated: totals.totalAllocated,
          totalClaimed: totals.totalClaimed,
          remainingNeeded: totals.totalAllocated - totals.totalClaimed,
          poolCount: totals.poolCount,
        })
      );

      res.json({
        success: true,
        pools: poolBreakdown,
        tokenBreakdown, // NEW: Per-token summary
        summary: {
          totalPools: poolBreakdown.length,
          totalAllocated: poolBreakdown.reduce(
            (sum, p) => sum + p.totalAllocated,
            0
          ),
          totalClaimed: poolBreakdown.reduce(
            (sum, p) => sum + p.totalClaimed,
            0
          ),
          totalUsers: poolBreakdown.reduce((sum, p) => sum + p.userCount, 0),
          uniqueTokens: tokenTotals.size,
        },
      });
    } catch (error) {
      console.error("Failed to get pool breakdown:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  private getTokenSymbol(tokenMint: string): string {
    // Map common token mints to their symbols
    const tokenSymbols: { [key: string]: string } = {
      So11111111111111111111111111111111111111112: "SOL",
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
      Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
    };

    return (
      tokenSymbols[tokenMint] ||
      `${tokenMint.slice(0, 4)}...${tokenMint.slice(-4)}`
    );
  }

  private async getProjectDefaultMint(
    projectId: string | undefined
  ): Promise<string> {
    if (!projectId) {
      return (
        (typeof config.customTokenMint === "string"
          ? config.customTokenMint
          : config.customTokenMint?.toBase58()) ||
        "So11111111111111111111111111111111111111112"
      );
    }

    try {
      const { data: project } = await this.dbService.supabase
        .from("projects")
        .select("mint_address")
        .eq("id", projectId)
        .single();

      return (
        project?.mint_address ||
        (typeof config.customTokenMint === "string"
          ? config.customTokenMint
          : config.customTokenMint?.toBase58()) ||
        "So11111111111111111111111111111111111111112"
      );
    } catch {
      return (
        (typeof config.customTokenMint === "string"
          ? config.customTokenMint
          : config.customTokenMint?.toBase58()) ||
        "So11111111111111111111111111111111111111112"
      );
    }
  }

  private getRecommendations(
    status: "healthy" | "warning" | "critical",
    buffer: number,
    remainingNeeded: number
  ): string[] {
    const recommendations: string[] = [];

    if (status === "critical") {
      recommendations.push(
        "⚠️ URGENT: Treasury has insufficient funds to cover remaining vesting allocations"
      );
      recommendations.push(
        `Transfer at least ${Math.abs(
          buffer
        )} tokens to treasury wallet immediately`
      );
    } else if (status === "warning") {
      recommendations.push(
        "⚠️ Treasury buffer is low (less than 20% of remaining needed)"
      );
      recommendations.push(
        `Consider adding ${Math.ceil(
          remainingNeeded * 0.2 - buffer
        )} more tokens as buffer`
      );
    } else {
      recommendations.push("✅ Treasury is healthy with sufficient buffer");
    }

    return recommendations;
  }

  /**
   * GET /api/treasury/available
   * Get available balance for withdrawal (total - locked)
   */
  async getAvailableBalance(req: Request, res: Response) {
    try {
      const projectId = req.projectId || (req.query.projectId as string);
      const tokenMint = req.query.tokenMint as string | undefined;

      if (!projectId) {
        return res.status(400).json({ error: "Project ID required" });
      }

      const { calculateAvailableBalance } = await import(
        "../utils/treasuryCalculations"
      );

      // Get project to determine default token mint
      const { data: project } = await this.dbService.supabase
        .from("projects")
        .select("mint_address")
        .eq("id", projectId)
        .single();

      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }

      const mintToUse = tokenMint || project.mint_address;

      const balanceInfo = await calculateAvailableBalance(
        projectId,
        mintToUse,
        this.dbService.supabase,
        this.connection
      );

      res.json({
        success: true,
        ...balanceInfo,
      });
    } catch (error) {
      console.error("Failed to get available balance:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * POST /api/treasury/withdraw
   * Withdraw unlocked tokens from treasury
   */
  async withdrawTokens(req: Request, res: Response) {
    try {
      // Accept projectId from multiple sources for flexibility
      const projectId =
        req.projectId || (req.query.projectId as string) || req.body.projectId;
      const { amount, recipientAddress, note, tokenMint } = req.body;

      if (!projectId) {
        return res.status(400).json({
          error: "Project ID required",
          hint: "Pass projectId in query params, request body, or ensure project context is set",
        });
      }

      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Valid amount required" });
      }

      if (!recipientAddress) {
        return res.status(400).json({ error: "Recipient address required" });
      }

      const { calculateAvailableBalance } = await import(
        "../utils/treasuryCalculations"
      );
      const { getVaultKeypairForProject } = await import(
        "../services/vaultService"
      );
      const {
        createTransferInstruction,
        getAssociatedTokenAddress,
        TOKEN_PROGRAM_ID,
      } = await import("@solana/spl-token");
      const { Transaction, sendAndConfirmTransaction } = await import(
        "@solana/web3.js"
      );

      // Get project info
      const { data: project } = await this.dbService.supabase
        .from("projects")
        .select("mint_address")
        .eq("id", projectId)
        .single();

      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }

      // Use provided tokenMint or fall back to project's default mint
      const mintToUse = tokenMint || project.mint_address;

      // Check available balance for this specific token
      const balanceInfo = await calculateAvailableBalance(
        projectId,
        mintToUse,
        this.dbService.supabase,
        this.connection
      );

      if (amount > balanceInfo.available) {
        return res.status(400).json({
          error: "Insufficient available balance",
          available: balanceInfo.available,
          locked: balanceInfo.lockedInPools,
          requested: amount,
        });
      }

      // Get vault keypair
      const vaultKeypair = await getVaultKeypairForProject(projectId);
      const mintPubkey = new PublicKey(mintToUse);
      const recipientPubkey = new PublicKey(recipientAddress);

      // Get token accounts
      const vaultTokenAccount = await getAssociatedTokenAddress(
        mintPubkey,
        vaultKeypair.publicKey
      );
      const recipientTokenAccount = await getAssociatedTokenAddress(
        mintPubkey,
        recipientPubkey
      );

      // Create transfer transaction
      const TOKEN_DECIMALS = 9;
      const amountInBaseUnits = Math.floor(
        amount * Math.pow(10, TOKEN_DECIMALS)
      );

      const transaction = new Transaction().add(
        createTransferInstruction(
          vaultTokenAccount,
          recipientTokenAccount,
          vaultKeypair.publicKey,
          amountInBaseUnits,
          [],
          TOKEN_PROGRAM_ID
        )
      );

      // Send transaction
      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [vaultKeypair],
        { commitment: "confirmed" }
      );

      // Record transaction in history
      await this.dbService.supabase.from("treasury_transactions").insert({
        project_id: projectId,
        token_mint: mintToUse,
        amount,
        transaction_type: "withdrawal",
        transaction_signature: signature,
        notes: note || "Manual withdrawal",
      });

      res.json({
        success: true,
        message: "Withdrawal successful",
        signature,
        amount,
        recipient: recipientAddress,
      });
    } catch (error) {
      console.error("Failed to withdraw tokens:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * POST /api/treasury/withdraw-sol
   * Withdraw SOL from treasury vault (for gas fees)
   */
  async withdrawSol(req: Request, res: Response) {
    try {
      const projectId =
        req.projectId || (req.query.projectId as string) || req.body.projectId;
      const { amount, recipientAddress, note } = req.body;

      if (!projectId) {
        return res.status(400).json({
          error: "Project ID required",
          hint: "Pass projectId in query params, request body, or ensure project context is set",
        });
      }

      if (!amount || amount <= 0) {
        return res
          .status(400)
          .json({ error: "Valid amount required (in SOL)" });
      }

      if (!recipientAddress) {
        return res.status(400).json({ error: "Recipient address required" });
      }

      const { getVaultKeypairForProject } = await import(
        "../services/vaultService"
      );
      const {
        Transaction,
        SystemProgram,
        sendAndConfirmTransaction,
        LAMPORTS_PER_SOL,
      } = await import("@solana/web3.js");

      // Get vault keypair
      const vaultKeypair = await getVaultKeypairForProject(projectId);
      const recipientPubkey = new PublicKey(recipientAddress);

      // Check vault SOL balance
      const vaultBalance = await this.connection.getBalance(
        vaultKeypair.publicKey
      );
      const vaultBalanceInSol = vaultBalance / LAMPORTS_PER_SOL;

      // Convert amount from SOL to lamports
      const amountInLamports = Math.floor(amount * LAMPORTS_PER_SOL);

      // Reserve SOL for rent exemption (0.00089088 SOL minimum for account rent exemption)
      // Keeping 0.001 SOL to be safe
      const minRentReserve = 0.001 * LAMPORTS_PER_SOL;
      const availableBalance = vaultBalance - minRentReserve;

      if (amountInLamports > availableBalance) {
        return res.status(400).json({
          error: "Insufficient SOL balance",
          vaultBalance: vaultBalanceInSol,
          available: Math.max(0, availableBalance / LAMPORTS_PER_SOL),
          requested: amount,
          hint: "Account must maintain minimum 0.001 SOL for rent exemption (Solana requirement)",
        });
      }

      // Create transfer transaction
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: vaultKeypair.publicKey,
          toPubkey: recipientPubkey,
          lamports: amountInLamports,
        })
      );

      // Send transaction
      const signature = await sendAndConfirmTransaction(
        this.connection,
        transaction,
        [vaultKeypair],
        { commitment: "confirmed" }
      );

      console.log(`✅ SOL withdrawal successful: ${signature}`);
      console.log(`   Amount: ${amount} SOL`);
      console.log(`   From: ${vaultKeypair.publicKey.toBase58()}`);
      console.log(`   To: ${recipientAddress}`);
      if (note) console.log(`   Note: ${note}`);

      // Log action to admin_actions table
      try {
        await this.dbService.supabase.from("admin_logs").insert({
          action: "sol_withdrawal",
          admin_wallet: "System", // Placeholder as we don't have admin wallet in request yet
          details: {
            project_id: projectId,
            description: `Withdrew ${amount} SOL to ${recipientAddress}${
              note ? `: ${note}` : ""
            }`,
            amount,
            recipientAddress,
            signature,
            note,
            vaultAddress: vaultKeypair.publicKey.toBase58(),
          },
        });
      } catch (logError) {
        console.warn("Failed to log withdrawal action:", logError);
      }

      res.json({
        success: true,
        signature,
        amount,
        recipient: recipientAddress,
        vaultBalanceBefore: vaultBalanceInSol,
        vaultBalanceAfter: (vaultBalance - amountInLamports) / LAMPORTS_PER_SOL,
      });
    } catch (error) {
      console.error("SOL withdrawal failed:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "SOL withdrawal failed",
      });
    }
  }
}
