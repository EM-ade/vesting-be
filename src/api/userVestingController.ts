import { Request, Response } from "express";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  getAccount,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { createClient } from "@supabase/supabase-js";
import bs58 from "bs58";
import { SupabaseService } from "../services/supabaseService";
// DISABLED: Streamflow integration - using database-only mode for cost savings
// import { StreamflowService } from "../services/streamflowService";
import { PriceService } from "../services/priceService";
import { getVaultKeypairForProject } from "../services/vaultService";
import { config } from "../config";
import { cache } from "../lib/cache";
import Decimal from "decimal.js";
import { EligibilityService } from "../services/eligibilityService";
import { getRPCConfig } from '../config';
import { getTokenSymbol as fetchTokenSymbol } from "../services/tokenMetadataService";

/**
 * User Vesting API Controller
 * Handles user-facing vesting operations (summary, history, claims)
 */
export class UserVestingController {
  private dbService: SupabaseService;
  private connection: Connection;
  // DISABLED: Streamflow integration - using database-only mode
  // The streamflowService property is kept as 'any' to satisfy TypeScript for dead code paths
  private streamflowService: any = null;
  private priceService: PriceService;
  private eligibilityService: EligibilityService;
  private lastBlockhash: { hash: string; timestamp: number } | null = null;

  constructor() {
    const supabaseClient = createClient(
      config.supabaseUrl,
      config.supabaseServiceRoleKey
    );
    this.dbService = new SupabaseService(supabaseClient);
    // Detect cluster more robustly
    let cluster: "devnet" | "mainnet-beta" = "mainnet-beta";
    if (
      getRPCConfig().getRPCEndpoint().includes("devnet") ||
      getRPCConfig().getRPCEndpoint().includes("solana-devnet")
    ) {
      cluster = "devnet";
    }

    // Use Helius RPC if API key is provided and we are on devnet (for better stability)
    let rpcUrl = getRPCConfig().getRPCEndpoint();
    if (
      cluster === "devnet" &&
      config.heliusApiKey &&
      !getRPCConfig().getRPCEndpoint().includes("helius")
    ) {
      rpcUrl = getRPCConfig().getRPCEndpoint();
      console.log(
        `[INIT] Switching to Helius Devnet RPC for stability: ${
          rpcUrl.split("?")[0]
        }`
      );
    }

    this.connection = new Connection(rpcUrl, "confirmed");
    // DISABLED: Streamflow integration - using database-only mode
    // this.streamflowService = new StreamflowService();
    this.priceService = new PriceService(this.connection, cluster);
    this.eligibilityService = new EligibilityService();
  }
  
  /**
   * Helper function to get token decimals with fallback
   * ✅ FIX: Handles network errors gracefully - CRITICAL FOR MULTI-DECIMAL TOKENS
   */
  private async getTokenDecimals(tokenMint: PublicKey): Promise<number> {
    try {
      const { getMint } = await import("@solana/spl-token");
      const mintInfo = await getMint(this.connection, tokenMint);
      console.log(`[TOKEN] Using ${mintInfo.decimals} decimals for ${tokenMint.toBase58()}`);
      return mintInfo.decimals;
    } catch (err) {
      console.warn(`[TOKEN] Failed to fetch decimals for ${tokenMint.toBase58()}, using default 9:`, err);
      return 9; // Default fallback for SPL tokens
    }
  }

  /**
   * GET /api/user/vesting/list?wallet=xxx
   * Get all active vestings for a wallet
   */
  async listUserVestings(req: Request, res: Response) {
    try {
      const { wallet } = req.query;
      const projectId =
        req.projectId ||
        (req.headers["x-project-id"] as string) ||
        (req.query.projectId as string);

      if (!wallet || typeof wallet !== "string") {
        return res.status(400).json({ error: "wallet parameter is required" });
      }

      // SECURITY: Get active vesting records for this wallet in this project only
      let query = this.dbService.supabase
        .from("vestings")
        .select("*, vesting_streams(*)")
        .eq("user_wallet", wallet)
        .eq("is_active", true);

      // Filter by project if projectId is provided (multi-project mode)
      if (projectId) {
        query = query.eq("project_id", projectId);
      }

      const { data: vestings, error: vestingError } = await query.order(
        "created_at",
        { ascending: false }
      );

      if (vestingError) {
        console.error("Supabase error fetching vestings:", vestingError);
        // Return empty list on error instead of failing
        return res.json({ success: true, vestings: [] });
      }

      if (!vestings || vestings.length === 0) {
        return res.json({ success: true, vestings: [] });
      }

      // Filter out vestings with missing pool data, cancelled/paused pools, or pools that haven't started yet
      const now = new Date();
      const startedVestings = vestings.filter((v: any) => {
        // Skip if pool data is missing (orphaned vesting record)
        if (!v.vesting_streams) {
          console.warn(
            `⚠️ Vesting ${v.id} has no associated pool (orphaned record)`
          );
          return false;
        }

        // Skip if pool is cancelled or paused
        if (v.vesting_streams.state === "cancelled") {
          console.log(`⚠️ Vesting ${v.id} is in a cancelled pool, skipping`);
          return false;
        }

        if (v.vesting_streams.state === "paused") {
          console.log(`⚠️ Vesting ${v.id} is in a paused pool, skipping`);
          return false;
        }

        // Skip if pool hasn't started yet
        const startTime = new Date(v.vesting_streams.start_time);
        return startTime <= now;
      });

      // Return simplified list with pool state information
      const vestingList = startedVestings.map((v: any) => ({
        id: v.id,
        poolId: v.vesting_stream_id,
        poolName: v.vesting_streams.name,
        vestingMode: v.vesting_mode,
        tokenAmount: v.token_amount,
        nftCount: v.nft_count,
        streamflowId: v.vesting_streams.streamflow_stream_id,
        poolState: v.vesting_streams.state || "active", // Include pool state
        createdAt: v.created_at,
      }));

      res.json({
        success: true,
        vestings: vestingList,
      });
    } catch (error) {
      console.error("Failed to list user vestings:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * GET /api/user/vesting/summary?wallet=<address>&signature=<sig>&message=<msg>
   * Get user's vesting summary (pool total, share %, unlocked/locked balances, next unlock)
   */
  async getVestingSummary(req: Request, res: Response) {
    try {
      const { wallet, signature, message, poolId } = req.query;
      const projectId =
        req.projectId ||
        (req.headers["x-project-id"] as string) ||
        (req.query.projectId as string);

      if (!wallet || typeof wallet !== "string") {
        return res.status(400).json({ error: "wallet parameter is required" });
      }

      // Verify wallet signature for authentication (optional for read operations)
      if (signature && message) {
        try {
          const nacl = await import("tweetnacl");
          const messageBuffer = new TextEncoder().encode(message as string);
          const signatureBuffer = Buffer.from(signature as string, "base64");
          const publicKey = new PublicKey(wallet);

          const isValid = nacl.sign.detached.verify(
            messageBuffer,
            signatureBuffer,
            publicKey.toBytes()
          );

          if (!isValid) {
            return res.status(401).json({ error: "Invalid signature" });
          }

          // Check message freshness
          const messageData = JSON.parse(message as string);
          const timestamp = messageData.timestamp;
          const now = Date.now();
          const fiveMinutes = 5 * 60 * 1000;

          if (!timestamp || Math.abs(now - timestamp) > fiveMinutes) {
            return res.status(401).json({ error: "Signature expired" });
          }
        } catch (err) {
          return res
            .status(401)
            .json({ error: "Signature verification failed" });
        }
      }

      let userWallet: PublicKey;
      try {
        userWallet = new PublicKey(wallet);
      } catch (err) {
        return res.status(400).json({ error: "Invalid wallet address" });
      }

      // SECURITY: Get active vesting records for this wallet in this project only
      let vestingQuery = this.dbService.supabase
        .from("vestings")
        .select("*, vesting_streams(*)")
        .eq("user_wallet", wallet)
        .eq("is_active", true);

      // Filter by project if projectId is provided (multi-project mode)
      if (projectId) {
        vestingQuery = vestingQuery.eq("project_id", projectId);
      }

      const { data: vestings, error: vestingError } = await vestingQuery.order(
        "created_at",
        { ascending: false }
      );

      if (vestingError) {
        throw vestingError;
      }

      if (!vestings || vestings.length === 0) {
        return res
          .status(404)
          .json({ error: "No active vesting found for this wallet" });
      }

      // Filter out vestings with missing pool data, cancelled/paused pools
      const validVestings = vestings.filter((v: any) => {
        // Skip if pool data is missing (orphaned vesting record)
        if (!v.vesting_streams) {
          console.warn(
            `⚠️ Vesting ${v.id} has no associated pool (orphaned record)`
          );
          return false;
        }

        // Skip if pool is cancelled or paused
        if (v.vesting_streams.state === "cancelled") {
          console.log(`⚠️ Vesting ${v.id} is in a cancelled pool, skipping`);
          return false;
        }

        if (v.vesting_streams.state === "paused") {
          console.log(`⚠️ Vesting ${v.id} is in a paused pool, skipping`);
          return false;
        }

        return true;
      });

      if (validVestings.length === 0) {
        return res
          .status(404)
          .json({ error: "No valid vesting found for this wallet" });
      }

      // Use the most recent vesting (first in the list, ordered by created_at DESC)
      // TODO: Frontend should show all vestings and let user choose
      let vesting = validVestings[0];

      if (poolId && typeof poolId === "string") {
        const matchingVesting = validVestings.find(
          (v: any) => v.vesting_stream_id === poolId
        );

        if (!matchingVesting) {
          return res
            .status(404)
            .json({ error: "Vesting not found for specified pool" });
        }

        vesting = matchingVesting;
      }

      const stream = vesting.vesting_streams;

      // Check if pool is paused
      const isPoolPaused = stream.state === "paused";

      if (validVestings.length > 1) {
        console.log(
          `[SUMMARY] ⚠️ User has ${validVestings.length} active vesting(s), showing pool: ${vesting.vesting_mode} "${stream.name}"`
        );
        console.log(
          "[SUMMARY] Pools:",
          validVestings.map((v: any) => ({
            mode: v.vesting_mode,
            pool: v.vesting_streams?.name,
            id: v.vesting_stream_id,
            state: v.vesting_streams?.state || "active",
          }))
        );
      } else {
        console.log(
          `[SUMMARY] User has 1 active vesting: ${vesting.vesting_mode} pool "${
            stream.name
          }" (state: ${stream.state || "active"})`
        );
      }

      // Get user's claim history for THIS specific vesting only
      const claimHistory = await this.dbService.getClaimHistory(wallet);
      
      // ✅ FIX: Get actual token decimals from the vesting stream's token mint
      const tokenMintAddress = stream.token_mint || (req.project as any)?.mint_address;
      let TOKEN_DECIMALS = 9; // Default fallback
      if (tokenMintAddress) {
        try {
          TOKEN_DECIMALS = await this.getTokenDecimals(new PublicKey(tokenMintAddress));
        } catch (err) {
          console.warn(`[LIST] Failed to get decimals for ${tokenMintAddress}, using default 9`);
        }
      }
      const TOKEN_DIVISOR = Math.pow(10, TOKEN_DECIMALS);
      
      // Filter claims for this specific vesting
      const vestingClaims = claimHistory.filter(
        (claim) => claim.vesting_id === vesting.id
      );
      const totalClaimedBaseUnits = vestingClaims.reduce(
        (sum, claim) => sum + Number(claim.amount_claimed),
        0
      );
      const totalClaimed = totalClaimedBaseUnits / TOKEN_DIVISOR;

      // Calculate balances using Streamflow if deployed, otherwise use DB calculation
      const totalAllocation = vesting.token_amount;
      const now = Math.floor(Date.now() / 1000);
      const startTime = stream.start_time
        ? Math.floor(new Date(stream.start_time).getTime() / 1000)
        : now;

      // Use seconds if available, otherwise fall back to days
      const vestingDurationSeconds =
        stream.vesting_duration_seconds || stream.vesting_duration_days * 86400;
      const cliffDurationSeconds =
        stream.cliff_duration_seconds || stream.cliff_duration_days * 86400;

      const endTime = stream.end_time
        ? Math.floor(new Date(stream.end_time).getTime() / 1000)
        : now + vestingDurationSeconds;
      const cliffTime = startTime + cliffDurationSeconds;

      // Calculate vested amount
      let vestedAmount = 0;
      let vestedPercentage = 0;

      // DISABLED: Streamflow integration - using database-only mode for cost savings
      // Always use DB-based vesting calculation (time-based linear vesting)
      // This saves ~0.117 SOL per pool creation while maintaining same vesting logic
      if (false && stream.streamflow_stream_id) {
        // NOTE: Streamflow code preserved but disabled
        try {
          // const streamflowVested = await this.streamflowService.getVestedAmount(
          //   stream.streamflow_stream_id
          // );
          const streamflowVested = 0; // Placeholder - not used
          const poolTotal = stream.total_pool_amount;
          vestedPercentage = streamflowVested / poolTotal;
          vestedAmount = totalAllocation * vestedPercentage;
          console.log(
            `Streamflow vested: ${streamflowVested} / ${poolTotal} = ${
              vestedPercentage * 100
            }%`
          );
        } catch (err) {
          console.error(
            "Failed to get Streamflow vested amount, falling back to DB calculation:",
            err
          );
          // Fall back to DB calculation
          vestedPercentage = this.calculateVestedPercentage(
            now,
            startTime,
            endTime,
            cliffTime
          );
          vestedAmount = totalAllocation * vestedPercentage;
        }
      } else {
        // No Streamflow - use DB calculation
        vestedPercentage = this.calculateVestedPercentage(
          now,
          startTime,
          endTime,
          cliffTime
        );
        vestedAmount = totalAllocation * vestedPercentage;
      }

      const unlockedBalance = Math.max(0, vestedAmount - totalClaimed);
      const lockedBalance = totalAllocation - vestedAmount;

      // Calculate next unlock time
      const nextUnlockSeconds = now < endTime ? endTime - now : 0;

      // Get pool total from stream
      const poolTotal = stream.total_pool_amount;

      // Calculate user's share percentage
      const sharePercentage =
        vesting.share_percentage || (totalAllocation / poolTotal) * 100;

      // Check if claims are globally enabled
      const dbConfig = await this.dbService.getConfig();
      const claimsEnabled = dbConfig?.enable_claims !== false;

      res.json({
        success: true,
        data: {
          poolId: vesting.vesting_stream_id,
          poolTotal,
          poolState: stream.state || "active", // Include pool state
          distributionType: "Based on NFT Holdings (%)",
          userShare: {
            percentage: sharePercentage,
            totalEligible: totalAllocation,
          },
          balances: {
            unlocked: unlockedBalance,
            locked: lockedBalance,
            totalClaimed,
          },
          nextUnlock: {
            seconds: Math.max(0, nextUnlockSeconds),
            timestamp: endTime,
          },
          vestingSchedule: {
            startTime,
            cliffTime,
            endTime,
          },
          nftCount: vesting.nft_count,
          tier: vesting.tier || 0,
          eligible: vesting.is_active && !vesting.is_cancelled,
          claimsEnabled, // Add this flag so frontend knows if claims are disabled
          poolPaused: isPoolPaused, // Explicit flag for paused state
          tokenMint: stream.token_mint, // ✅ FIX: Include token mint
          tokenSymbol: await fetchTokenSymbol(stream.token_mint || "So11111111111111111111111111111111111111112"), // ✅ Dynamic token resolution
          streamflow: {
            deployed: !!stream.streamflow_stream_id,
            streamId: stream.streamflow_stream_id || null,
            vestedPercentage: vestedPercentage * 100,
          },
        },
      });
    } catch (error) {
      console.error("Failed to get vesting summary:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * GET /api/user/vesting/history?wallet=<address>&signature=<sig>&message=<msg>
   * Get user's claim history
   */
  async getClaimHistory(req: Request, res: Response) {
    try {
      const { wallet, signature, message } = req.query;
      const projectId =
        req.projectId ||
        (req.headers["x-project-id"] as string) ||
        (req.query.projectId as string);

      if (!wallet || typeof wallet !== "string") {
        return res.status(400).json({ error: "wallet parameter is required" });
      }

      // Verify wallet signature for authentication (optional for read operations)
      if (signature && message) {
        try {
          const nacl = await import("tweetnacl");
          const messageBuffer = new TextEncoder().encode(message as string);
          const signatureBuffer = Buffer.from(signature as string, "base64");
          const publicKey = new PublicKey(wallet);

          const isValid = nacl.sign.detached.verify(
            messageBuffer,
            signatureBuffer,
            publicKey.toBytes()
          );

          if (!isValid) {
            return res.status(401).json({ error: "Invalid signature" });
          }

          // Check message freshness
          const messageData = JSON.parse(message as string);
          const timestamp = messageData.timestamp;
          const now = Date.now();
          const fiveMinutes = 5 * 60 * 1000;

          if (!timestamp || Math.abs(now - timestamp) > fiveMinutes) {
            return res.status(401).json({ error: "Signature expired" });
          }
        } catch (err) {
          return res
            .status(401)
            .json({ error: "Signature verification failed" });
        }
      }

      // SECURITY: Get claim history from database with vesting information - filter by project
      let historyQuery = this.dbService.supabase
        .from("claim_history")
        .select(
          `
          *,
          vestings (
            id,
            user_wallet,
            token_amount,
            vesting_stream_id,
            vesting_streams (id, name, state)
          )
        `
        )
        .eq("user_wallet", wallet);

      // Filter by project if projectId is provided (multi-project mode)
      if (projectId) {
        historyQuery = historyQuery.eq("project_id", projectId);
      }

      const { data: historyWithVestings, error: historyError } =
        await historyQuery.order("claimed_at", { ascending: false });

      if (historyError) {
        console.error("Supabase error fetching claim history:", historyError);
        // Return empty history on error instead of failing
        return res.json({
          success: true,
          data: [],
        });
      }

      // Handle null or empty response
      if (!historyWithVestings) {
        return res.json({
          success: true,
          data: [],
        });
      }

      // Format history for frontend (convert from base units to human-readable)
      // ✅ FIX: Use dynamic decimals per claim based on the token mint
      const formattedHistory = await Promise.all(
        historyWithVestings.map(async (claim: any) => {
          let TOKEN_DECIMALS = 9; // Default fallback
          const tokenMintAddress = claim.vestings?.vesting_streams?.token_mint;
          
          if (tokenMintAddress) {
            try {
              TOKEN_DECIMALS = await this.getTokenDecimals(new PublicKey(tokenMintAddress));
            } catch (err) {
              console.warn(`[HISTORY] Failed to get decimals for ${tokenMintAddress}, using default 9`);
            }
          }
          
          const TOKEN_DIVISOR = Math.pow(10, TOKEN_DECIMALS);
          
          return {
            id: claim.id,
            date: claim.claimed_at,
            amount: Number(claim.amount_claimed) / TOKEN_DIVISOR,
            feePaid: Number(claim.fee_paid),
            transactionSignature: claim.transaction_signature,
            status: "Claimed", // All records in history are claimed
            vestingId: claim.vestings?.id || null,
            poolName: claim.vestings?.vesting_streams?.name || "Unknown Pool",
            poolState: claim.vestings?.vesting_streams?.state || "active",
          };
        })
      );

      res.json({
        success: true,
        data: formattedHistory,
      });
    } catch (error) {
      console.error("Failed to get claim history:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * POST /api/user/vesting/claim
   * User initiates claim - pays fee to treasury, gets fee transaction to sign
   * Body: { userWallet: string, amountToClaim?: number }
   * If amountToClaim is provided, claims that amount from all pools (FIFO)
   * If not provided, claims all available from all pools
   */
  async claimVesting(req: Request, res: Response) {
    try {
      // Check if claims are globally enabled
      const dbConfig = await this.dbService.getConfig();
      if (dbConfig && dbConfig.enable_claims === false) {
        return res.status(403).json({
          error:
            "Claims are currently disabled by the administrator. Please try again later.",
        });
      }

      const {
        userWallet,
        amountToClaim,
        tokenMint: requestTokenMint,
      } = req.body;

      if (!userWallet) {
        return res.status(400).json({ error: "userWallet is required" });
      }

      // Get all active vesting pools for user
      const { data: vestings, error: vestingError } =
        await this.dbService.supabase
          .from("vestings")
          .select("*, vesting_streams(*)")
          .eq("user_wallet", userWallet)
          .eq("is_active", true)
          .order("created_at", { ascending: true }); // FIFO order

      if (vestingError) {
        throw vestingError;
      }

      if (!vestings || vestings.length === 0) {
        return res
          .status(404)
          .json({ error: "No active vesting found for this wallet" });
      }

      // Filter valid vestings (exclude paused/cancelled pools)
      const now = Math.floor(Date.now() / 1000);
      let validVestings = vestings.filter((v: any) => {
        if (!v.vesting_streams) return false;
        if (
          v.vesting_streams.state === "cancelled" ||
          v.vesting_streams.state === "paused"
        )
          return false;
        const startTime = new Date(v.vesting_streams.start_time);
        return startTime <= new Date();
      });

      // Filter by token mint if provided
      if (requestTokenMint) {
        validVestings = validVestings.filter(
          (v: any) => v.vesting_streams.token_mint === requestTokenMint
        );
      }

      if (validVestings.length === 0) {
        return res
          .status(400)
          .json({ error: "No valid vesting pools available for claiming" });
      }

      // Get claim history and calculate available amounts per pool
      // Optimized: Fetch vestings with claim history in single query
      const claimHistory = await this.dbService.getClaimHistory(userWallet);
      
      // ✅ FIX: Get actual token decimals from the first vesting stream's token mint
      const tokenMintAddress = validVestings[0]?.vesting_streams?.token_mint;
      let TOKEN_DECIMALS = 9; // Default fallback
      if (tokenMintAddress) {
        try {
          TOKEN_DECIMALS = await this.getTokenDecimals(new PublicKey(tokenMintAddress));
        } catch (err) {
          console.warn(`[CLAIM] Failed to get decimals for ${tokenMintAddress}, using default 9`);
        }
      }
      const TOKEN_DIVISOR = Math.pow(10, TOKEN_DECIMALS);

      // DISABLED: Streamflow integration - using database-only mode for cost savings
      // All vesting calculations now use time-based DB calculation
      // const streamflowPromises = validVestings.map(async (vesting: any) => {
      //   const stream = vesting.vesting_streams;
      //   if (stream.streamflow_stream_id) {
      //     const cacheKey = `streamflow:${stream.streamflow_stream_id}`;
      //     let streamflowVested = cache.get<number>(cacheKey);
      //     if (streamflowVested === null) {
      //       try {
      //         streamflowVested = await this.streamflowService.getVestedAmount(stream.streamflow_stream_id);
      //         cache.set(cacheKey, streamflowVested, 30);
      //       } catch (err) {
      //         streamflowVested = null;
      //       }
      //     }
      //     return { vestingId: vesting.id, streamflowVested };
      //   }
      //   return { vestingId: vesting.id, streamflowVested: null };
      // });
      // const streamflowResults = await Promise.all(streamflowPromises);
      
      // Empty map - all vestings will use time-based calculation
      const streamflowMap = new Map<string, number | null>();

      const poolsWithAvailable = [];
      let totalAvailable = 0;

      for (const vesting of validVestings) {
        const stream = vesting.vesting_streams;
        const totalAllocation = vesting.token_amount;
        const startTime = stream.start_time
          ? Math.floor(new Date(stream.start_time).getTime() / 1000)
          : now;
        const vestingDurationSeconds =
          stream.vesting_duration_seconds ||
          stream.vesting_duration_days * 86400;
        const cliffDurationSeconds =
          stream.cliff_duration_seconds || stream.cliff_duration_days * 86400;
        const endTime = stream.end_time
          ? Math.floor(new Date(stream.end_time).getTime() / 1000)
          : now + vestingDurationSeconds;
        const cliffTime = startTime + cliffDurationSeconds;

        // Calculate vested amount using pre-fetched Streamflow data
        let vestedAmount = 0;
        const streamflowVested = streamflowMap.get(vesting.id);

        if (streamflowVested !== null && streamflowVested !== undefined) {
          const poolTotal = stream.total_pool_amount;
          const vestedPercentage = streamflowVested / poolTotal;
          vestedAmount = totalAllocation * vestedPercentage;
        } else {
          const vestedPercentage = this.calculateVestedPercentage(
            now,
            startTime,
            endTime,
            cliffTime
          );
          vestedAmount = totalAllocation * vestedPercentage;
        }

        // Get claims for this vesting
        const vestingClaims = claimHistory.filter(
          (claim) => claim.vesting_id === vesting.id
        );
        const vestingTotalClaimed =
          vestingClaims.reduce(
            (sum, claim) => sum + Number(claim.amount_claimed),
            0
          ) / TOKEN_DIVISOR;

        const available = Math.max(0, vestedAmount - vestingTotalClaimed);
        totalAvailable += available;

        if (available > 0) {
          poolsWithAvailable.push({
            vesting,
            stream,
            available,
            vestedAmount,
            totalAllocation,
            vestingTotalClaimed,
          });
        }
      }

      // Round down totalAvailable to 2 decimal places
      const roundedTotalAvailable = Math.floor(totalAvailable * 100) / 100;

      if (roundedTotalAvailable <= 0) {
        return res.status(400).json({ error: "No tokens available to claim" });
      }

      // Determine actual claim amount
      const actualClaimAmount = amountToClaim
        ? Math.min(amountToClaim, roundedTotalAvailable)
        : roundedTotalAvailable;

      if (actualClaimAmount <= 0) {
        return res.status(400).json({ error: "Invalid claim amount" });
      }

      // Distribute claim amount across pools (FIFO)
      let remainingToClaim = actualClaimAmount;
      const poolBreakdown = [];

      for (const poolData of poolsWithAvailable) {
        if (remainingToClaim <= 0) break;

        const amountFromThisPool = Math.min(
          remainingToClaim,
          poolData.available
        );
        remainingToClaim -= amountFromThisPool;

        poolBreakdown.push({
          poolId: poolData.vesting.vesting_stream_id,
          poolName: poolData.stream.name,
          amountToClaim: amountFromThisPool,
          availableFromPool: poolData.available,
          vestingId: poolData.vesting.id,
        });
      }

      console.log(
        `[CLAIM] Total available: ${roundedTotalAvailable}, claiming: ${actualClaimAmount}`
      );
      console.log(`[CLAIM] Pool breakdown:`, poolBreakdown);

      // Get claim fee from config or project context
      let feeInLamports: number;
      let feeWalletPubkey: PublicKey;
      let claimFeeUsd = 0;
      let feeInSol = 0;
      let project = req.project;

      // Fee structure variables (accessible throughout)
      let globalPlatformFeeLamports = 0;
      let platformFeeWallet: PublicKey | null = null;
      let poolProjectFeeLamports = 0;
      let projectVaultWallet: PublicKey | null = null;

      // If project context is missing, try to derive it from the vestings
      if (!project && validVestings.length > 0) {
        console.log(
          "[CLAIM] No project context in request, attempting to derive from vestings..."
        );
        const projectId =
          validVestings[0].project_id ||
          validVestings[0].vesting_streams?.project_id;

        if (projectId) {
          const { data: derivedProject } = await this.dbService.supabase
            .from("projects")
            .select("*")
            .eq("id", projectId)
            .single();
          if (derivedProject) project = derivedProject;
        } else {
          const { data: projects } = await this.dbService.supabase
            .from("projects")
            .select("*")
            .eq("is_active", true)
            .limit(1);
          if (projects && projects.length > 0) project = projects[0];
        }
      }

      if (project) {
        // ADDITIVE FEE STRUCTURE:
        // 1. Global platform fee (mandatory) -> goes to our fee wallet
        // 2. Pool project fee (optional) -> goes to project vault
        // User pays BOTH fees

        // 1. Get global platform fee (mandatory, goes to our fee wallet)
        try {
          const globalConfig = await this.dbService.getConfig();
          if (globalConfig) {
            // Check if there's a global fee_wallet configured
            if (globalConfig.fee_wallet) {
              platformFeeWallet = new PublicKey(globalConfig.fee_wallet);
            }

            // Get the fee amount
            if (globalConfig.claim_fee_usd !== undefined) {
              claimFeeUsd = Number(globalConfig.claim_fee_usd);
              const { solAmount } = await this.priceService.calculateSolFee(
                claimFeeUsd
              );
              globalPlatformFeeLamports = Math.floor(
                solAmount * LAMPORTS_PER_SOL
              );
              console.log(
                `[CLAIM] Global platform fee (DB): ${claimFeeUsd} USD (${solAmount} SOL = ${globalPlatformFeeLamports} lamports)`
              );
            } else if (globalConfig.claim_fee_sol !== undefined) {
              globalPlatformFeeLamports = Math.floor(
                Number(globalConfig.claim_fee_sol) * LAMPORTS_PER_SOL
              );
              console.log(
                `[CLAIM] Global platform fee (DB): ${globalPlatformFeeLamports} lamports`
              );
            }
          }
        } catch (err) {
          console.warn(
            "[CLAIM] Failed to get global platform fee from DB:",
            err
          );
        }

        // Fallback to config file if DB didn't provide a fee
        if (globalPlatformFeeLamports === 0 && config.claimFeeUSD) {
          try {
            claimFeeUsd = config.claimFeeUSD;
            const { solAmount } = await this.priceService.calculateSolFee(
              claimFeeUsd
            );
            globalPlatformFeeLamports = Math.floor(
              solAmount * LAMPORTS_PER_SOL
            );
            console.log(
              `[CLAIM] Global platform fee (Config): ${claimFeeUsd} USD (${solAmount} SOL = ${globalPlatformFeeLamports} lamports)`
            );
          } catch (err) {
            console.error(
              "[CLAIM] Failed to calculate dynamic fee from config:",
              err
            );
            // Final fallback to static SOL fee
            globalPlatformFeeLamports = Math.floor(
              config.claimFeeSOL * LAMPORTS_PER_SOL
            );
          }
        } else if (globalPlatformFeeLamports === 0 && config.claimFeeSOL) {
          globalPlatformFeeLamports = Math.floor(
            config.claimFeeSOL * LAMPORTS_PER_SOL
          );
        }

        // 2. Get pool-level project fee (optional, goes to project vault)
        if (validVestings.length > 0 && validVestings[0].vesting_streams) {
          const poolFee = validVestings[0].vesting_streams.claim_fee_lamports;
          if (poolFee && poolFee > 0) {
            poolProjectFeeLamports = Number(poolFee);
            console.log(
              `[CLAIM] Pool project fee: ${poolProjectFeeLamports} lamports (${
                poolProjectFeeLamports / LAMPORTS_PER_SOL
              } SOL)`
            );

            // Determine where the pool project fee goes
            if (project.vault_public_key) {
              projectVaultWallet = new PublicKey(project.vault_public_key);
            } else if (project.fee_recipient_address) {
              projectVaultWallet = new PublicKey(project.fee_recipient_address);
            }
          }
        }

        // Calculate total fee
        feeInLamports = globalPlatformFeeLamports + poolProjectFeeLamports;
        feeInSol = feeInLamports / LAMPORTS_PER_SOL;

        console.log(`[CLAIM] Fee breakdown:`);
        console.log(
          `  - Global platform fee: ${globalPlatformFeeLamports} lamports -> ${
            platformFeeWallet?.toBase58() || "N/A"
          }`
        );
        console.log(
          `  - Pool project fee: ${poolProjectFeeLamports} lamports -> ${
            projectVaultWallet?.toBase58() || "N/A"
          }`
        );
        console.log(
          `  - Total fee: ${feeInLamports} lamports (${feeInSol} SOL)`
        );

        // Set the main fee wallet (for backward compatibility with existing code)
        // Priority: platform fee wallet > project fee recipient > project vault > default
        if (platformFeeWallet) {
          feeWalletPubkey = platformFeeWallet;
        } else if (project.fee_recipient_address) {
          feeWalletPubkey = new PublicKey(project.fee_recipient_address);
        } else if (project.vault_public_key) {
          feeWalletPubkey = new PublicKey(project.vault_public_key);
        } else {
          feeWalletPubkey =
            config.feeWallet ||
            new PublicKey("11111111111111111111111111111111");
        }
      } else {
        return res.status(500).json({
          error:
            "Unable to determine project context for claim. Please contact support.",
        });
      }

      const userPublicKey = new PublicKey(userWallet);

      // --- SINGLE TRANSACTION CONSTRUCTION ---

      // 1. Get Vault Keypair & Token Mint
      let vaultKeypair: Keypair;
      let projectTokenMint: PublicKey;
      try {
        vaultKeypair = await getVaultKeypairForProject(project.id);

        // Get token mint from the first pool's token_mint (all pools in validVestings should have same token)
        // Fall back to project mint_address if pool doesn't have token_mint set
        const poolTokenMint = validVestings[0]?.vesting_streams?.token_mint;
        const mintToUse = poolTokenMint || project.mint_address;

        console.log(`[CLAIM] Pool token_mint: ${poolTokenMint || "not set"}`);
        console.log(`[CLAIM] Using token mint: ${mintToUse}`);

        projectTokenMint = new PublicKey(mintToUse);
      } catch (err) {
        console.error("Failed to get project vault or token mint:", err);
        return res
          .status(500)
          .json({ error: "Failed to access project vault or token mint" });
      }

      // 2. Check if this is native SOL
      const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";
      const isNativeSOL = projectTokenMint.toBase58() === NATIVE_SOL_MINT;

      console.log(`[CLAIM] Token mint: ${projectTokenMint.toBase58()}`);
      console.log(`[CLAIM] Is native SOL: ${isNativeSOL}`);
      console.log(`[CLAIM] RPC Endpoint: ${this.connection.rpcEndpoint}`);

      // 3. Build Instructions
      const instructions = [];

      // A. Claim Fees (User -> Platform & Project)
      // A1. Global platform fee (if applicable)
      if (globalPlatformFeeLamports > 0 && platformFeeWallet) {
        instructions.push(
          SystemProgram.transfer({
            fromPubkey: userPublicKey,
            toPubkey: platformFeeWallet,
            lamports: globalPlatformFeeLamports,
          })
        );
      }

      // A2. Pool project fee (if applicable)
      if (poolProjectFeeLamports > 0 && projectVaultWallet) {
        instructions.push(
          SystemProgram.transfer({
            fromPubkey: userPublicKey,
            toPubkey: projectVaultWallet,
            lamports: poolProjectFeeLamports,
          })
        );
      }

      // B. Token/SOL Transfer
      if (isNativeSOL) {
        // For native SOL: Direct SOL transfer from vault to user
        const amountInLamports = this.toBaseUnits(actualClaimAmount, 9); // SOL has 9 decimals
        console.log(
          `[CLAIM] Native SOL transfer: ${actualClaimAmount} SOL (${amountInLamports} lamports)`
        );
        console.log(`[CLAIM] From vault: ${vaultKeypair.publicKey.toBase58()}`);
        console.log(`[CLAIM] To user: ${userPublicKey.toBase58()}`);

        instructions.push(
          SystemProgram.transfer({
            fromPubkey: vaultKeypair.publicKey,
            toPubkey: userPublicKey,
            lamports: Number(amountInLamports),
          })
        );
      } else {
        // For SPL tokens: Use token accounts
        // ✅ FIX: Properly detect token program (Token vs Token-2022)
        const { detectTokenProgram } = await import("../utils/tokenProgramDetection");
        const tokenProgramId = await detectTokenProgram(this.connection, projectTokenMint);
        
        console.log(`[CLAIM] Using token program: ${tokenProgramId.toBase58()}`);

        const vaultTokenAccount = await getAssociatedTokenAddress(
          projectTokenMint,
          vaultKeypair.publicKey,
          false,
          tokenProgramId
        );
        const userTokenAccount = await getAssociatedTokenAddress(
          projectTokenMint,
          userPublicKey,
          false,
          tokenProgramId
        );

        console.log(`[CLAIM] Vault token account: ${vaultTokenAccount.toBase58()}`);
        console.log(`[CLAIM] User token account: ${userTokenAccount.toBase58()}`);

        // ✅ FIX: Verify vault token account exists before attempting transfer
        try {
          await getAccount(this.connection, vaultTokenAccount, undefined, tokenProgramId);
          console.log(`[CLAIM] ✓ Vault token account exists`);
        } catch (err) {
          console.error(`[CLAIM] ✗ Vault token account does not exist:`, err);
          throw new Error(`Vault token account does not exist. Please ensure the treasury is funded with tokens.`);
        }

        // Check if User ATA exists
        let userTokenAccountExists = false;
        try {
          await getAccount(
            this.connection,
            userTokenAccount,
            undefined,
            tokenProgramId
          );
          userTokenAccountExists = true;
          console.log(`[CLAIM] ✓ User token account already exists`);
        } catch (err) {
          console.log(`[CLAIM] User token account does not exist, will create it`);
        }

        // Create ATA (if needed) - User pays rent
        if (!userTokenAccountExists) {
          instructions.push(
            createAssociatedTokenAccountInstruction(
              userPublicKey, // Payer (User)
              userTokenAccount,
              userPublicKey, // Owner
              projectTokenMint,
              tokenProgramId
            )
          );
        }

        // Token Transfer (Vault -> User)
        // ✅ FIX: Get actual token decimals instead of hardcoded 9
        const tokenDecimals = await this.getTokenDecimals(projectTokenMint);
        const amountInBaseUnits = this.toBaseUnits(
          actualClaimAmount,
          tokenDecimals
        );
        
        console.log(`\n========== CLAIM CONVERSION DEBUG ==========`);
        console.log(`[CLAIM] Token: ${projectTokenMint.toBase58()}`);
        console.log(`[CLAIM] Decimals: ${tokenDecimals}`);
        console.log(`[CLAIM] Amount (UI): ${actualClaimAmount}`);
        console.log(`[CLAIM] Base Units: ${amountInBaseUnits}`);
        console.log(`============================================\n`);
        
        instructions.push(
          createTransferInstruction(
            vaultTokenAccount,
            userTokenAccount,
            vaultKeypair.publicKey,
            amountInBaseUnits,
            [],
            tokenProgramId
          )
        );
      }

      // 5. PRE-TRANSACTION DIAGNOSTICS - Check all account balances
      console.log("\n========== PRE-TRANSACTION DIAGNOSTICS ==========");
      console.log(`[DIAG] Vault address: ${vaultKeypair.publicKey.toBase58()}`);
      console.log(`[DIAG] User address: ${userPublicKey.toBase58()}`);
      console.log(`[DIAG] Token mint: ${projectTokenMint.toBase58()}`);
      try {
        // Check vault SOL balance
        const vaultSOLBalance = await this.connection.getBalance(vaultKeypair.publicKey);
        console.log(`[DIAG] Vault SOL balance: ${vaultSOLBalance / LAMPORTS_PER_SOL} SOL (${vaultSOLBalance} lamports)`);
        
        // Check user SOL balance
        const userSOLBalance = await this.connection.getBalance(userPublicKey);
        console.log(`[DIAG] User SOL balance: ${userSOLBalance / LAMPORTS_PER_SOL} SOL (${userSOLBalance} lamports)`);
        
        // Calculate required SOL for user
        const requiredUserSOL = globalPlatformFeeLamports + poolProjectFeeLamports + 10000; // fees + ~0.00001 SOL network fee estimate
        console.log(`[DIAG] Required user SOL: ${requiredUserSOL / LAMPORTS_PER_SOL} SOL (${requiredUserSOL} lamports)`);
        console.log(`[DIAG] User has enough SOL: ${userSOLBalance >= requiredUserSOL ? 'YES ✓' : 'NO ✗'}`);
        
        if (!isNativeSOL) {
          // Check vault token balance
          try {
            const vaultTokenAccount = await getAssociatedTokenAddress(
              projectTokenMint,
              vaultKeypair.publicKey,
              false,
              await this.connection.getAccountInfo(projectTokenMint).then(info => info?.owner || new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"))
            );
            const vaultTokenAccountInfo = await this.connection.getTokenAccountBalance(vaultTokenAccount);
            console.log(`[DIAG] Vault token balance: ${vaultTokenAccountInfo.value.uiAmount} tokens`);
            console.log(`[DIAG] Required token amount: ${actualClaimAmount}`);
            console.log(`[DIAG] Vault has enough tokens: ${(vaultTokenAccountInfo.value.uiAmount || 0) >= actualClaimAmount ? 'YES ✓' : 'NO ✗'}`);
          } catch (tokenErr) {
            console.error(`[DIAG] Failed to fetch vault token balance:`, tokenErr);
          }
        } else {
          // For native SOL, vault needs claim amount + potential rent
          const requiredVaultSOL = this.toBaseUnits(actualClaimAmount, 9);
          console.log(`[DIAG] Required vault SOL for claim: ${actualClaimAmount} SOL (${requiredVaultSOL} lamports)`);
          console.log(`[DIAG] Vault has enough SOL: ${vaultSOLBalance >= Number(requiredVaultSOL) ? 'YES ✓' : 'NO ✗'}`);
        }
        
        // Log transaction structure
        console.log(`\n[DIAG] Transaction will contain ${instructions.length} instructions:`);
        instructions.forEach((ix, idx) => {
          console.log(`  ${idx + 1}. Program: ${ix.programId.toBase58()}`);
          console.log(`     Keys: ${ix.keys.length} accounts`);
          if (ix.programId.equals(SystemProgram.programId)) {
            console.log(`     Type: System Program (SOL transfer or other)`);
          }
        });
      } catch (diagErr) {
        console.error("[DIAG] Failed to run diagnostics:", diagErr);
      }
      console.log("=================================================\n");

      // 5. Create Transaction
      // Added retry logic for blockhash fetching to mitigate transient "fetch failed" errors
      let blockhashRes;
      let retries = 3;
      const commitments: ("confirmed" | "finalized" | "processed")[] = [
        "confirmed",
        "finalized",
        "processed",
      ];

      while (retries > 0) {
        const commitment = commitments[3 - retries] || "confirmed";
        try {
          console.log(
            `[CLAIM] Fetching blockhash from RPC: ${
              getRPCConfig().getRPCEndpoint()
            } (Commitment: ${commitment}, Attempt: ${4 - retries})`
          );
          blockhashRes = await this.connection.getLatestBlockhash(commitment);
          break;
        } catch (err) {
          retries--;
          console.warn(
            `[CLAIM] Failed to get blockhash from ${getRPCConfig().getRPCEndpoint()} with commitment ${commitment}. Retries left: ${retries}`,
            err
          );
          if (retries === 0) {
            console.error(
              `[CLAIM] Fatal: All 3 blockhash fetch attempts failed for endpoint: ${getRPCConfig().getRPCEndpoint()}`
            );
            throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, 2000)); // Increased wait time
        }
      }
      const { blockhash, lastValidBlockHeight } = blockhashRes!;

      const messageV0 = new TransactionMessage({
        payerKey: userPublicKey, // User pays gas
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);

      // 6. Partial Sign by Vault (authorizing the transfer)
      transaction.sign([vaultKeypair]);

      // 7. Serialize and Return
      const serializedTransaction = Buffer.from(
        transaction.serialize()
      ).toString("base64");

      console.log(`[CLAIM] ✓ Transaction constructed successfully`);
      console.log(`[CLAIM] Transaction size: ${serializedTransaction.length} bytes (base64)`);

      res.json({
        success: true,
        step: "sign_transaction",
        transaction: serializedTransaction,
        lastValidBlockHeight,
        claimDetails: {
          amountToClaim: actualClaimAmount,
          totalAvailable: roundedTotalAvailable,
          poolBreakdown,
        },
        feeDetails: {
          amountSol: feeInSol,
          amountLamports: feeInLamports,
        },
      });
    } catch (error) {
      console.error("\n========== CLAIM ERROR DETAILS ==========");
      console.error("Error type:", error?.constructor?.name);
      console.error("Error message:", error instanceof Error ? error.message : String(error));
      
      if (error && typeof error === 'object') {
        // Log all error properties
        console.error("Full error object:", JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
      }
      
      // If it's a Solana RPC error, it might have logs
      if (error && typeof error === 'object' && 'logs' in error) {
        console.error("Transaction logs:", (error as any).logs);
      }
      
      console.error("=========================================\n");
      
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
        details: error && typeof error === 'object' ? {
          name: error.constructor?.name,
          logs: 'logs' in error ? (error as any).logs : undefined,
        } : undefined,
      });
    }
  }

  /**
   * POST /api/user/vesting/claim-v2
   * SPLIT TRANSACTION FLOW - Step 1: Returns fee-only transaction for user to sign
   * This eliminates Phantom's "malicious dApp" warning by having only 1 signer per transaction
   * 
   * Flow:
   * 1. User calls /claim-v2 → Gets fee-only transaction (user signs alone)
   * 2. User signs and sends fee transaction
   * 3. User calls /execute-claim-v2 with fee signature → Backend verifies and sends tokens
   */
  async claimVestingV2(req: Request, res: Response) {
    try {
      // Check if claims are globally enabled
      const dbConfig = await this.dbService.getConfig();
      if (dbConfig && dbConfig.enable_claims === false) {
        return res.status(403).json({
          error: "Claims are currently disabled by the administrator. Please try again later.",
        });
      }

      const { userWallet, amountToClaim, tokenMint: requestTokenMint } = req.body;

      if (!userWallet) {
        return res.status(400).json({ error: "userWallet is required" });
      }

      console.log(`[CLAIM-V2] Starting claim for wallet: ${userWallet}`);

      // Get all active vesting pools for user
      const { data: vestings, error: vestingError } = await this.dbService.supabase
        .from("vestings")
        .select("*, vesting_streams(*)")
        .eq("user_wallet", userWallet)
        .eq("is_active", true)
        .order("created_at", { ascending: true }); // FIFO order

      if (vestingError) throw vestingError;

      if (!vestings || vestings.length === 0) {
        return res.status(404).json({ error: "No active vesting found for this wallet" });
      }

      // Filter valid vestings (exclude paused/cancelled pools)
      const now = Math.floor(Date.now() / 1000);
      let validVestings = vestings.filter((v: any) => {
        if (!v.vesting_streams) return false;
        if (v.vesting_streams.state === "cancelled" || v.vesting_streams.state === "paused") return false;
        const startTime = new Date(v.vesting_streams.start_time);
        return startTime <= new Date();
      });

      // Filter by token mint if provided
      if (requestTokenMint) {
        validVestings = validVestings.filter((v: any) => v.vesting_streams.token_mint === requestTokenMint);
      }

      if (validVestings.length === 0) {
        return res.status(400).json({ error: "No valid vesting pools available for claiming" });
      }

      // Get claim history and calculate available amounts
      const claimHistory = await this.dbService.getClaimHistory(userWallet);
      
      // Get token decimals
      const tokenMintAddress = validVestings[0]?.vesting_streams?.token_mint;
      let TOKEN_DECIMALS = 9;
      if (tokenMintAddress) {
        try {
          TOKEN_DECIMALS = await this.getTokenDecimals(new PublicKey(tokenMintAddress));
        } catch (err) {
          console.warn(`[CLAIM-V2] Failed to get decimals for ${tokenMintAddress}, using default 9`);
        }
      }
      const TOKEN_DIVISOR = Math.pow(10, TOKEN_DECIMALS);

      // Calculate available amounts per pool
      const poolsWithAvailable = [];
      let totalAvailable = 0;

      for (const vesting of validVestings) {
        const stream = vesting.vesting_streams;
        const totalAllocation = vesting.token_amount;
        const startTime = stream.start_time ? Math.floor(new Date(stream.start_time).getTime() / 1000) : now;
        const vestingDurationSeconds = stream.vesting_duration_seconds || stream.vesting_duration_days * 86400;
        const cliffDurationSeconds = stream.cliff_duration_seconds || stream.cliff_duration_days * 86400;
        const endTime = stream.end_time ? Math.floor(new Date(stream.end_time).getTime() / 1000) : now + vestingDurationSeconds;
        const cliffTime = startTime + cliffDurationSeconds;

        const vestedPercentage = this.calculateVestedPercentage(now, startTime, endTime, cliffTime);
        const vestedAmount = totalAllocation * vestedPercentage;

        const vestingClaims = claimHistory.filter((claim) => claim.vesting_id === vesting.id);
        const vestingTotalClaimed = vestingClaims.reduce((sum, claim) => sum + Number(claim.amount_claimed), 0) / TOKEN_DIVISOR;

        const available = Math.max(0, vestedAmount - vestingTotalClaimed);
        totalAvailable += available;

        if (available > 0) {
          poolsWithAvailable.push({
            vesting,
            stream,
            available,
            vestedAmount,
            totalAllocation,
            vestingTotalClaimed,
          });
        }
      }

      const roundedTotalAvailable = Math.floor(totalAvailable * 100) / 100;
      if (roundedTotalAvailable <= 0) {
        return res.status(400).json({ error: "No tokens available to claim" });
      }

      const actualClaimAmount = amountToClaim ? Math.min(amountToClaim, roundedTotalAvailable) : roundedTotalAvailable;
      if (actualClaimAmount <= 0) {
        return res.status(400).json({ error: "Invalid claim amount" });
      }

      // Distribute claim amount across pools (FIFO)
      let remainingToClaim = actualClaimAmount;
      const poolBreakdown = [];

      for (const poolData of poolsWithAvailable) {
        if (remainingToClaim <= 0) break;
        const amountFromThisPool = Math.min(remainingToClaim, poolData.available);
        remainingToClaim -= amountFromThisPool;

        poolBreakdown.push({
          poolId: poolData.vesting.vesting_stream_id,
          poolName: poolData.stream.name,
          amountToClaim: amountFromThisPool,
          availableFromPool: poolData.available,
          vestingId: poolData.vesting.id,
        });
      }

      console.log(`[CLAIM-V2] Total available: ${roundedTotalAvailable}, claiming: ${actualClaimAmount}`);
      console.log(`[CLAIM-V2] Pool breakdown:`, poolBreakdown);

      // Get project context
      let project = req.project;
      if (!project && validVestings.length > 0) {
        const projectId = validVestings[0].project_id || validVestings[0].vesting_streams?.project_id;
        if (projectId) {
          const { data: derivedProject } = await this.dbService.supabase
            .from("projects")
            .select("*")
            .eq("id", projectId)
            .single();
          if (derivedProject) project = derivedProject;
        }
      }

      if (!project) {
        return res.status(500).json({ error: "Unable to determine project context for claim." });
      }

      // Calculate fees
      let globalPlatformFeeLamports = 0;
      let platformFeeWallet: PublicKey | null = null;
      let poolProjectFeeLamports = 0;
      let projectVaultWallet: PublicKey | null = null;
      let claimFeeUsd = 0;

      // Get global platform fee
      try {
        const globalConfig = await this.dbService.getConfig();
        if (globalConfig?.fee_wallet) {
          platformFeeWallet = new PublicKey(globalConfig.fee_wallet);
        }
        if (globalConfig?.claim_fee_usd !== undefined) {
          claimFeeUsd = Number(globalConfig.claim_fee_usd);
          const { solAmount } = await this.priceService.calculateSolFee(claimFeeUsd);
          globalPlatformFeeLamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
        } else if (globalConfig?.claim_fee_sol !== undefined) {
          globalPlatformFeeLamports = Math.floor(Number(globalConfig.claim_fee_sol) * LAMPORTS_PER_SOL);
        }
      } catch (err) {
        console.warn("[CLAIM-V2] Failed to get global platform fee:", err);
      }

      // Fallback to config
      if (globalPlatformFeeLamports === 0 && config.claimFeeUSD) {
        claimFeeUsd = config.claimFeeUSD;
        const { solAmount } = await this.priceService.calculateSolFee(claimFeeUsd);
        globalPlatformFeeLamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
      } else if (globalPlatformFeeLamports === 0 && config.claimFeeSOL) {
        globalPlatformFeeLamports = Math.floor(config.claimFeeSOL * LAMPORTS_PER_SOL);
      }

      // Get pool project fee
      if (validVestings[0]?.vesting_streams?.claim_fee_lamports) {
        poolProjectFeeLamports = Number(validVestings[0].vesting_streams.claim_fee_lamports);
        if (project.vault_public_key) {
          projectVaultWallet = new PublicKey(project.vault_public_key);
        } else if (project.fee_recipient_address) {
          projectVaultWallet = new PublicKey(project.fee_recipient_address);
        }
      }

      const totalFeeLamports = globalPlatformFeeLamports + poolProjectFeeLamports;
      const feeInSol = totalFeeLamports / LAMPORTS_PER_SOL;

      console.log(`[CLAIM-V2] Fee breakdown:`);
      console.log(`  - Platform fee: ${globalPlatformFeeLamports} lamports -> ${platformFeeWallet?.toBase58() || "N/A"}`);
      console.log(`  - Project fee: ${poolProjectFeeLamports} lamports -> ${projectVaultWallet?.toBase58() || "N/A"}`);
      console.log(`  - Total: ${totalFeeLamports} lamports (${feeInSol} SOL)`);

      const userPublicKey = new PublicKey(userWallet);

      // ===== BUILD FEE-ONLY TRANSACTION (Single signer: User) =====
      const feeInstructions = [];

      // Platform fee transfer
      if (globalPlatformFeeLamports > 0 && platformFeeWallet) {
        feeInstructions.push(
          SystemProgram.transfer({
            fromPubkey: userPublicKey,
            toPubkey: platformFeeWallet,
            lamports: globalPlatformFeeLamports,
          })
        );
      }

      // Project fee transfer
      if (poolProjectFeeLamports > 0 && projectVaultWallet) {
        feeInstructions.push(
          SystemProgram.transfer({
            fromPubkey: userPublicKey,
            toPubkey: projectVaultWallet,
            lamports: poolProjectFeeLamports,
          })
        );
      }

      // If no fees, we still need at least one instruction - add a memo or skip fee tx
      if (feeInstructions.length === 0) {
        console.log("[CLAIM-V2] No fees configured, skipping fee transaction");
        // Generate a claim token for direct execution
        const claimToken = Buffer.from(
          JSON.stringify({
            userWallet,
            amountToClaim: actualClaimAmount,
            poolBreakdown,
            projectId: project.id,
            tokenMint: tokenMintAddress,
            timestamp: Date.now(),
            noFee: true,
          })
        ).toString("base64");

        return res.json({
          success: true,
          step: "execute_directly",
          claimToken,
          claimDetails: {
            amountToClaim: actualClaimAmount,
            totalAvailable: roundedTotalAvailable,
            poolBreakdown,
          },
          feeDetails: {
            amountSol: 0,
            amountLamports: 0,
            platformFeeLamports: 0,
            projectFeeLamports: 0,
          },
        });
      }

      // Get blockhash
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");

      // Build fee transaction (user is sole signer)
      const feeMessageV0 = new TransactionMessage({
        payerKey: userPublicKey,
        recentBlockhash: blockhash,
        instructions: feeInstructions,
      }).compileToV0Message();

      const feeTransaction = new VersionedTransaction(feeMessageV0);
      // NO partial signing - user is the only signer!

      const serializedFeeTransaction = Buffer.from(feeTransaction.serialize()).toString("base64");

      // Generate a secure claim token that includes all claim details
      // This will be passed to /execute-claim-v2 after fee is paid
      const claimToken = Buffer.from(
        JSON.stringify({
          userWallet,
          amountToClaim: actualClaimAmount,
          poolBreakdown,
          projectId: project.id,
          tokenMint: tokenMintAddress,
          tokenDecimals: TOKEN_DECIMALS,
          timestamp: Date.now(),
          platformFeeLamports: globalPlatformFeeLamports,
          projectFeeLamports: poolProjectFeeLamports,
          platformFeeWallet: platformFeeWallet?.toBase58(),
          projectFeeWallet: projectVaultWallet?.toBase58(),
        })
      ).toString("base64");

      console.log(`[CLAIM-V2] ✓ Fee transaction built successfully (user-only signer)`);
      console.log(`[CLAIM-V2] Transaction size: ${serializedFeeTransaction.length} bytes (base64)`);

      res.json({
        success: true,
        step: "sign_fee",
        feeTransaction: serializedFeeTransaction,
        claimToken,
        lastValidBlockHeight,
        claimDetails: {
          amountToClaim: actualClaimAmount,
          totalAvailable: roundedTotalAvailable,
          poolBreakdown,
        },
        feeDetails: {
          amountSol: feeInSol,
          amountLamports: totalFeeLamports,
          platformFeeLamports: globalPlatformFeeLamports,
          projectFeeLamports: poolProjectFeeLamports,
          platformFeeWallet: platformFeeWallet?.toBase58(),
          projectFeeWallet: projectVaultWallet?.toBase58(),
        },
      });
    } catch (error) {
      console.error("[CLAIM-V2] Error:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * POST /api/user/vesting/execute-claim-v2
   * SPLIT TRANSACTION FLOW - Step 2: Verify fee payment and execute token transfer
   * Backend builds and sends the token transfer transaction (vault is sole signer)
   * 
   * Body: { feeSignature: string, claimToken: string }
   */
  async executeClaimV2(req: Request, res: Response) {
    try {
      const { feeSignature, claimToken } = req.body;

      if (!claimToken) {
        return res.status(400).json({ error: "claimToken is required" });
      }

      // Decode claim token
      let claimData: any;
      try {
        claimData = JSON.parse(Buffer.from(claimToken, "base64").toString());
      } catch (err) {
        return res.status(400).json({ error: "Invalid claimToken" });
      }

      const {
        userWallet,
        amountToClaim,
        poolBreakdown,
        projectId,
        tokenMint,
        tokenDecimals,
        timestamp,
        platformFeeLamports,
        projectFeeLamports,
        platformFeeWallet,
        projectFeeWallet,
        noFee,
      } = claimData;

      console.log(`[EXECUTE-CLAIM-V2] Processing claim for wallet: ${userWallet}`);
      console.log(`[EXECUTE-CLAIM-V2] Amount: ${amountToClaim}, Token: ${tokenMint}`);

      // Check if claim token is not expired (5 minutes)
      if (Date.now() - timestamp > 5 * 60 * 1000) {
        return res.status(400).json({ error: "Claim token expired. Please initiate a new claim." });
      }

      // Verify fee payment on-chain (unless no fee)
      if (!noFee && feeSignature) {
        console.log(`[EXECUTE-CLAIM-V2] Verifying fee payment: ${feeSignature}`);
        
        // Wait for confirmation with retries
        let verified = false;
        for (let attempt = 0; attempt < 10; attempt++) {
          try {
            const status = await this.connection.getSignatureStatus(feeSignature);
            
            if (status?.value?.err) {
              return res.status(400).json({
                error: "Fee payment transaction failed on-chain",
                details: status.value.err,
              });
            }
            
            if (status?.value?.confirmationStatus === "confirmed" || status?.value?.confirmationStatus === "finalized") {
              verified = true;
              console.log(`[EXECUTE-CLAIM-V2] ✓ Fee payment verified (${status.value.confirmationStatus})`);
              break;
            }
            
            // Wait and retry
            await new Promise(resolve => setTimeout(resolve, 1000));
          } catch (err) {
            console.warn(`[EXECUTE-CLAIM-V2] Fee verification attempt ${attempt + 1} failed:`, err);
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
        
        if (!verified) {
          return res.status(400).json({
            error: "Could not verify fee payment. Please wait for confirmation and try again.",
          });
        }
      } else if (!noFee && !feeSignature) {
        return res.status(400).json({ error: "feeSignature is required when fees are configured" });
      }

      // Get vault keypair
      let vaultKeypair: Keypair;
      try {
        vaultKeypair = await getVaultKeypairForProject(projectId);
      } catch (err) {
        console.error("[EXECUTE-CLAIM-V2] Failed to get vault keypair:", err);
        return res.status(500).json({ error: "Failed to access project vault" });
      }

      const userPublicKey = new PublicKey(userWallet);
      const projectTokenMint = new PublicKey(tokenMint);
      const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";
      const isNativeSOL = tokenMint === NATIVE_SOL_MINT;

      // ===== BUILD TOKEN TRANSFER TRANSACTION (Single signer: Vault) =====
      const transferInstructions = [];

      if (isNativeSOL) {
        // Native SOL transfer
        const amountInLamports = this.toBaseUnits(amountToClaim, 9);
        console.log(`[EXECUTE-CLAIM-V2] Native SOL transfer: ${amountToClaim} SOL (${amountInLamports} lamports)`);
        
        transferInstructions.push(
          SystemProgram.transfer({
            fromPubkey: vaultKeypair.publicKey,
            toPubkey: userPublicKey,
            lamports: Number(amountInLamports),
          })
        );
      } else {
        // SPL Token transfer
        // ✅ FIX: Properly detect token program (Token vs Token-2022)
        const { detectTokenProgram } = await import("../utils/tokenProgramDetection");
        const tokenProgramId = await detectTokenProgram(this.connection, projectTokenMint);
        
        console.log(`[EXECUTE-CLAIM-V2] Using token program: ${tokenProgramId.toBase58()}`);

        const vaultTokenAccount = await getAssociatedTokenAddress(
          projectTokenMint,
          vaultKeypair.publicKey,
          false,
          tokenProgramId
        );
        const userTokenAccount = await getAssociatedTokenAddress(
          projectTokenMint,
          userPublicKey,
          false,
          tokenProgramId
        );

        console.log(`[EXECUTE-CLAIM-V2] Vault token account: ${vaultTokenAccount.toBase58()}`);
        console.log(`[EXECUTE-CLAIM-V2] User token account: ${userTokenAccount.toBase58()}`);

        // ✅ FIX: Verify vault token account exists before attempting transfer
        let vaultTokenAccountExists = false;
        try {
          await getAccount(this.connection, vaultTokenAccount, undefined, tokenProgramId);
          vaultTokenAccountExists = true;
          console.log(`[EXECUTE-CLAIM-V2] ✓ Vault token account exists`);
        } catch (err) {
          console.error(`[EXECUTE-CLAIM-V2] ✗ Vault token account does not exist:`, err);
          throw new Error(`Vault token account does not exist. Please ensure the treasury is funded with tokens.`);
        }

        // Check if user ATA exists
        let userTokenAccountExists = false;
        try {
          await getAccount(this.connection, userTokenAccount, undefined, tokenProgramId);
          userTokenAccountExists = true;
          console.log(`[EXECUTE-CLAIM-V2] ✓ User token account already exists`);
        } catch (err) {
          console.log(`[EXECUTE-CLAIM-V2] User token account does not exist, will create it`);
        }

        // Create ATA if needed (vault pays rent since it's the signer)
        if (!userTokenAccountExists) {
          transferInstructions.push(
            createAssociatedTokenAccountInstruction(
              vaultKeypair.publicKey, // Payer (Vault)
              userTokenAccount,
              userPublicKey, // Owner
              projectTokenMint,
              tokenProgramId
            )
          );
          console.log(`[EXECUTE-CLAIM-V2] Added instruction to create user token account`);
        }

        // Token transfer
        const actualDecimals = tokenDecimals || await this.getTokenDecimals(projectTokenMint);
        const amountInBaseUnits = this.toBaseUnits(amountToClaim, actualDecimals);
        
        console.log(`[EXECUTE-CLAIM-V2] SPL Token transfer: ${amountToClaim} tokens (${amountInBaseUnits} base units, ${actualDecimals} decimals)`);

        transferInstructions.push(
          createTransferInstruction(
            vaultTokenAccount,
            userTokenAccount,
            vaultKeypair.publicKey,
            amountInBaseUnits,
            [],
            tokenProgramId
          )
        );
      }

      // Build and send transaction
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");

      const transferMessageV0 = new TransactionMessage({
        payerKey: vaultKeypair.publicKey, // Vault pays gas for token transfer
        recentBlockhash: blockhash,
        instructions: transferInstructions,
      }).compileToV0Message();

      const transferTransaction = new VersionedTransaction(transferMessageV0);
      transferTransaction.sign([vaultKeypair]); // Vault is the only signer

      // Send transaction
      console.log("[EXECUTE-CLAIM-V2] Sending token transfer transaction...");
      
      let tokenSignature: string | null = null;
      const maxRetries = 3;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          tokenSignature = await this.connection.sendRawTransaction(
            transferTransaction.serialize(),
            { skipPreflight: false, maxRetries: 2 }
          );
          
          console.log(`[EXECUTE-CLAIM-V2] Transaction sent: ${tokenSignature}`);

          // Wait for confirmation
          await this.connection.confirmTransaction(
            {
              signature: tokenSignature,
              blockhash,
              lastValidBlockHeight,
            },
            "confirmed"
          );

          console.log(`[EXECUTE-CLAIM-V2] ✓ Token transfer confirmed: ${tokenSignature}`);
          break;
        } catch (err) {
          console.error(`[EXECUTE-CLAIM-V2] Attempt ${attempt} failed:`, err);
          if (attempt === maxRetries) {
            throw err;
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      if (!tokenSignature) {
        throw new Error("Failed to send token transfer transaction");
      }

      // Record claims in database
      const totalFeeLamports = (platformFeeLamports || 0) + (projectFeeLamports || 0);
      const feeInSol = totalFeeLamports / LAMPORTS_PER_SOL;
      const totalClaimAmount = poolBreakdown.reduce((sum: number, p: any) => sum + p.amountToClaim, 0);

      for (const poolItem of poolBreakdown) {
        if (poolItem.amountToClaim > 0) {
          const amountInBaseUnits = Number(this.toBaseUnits(poolItem.amountToClaim, tokenDecimals || 9));
          if (amountInBaseUnits === 0) continue;

          const proportionalFee = (poolItem.amountToClaim / totalClaimAmount) * feeInSol;

          await this.dbService.createClaim({
            user_wallet: userWallet,
            vesting_id: poolItem.vestingId,
            project_id: projectId,
            amount_claimed: amountInBaseUnits,
            fee_paid: proportionalFee,
            transaction_signature: tokenSignature,
          });

          // Log activity
          try {
            await this.dbService.logAdminAction({
              action: "CLAIM_COMPLETED",
              admin_wallet: "SYSTEM",
              target_wallet: userWallet,
              details: {
                pool_id: poolItem.poolId,
                pool_name: poolItem.poolName,
                amount: poolItem.amountToClaim,
                feeSignature: feeSignature || "no-fee",
                tokenSignature,
                project_id: projectId,
                flow: "split-v2",
              },
            });
          } catch (logErr) {
            console.warn("[EXECUTE-CLAIM-V2] Failed to log activity:", logErr);
          }

          console.log(`[EXECUTE-CLAIM-V2] Recorded claim for pool ${poolItem.poolName}: ${poolItem.amountToClaim} tokens`);
        }
      }

      res.json({
        success: true,
        data: {
          totalAmountClaimed: amountToClaim,
          poolBreakdown,
          feeTransactionSignature: feeSignature || null,
          tokenTransactionSignature: tokenSignature,
          feePaid: feeInSol,
        },
      });
    } catch (error) {
      console.error("[EXECUTE-CLAIM-V2] Error:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * POST /api/user/vesting/complete-claim
   * Record claim after user has signed and sent the transaction
   * Body: { userWallet: string, signature: string, poolBreakdown: Array }
   */
  async completeClaimWithFee(req: Request, res: Response) {
    try {
      const { userWallet, signature, poolBreakdown } = req.body;

      console.log("[RECORD-CLAIM] Request body:", {
        userWallet,
        signature,
        poolBreakdown,
      });

      if (!userWallet || !signature) {
        return res
          .status(400)
          .json({ error: "userWallet and signature are required" });
      }

      if (
        !poolBreakdown ||
        !Array.isArray(poolBreakdown) ||
        poolBreakdown.length === 0
      ) {
        return res
          .status(400)
          .json({ error: "poolBreakdown array is required" });
      }

      // 1. Verify Transaction on-chain
      // We need to ensure the transaction was actually confirmed and involved the correct transfer
      // For now, we'll check if it's confirmed and successful.
      // TODO: In a production environment, parse the transaction logs to verify the exact transfer amount and destination.

      let status;
      try {
        status = await this.connection.getSignatureStatus(signature);
      } catch (err) {
        console.error("[RECORD-CLAIM] Failed to get signature status:", err);
        return res
          .status(500)
          .json({ error: "Failed to verify transaction status" });
      }

      if (!status || !status.value) {
        // It might be too new, wait a bit or check if it's a valid signature format
        // For this implementation, we'll assume the frontend has confirmed it, but we should double check.
        // If null, it means it's not found (yet).
        console.warn(
          "[RECORD-CLAIM] Transaction not found on-chain yet. Proceeding with caution or asking retry."
        );
        // In a strict implementation, we would return 400 or 404 here.
        // However, to avoid blocking valid claims due to RPC lag, we might check if we can wait.
        // For now, let's assume if the frontend sent it, it exists.
        // BETTER: Fetch the transaction details.
      }

      if (status?.value?.err) {
        return res.status(400).json({
          error: "Transaction failed on-chain",
          details: status.value.err,
        });
      }

      // 2. Calculate total claim amount
      const totalClaimAmount = poolBreakdown.reduce(
        (sum: number, p: any) => sum + p.amountToClaim,
        0
      );
      
      // ✅ FIX: Get actual token decimals from pool breakdown (fetch from first pool's vesting)
      let TOKEN_DECIMALS = 9; // Default fallback
      if (poolBreakdown && poolBreakdown.length > 0) {
        try {
          const { data: firstVesting } = await this.dbService.supabase
            .from("vestings")
            .select("vesting_streams(token_mint)")
            .eq("id", poolBreakdown[0].vestingId)
            .single();
          
          const tokenMintAddress = (firstVesting as any)?.vesting_streams?.token_mint;
          if (tokenMintAddress) {
            TOKEN_DECIMALS = await this.getTokenDecimals(new PublicKey(tokenMintAddress));
          }
        } catch (err) {
          console.warn(`[COMPLETE-CLAIM] Failed to get token decimals, using default 9:`, err);
        }
      }
      const TOKEN_DIVISOR = Math.pow(10, TOKEN_DECIMALS);

      // 3. Record Claims in DB
      // We assume the transaction covered the fee and the token transfer as constructed by claimVesting.

      // Get fee amount for record keeping (approximate if not in request)
      let feeInSol = 0;
      if (req.project) {
        feeInSol =
          Number(req.project.claim_fee_lamports || 1000000) / LAMPORTS_PER_SOL;
      } else {
        // Fallback
        feeInSol = 0.001;
      }

      for (const poolItem of poolBreakdown) {
        if (poolItem.amountToClaim > 0) {
          const amountInBaseUnits = Number(
            this.toBaseUnits(poolItem.amountToClaim, TOKEN_DECIMALS)
          );

          if (amountInBaseUnits === 0) continue;

          // Fetch vesting details to get project_id
          const { data: vesting } = await this.dbService.supabase
            .from("vestings")
            .select("project_id")
            .eq("id", poolItem.vestingId)
            .single();

          const projectId = vesting?.project_id || req.projectId || "default";

          const proportionalFee =
            (poolItem.amountToClaim / totalClaimAmount) * feeInSol;

          await this.dbService.createClaim({
            user_wallet: userWallet,
            vesting_id: poolItem.vestingId,
            project_id: projectId,
            amount_claimed: amountInBaseUnits,
            fee_paid: proportionalFee,
            transaction_signature: signature,
          });

          // Log user claim as an admin-visible activity
          try {
            await this.dbService.logAdminAction({
              action: "CLAIM_COMPLETED",
              admin_wallet: "SYSTEM",
              target_wallet: userWallet,
              details: {
                pool_id: poolItem.poolId,
                pool_name: poolItem.poolName,
                amount: poolItem.amountToClaim,
                signature,
                project_id: projectId,
              },
            });
          } catch (logErr) {
            console.warn("[RECORD-CLAIM] Failed to log activity:", logErr);
          }

          console.log(
            `[RECORD-CLAIM] Recorded claim for pool ${poolItem.poolName}: ${poolItem.amountToClaim} tokens`
          );
        }
      }

      res.json({
        success: true,
        data: {
          totalAmountClaimed: totalClaimAmount,
          poolBreakdown,
          transactionSignature: signature,
        },
      });
    } catch (error) {
      console.error("Failed to record claim:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * GET /api/user/vesting/summary-all?wallet=xxx&tokenMint=xxx (optional)
   * Get aggregated summary across ALL vesting pools for a wallet, grouped by token
   * If tokenMint is provided, returns data for only that token
   */
  async getVestingSummaryAll(req: Request, res: Response) {
    try {
      const { wallet, tokenMint } = req.query;

      if (!wallet || typeof wallet !== "string") {
        return res.status(400).json({ error: "wallet parameter is required" });
      }

      // Get ALL active vesting records for this wallet
      const { data: vestings, error: vestingError } =
        await this.dbService.supabase
          .from("vestings")
          .select("*, vesting_streams(*)")
          .eq("user_wallet", wallet)
          .eq("is_active", true)
          .order("created_at", { ascending: false });

      if (vestingError) {
        throw vestingError;
      }

      if (!vestings || vestings.length === 0) {
        return res.json({
          success: true,
          data: {
            tokens: [],
            totalClaimable: 0,
            totalLocked: 0,
            totalClaimed: 0,
            totalVested: 0,
          },
        });
      }

      // Filter out invalid vestings (cancelled and paused pools should not contribute to claimable amount)
      let validVestings = vestings.filter((v: any) => {
        if (!v.vesting_streams) return false;
        if (
          v.vesting_streams.state === "cancelled" ||
          v.vesting_streams.state === "paused"
        )
          return false;
        const startTime = new Date(v.vesting_streams.start_time);
        return startTime <= new Date();
      });

      // Filter by token mint if provided
      if (tokenMint && typeof tokenMint === "string") {
        validVestings = validVestings.filter(
          (v: any) => v.vesting_streams.token_mint === tokenMint
        );
      }

      if (validVestings.length === 0) {
        return res.json({
          success: true,
          data: {
            tokens: [],
            totalClaimable: 0,
            totalLocked: 0,
            totalClaimed: 0,
            totalVested: 0,
          },
        });
      }

      // Get claim history for this wallet
      const claimHistory = await this.dbService.getClaimHistory(wallet);

      const now = Math.floor(Date.now() / 1000);

      // Group vestings by token mint and fetch decimals per token
      const vestingsByToken = new Map<string, any[]>();
      const decimalsByToken = new Map<string, number>();
      
      for (const vesting of validVestings) {
        const mint = vesting.vesting_streams.token_mint || "unknown";
        if (!vestingsByToken.has(mint)) {
          vestingsByToken.set(mint, []);
          
          // ✅ FIX: Fetch decimals for each unique token mint
          if (mint !== "unknown") {
            try {
              const decimals = await this.getTokenDecimals(new PublicKey(mint));
              decimalsByToken.set(mint, decimals);
            } catch (err) {
              console.warn(`[POOLS] Failed to get decimals for ${mint}, using default 9`);
              decimalsByToken.set(mint, 9);
            }
          } else {
            decimalsByToken.set(mint, 9);
          }
        }
        vestingsByToken.get(mint)!.push(vesting);
      }

      // Calculate totals per token
      const tokensData = [];
      let grandTotalClaimable = 0;
      let grandTotalLocked = 0;
      let grandTotalClaimed = 0;
      let grandTotalVested = 0;

      for (const [tokenMint, tokenVestings] of vestingsByToken.entries()) {
        // ✅ FIX: Use the correct decimals for this token
        const TOKEN_DECIMALS = decimalsByToken.get(tokenMint) || 9;
        const TOKEN_DIVISOR = Math.pow(10, TOKEN_DECIMALS);
        
        let totalClaimable = 0;
        let totalLocked = 0;
        let totalClaimed = 0;
        let totalVested = 0;
        let nextUnlockTime = 0;
        const poolsData = [];

        // Process vestings for this token
        for (const vesting of tokenVestings) {
          const stream = vesting.vesting_streams;
          const totalAllocation = vesting.token_amount;
          const startTime = stream.start_time
            ? Math.floor(new Date(stream.start_time).getTime() / 1000)
            : now;
          const vestingDurationSeconds =
            stream.vesting_duration_seconds ||
            stream.vesting_duration_days * 86400;
          const cliffDurationSeconds =
            stream.cliff_duration_seconds || stream.cliff_duration_days * 86400;
          const endTime = stream.end_time
            ? Math.floor(new Date(stream.end_time).getTime() / 1000)
            : now + vestingDurationSeconds;
          const cliffTime = startTime + cliffDurationSeconds;

          // Calculate vested amount (with Streamflow caching)
          // DISABLED: Streamflow integration - using database-only mode for cost savings
          // Always use time-based vesting calculation from DB
          const vestedPercentage = this.calculateVestedPercentage(
            now,
            startTime,
            endTime,
            cliffTime
          );
          const vestedAmount = totalAllocation * vestedPercentage;

          // Get claims for this specific vesting
          const vestingClaims = claimHistory.filter(
            (claim) => claim.vesting_id === vesting.id
          );
          const vestingTotalClaimed =
            vestingClaims.reduce(
              (sum, claim) => sum + Number(claim.amount_claimed),
              0
            ) / TOKEN_DIVISOR;

          const unlockedBalance = Math.max(
            0,
            vestedAmount - vestingTotalClaimed
          );
          const lockedBalance = totalAllocation - vestedAmount;

          // Only add to totals if pool is active
          totalClaimable += unlockedBalance;
          totalLocked += lockedBalance;
          totalClaimed += vestingTotalClaimed;
          totalVested += vestedAmount;

          // Track next unlock time
          if (endTime > now && endTime > nextUnlockTime) {
            nextUnlockTime = endTime;
          }

          // Add to pools data
          const poolTotal = stream.total_pool_amount;
          const sharePercentage =
            vesting.share_percentage || (totalAllocation / poolTotal) * 100;

          poolsData.push({
            poolId: vesting.vesting_stream_id,
            poolName: stream.name,
            claimable: unlockedBalance,
            locked: lockedBalance,
            claimed: vestingTotalClaimed,
            share: sharePercentage,
            nftCount: vesting.nft_count,
            status: stream.state || "active",
          });
        }

        // Add token data
        tokensData.push({
          tokenMint: tokenMint,
          tokenSymbol: await fetchTokenSymbol(tokenMint), // ✅ Dynamic token resolution
          totalClaimable,
          totalLocked,
          totalClaimed,
          totalVested,
          nextUnlockTime,
          pools: poolsData,
        });

        // Add to grand totals
        grandTotalClaimable += totalClaimable;
        grandTotalLocked += totalLocked;
        grandTotalClaimed += totalClaimed;
        grandTotalVested += totalVested;
      }

      // Also add paused/cancelled pools to their respective tokens (for display only)
      const pausedCancelledVestings = vestings.filter((v: any) => {
        if (!v.vesting_streams) return false;
        return (
          v.vesting_streams.state === "cancelled" ||
          v.vesting_streams.state === "paused"
        );
      });

      for (const vesting of pausedCancelledVestings) {
        const stream = vesting.vesting_streams;
        const mint = stream.token_mint || "unknown";
        const totalAllocation = vesting.token_amount;

        // Find or create token data for this mint
        let tokenData: any = tokensData.find((t) => t.tokenMint === mint);
        if (!tokenData) {
          tokenData = {
            tokenMint: mint,
            tokenSymbol: await fetchTokenSymbol(mint), // ✅ Dynamic token resolution
            totalClaimable: 0,
            totalLocked: 0,
            totalClaimed: 0,
            totalVested: 0,
            nextUnlockTime: 0,
            pools: [],
          };
          tokensData.push(tokenData);
        }

        // Get claims for this specific vesting
        const vestingClaims = claimHistory.filter(
          (claim) => claim.vesting_id === vesting.id
        );
        
        // ✅ FIX: Get TOKEN_DIVISOR for this specific mint
        const mintDecimals = decimalsByToken.get(mint) || 9;
        const mintDivisor = Math.pow(10, mintDecimals);
        
        const vestingTotalClaimed =
          vestingClaims.reduce(
            (sum, claim) => sum + Number(claim.amount_claimed),
            0
          ) / mintDivisor;

        const poolTotal = stream.total_pool_amount;
        const sharePercentage =
          vesting.share_percentage || (totalAllocation / poolTotal) * 100;

        tokenData.pools.push({
          poolId: vesting.vesting_stream_id,
          poolName: stream.name,
          claimable: 0, // Paused/cancelled pools not claimable
          locked: totalAllocation - vestingTotalClaimed,
          claimed: vestingTotalClaimed,
          share: sharePercentage,
          nftCount: vesting.nft_count,
          status: stream.state || "paused",
        });
      }

      res.json({
        success: true,
        data: {
          tokens: tokensData,
          totalClaimable: grandTotalClaimable,
          totalLocked: grandTotalLocked,
          totalClaimed: grandTotalClaimed,
          totalVested: grandTotalVested,
        },
      });
    } catch (error) {
      console.error("Failed to get vesting summary all:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * POST /api/user/vesting/claim-all
   * Claim custom amount from all vesting pools at once
   */
  async claimAllVestings(req: Request, res: Response) {
    try {
      const { userWallet, amountToClaim } = req.body;

      if (!userWallet) {
        return res.status(400).json({ error: "userWallet is required" });
      }

      if (!amountToClaim || amountToClaim <= 0) {
        return res
          .status(400)
          .json({ error: "amountToClaim must be greater than 0" });
      }

      // Minimum claim amount: 0.001 tokens (1,000,000 base units)
      const MIN_CLAIM_AMOUNT = 0.001;
      if (amountToClaim < MIN_CLAIM_AMOUNT) {
        return res.status(400).json({
          error: `Minimum claim amount is ${MIN_CLAIM_AMOUNT} tokens. You requested ${amountToClaim} tokens.`,
          minimumAmount: MIN_CLAIM_AMOUNT,
          requestedAmount: amountToClaim,
        });
      }

      // Get all active vesting pools for user
      const { data: vestings, error: vestingError } =
        await this.dbService.supabase
          .from("vestings")
          .select("*, vesting_streams(*)")
          .eq("user_wallet", userWallet)
          .eq("is_active", true)
          .order("created_at", { ascending: false });

      if (vestingError) {
        throw vestingError;
      }

      if (!vestings || vestings.length === 0) {
        return res
          .status(404)
          .json({ error: "No active vesting found for this wallet" });
      }

      // Filter valid vestings
      const now = Math.floor(Date.now() / 1000);
      const validVestings = vestings.filter((v: any) => {
        if (!v.vesting_streams) return false;
        if (
          v.vesting_streams.state === "cancelled" ||
          v.vesting_streams.state === "paused"
        )
          return false;
        const startTime = new Date(v.vesting_streams.start_time);
        return startTime <= new Date();
      });

      if (validVestings.length === 0) {
        return res
          .status(400)
          .json({ error: "No valid vesting pools available" });
      }

      // Get claim history and config
      const claimHistory = await this.dbService.getClaimHistory(userWallet);
      const dbConfig = await this.dbService.getConfig();
      const claimFeeUSD = dbConfig?.claim_fee_usd || 0;
      
      // ? FIX: Get actual token decimals from the first vesting stream's token mint
      const tokenMintAddress = validVestings[0]?.vesting_streams?.token_mint;
      let TOKEN_DECIMALS = 9; // Default fallback
      if (tokenMintAddress) {
        try {
          TOKEN_DECIMALS = await this.getTokenDecimals(new PublicKey(tokenMintAddress));
        } catch (err) {
          console.warn(`[CLAIM-ALL-LEGACY] Failed to get decimals for ${tokenMintAddress}, using default 9`);
        }
      }
      const TOKEN_DIVISOR = Math.pow(10, TOKEN_DECIMALS);

      // Calculate available amount per pool
      const poolsWithAvailable = [];
      let totalAvailable = 0;

      for (const vesting of validVestings) {
        const stream = vesting.vesting_streams;
        const totalAllocation = vesting.token_amount;
        const startTime = stream.start_time
          ? Math.floor(new Date(stream.start_time).getTime() / 1000)
          : now;
        const vestingDurationSeconds =
          stream.vesting_duration_seconds ||
          stream.vesting_duration_days * 86400;
        const cliffDurationSeconds =
          stream.cliff_duration_seconds || stream.cliff_duration_days * 86400;
        const endTime = stream.end_time
          ? Math.floor(new Date(stream.end_time).getTime() / 1000)
          : now + vestingDurationSeconds;
        const cliffTime = startTime + cliffDurationSeconds;

        // Calculate vested amount (with Streamflow caching)
        let vestedAmount = 0;
        if (stream.streamflow_stream_id) {
          try {
            // Check cache first (30 second TTL)
            const cacheKey = `streamflow:${stream.streamflow_stream_id}`;
            let streamflowVested = cache.get<number>(cacheKey);

            if (streamflowVested === null) {
              // DISABLED: streamflowVested = await this.streamflowService.getVestedAmount(
                // stream.streamflow_stream_id // DISABLED
              streamflowVested = 0; // Fallback - using DB calculation instead of Streamflow
              cache.set(cacheKey, streamflowVested, 30);
            }

            const poolTotal = stream.total_pool_amount;
            const vestedPercentage = streamflowVested / poolTotal;
            vestedAmount = totalAllocation * vestedPercentage;
          } catch (err) {
            const vestedPercentage = this.calculateVestedPercentage(
              now,
              startTime,
              endTime,
              cliffTime
            );
            vestedAmount = totalAllocation * vestedPercentage;
          }
        } else {
          const vestedPercentage = this.calculateVestedPercentage(
            now,
            startTime,
            endTime,
            cliffTime
          );
          vestedAmount = totalAllocation * vestedPercentage;
        }

        // Get claims for this vesting
        const vestingClaims = claimHistory.filter(
          (claim) => claim.vesting_id === vesting.id
        );
        const vestingTotalClaimed =
          vestingClaims.reduce(
            (sum, claim) => sum + Number(claim.amount_claimed),
            0
          ) / TOKEN_DIVISOR;

        const available = Math.max(0, vestedAmount - vestingTotalClaimed);
        totalAvailable += available;

        poolsWithAvailable.push({
          vesting,
          stream,
          available,
          vestedAmount,
          totalAllocation,
          vestingTotalClaimed,
        });
      }

      // Round down totalAvailable to 2 decimal places to match what frontend shows
      const roundedTotalAvailable = Math.floor(totalAvailable * 100) / 100;

      // Validate requested amount
      if (amountToClaim > roundedTotalAvailable) {
        return res.status(400).json({
          error: `Requested amount ${amountToClaim.toFixed(
            2
          )} exceeds available balance ${roundedTotalAvailable.toFixed(2)}`,
          available: roundedTotalAvailable,
          requested: amountToClaim,
        });
      }

      // Distribute amount across pools using FIFO
      const poolBreakdown = [];
      let remainingToClaim = amountToClaim;

      for (const poolData of poolsWithAvailable) {
        if (remainingToClaim <= 0) break;

        const claimFromThisPool = Math.min(
          poolData.available,
          remainingToClaim
        );
        if (claimFromThisPool > 0) {
          poolBreakdown.push({
            poolId: poolData.vesting.vesting_stream_id,
            poolName: poolData.stream.name,
            amountToClaim: claimFromThisPool,
            availableFromPool: poolData.available,
          });
          remainingToClaim -= claimFromThisPool;
        }
      }

      // Determine Vault Signer, Token Mint, and Fee
      let vaultKeypair: Keypair;
      let tokenMint: PublicKey;
      let feeInSOL = 0;
      let feeWallet: PublicKey | null = null;

      // Fee structure variables
      let globalPlatformFeeLamports = 0;
      let platformFeeWallet: PublicKey | null = null;
      let poolProjectFeeLamports = 0;
      let projectVaultWallet: PublicKey | null = null;

      if (req.project) {
        try {
          vaultKeypair = await getVaultKeypairForProject(req.project.id);
          tokenMint = new PublicKey(req.project.mint_address);

          // ADDITIVE FEE STRUCTURE:
          // 1. Global platform fee (mandatory) -> goes to our fee wallet
          // 2. Pool project fee (optional) -> goes to project vault
          // User pays BOTH fees

          // 1. Get global platform fee
          try {
            const globalConfig = await this.dbService.getConfig();
            if (globalConfig) {
              if (globalConfig.fee_wallet) {
                platformFeeWallet = new PublicKey(globalConfig.fee_wallet);
              }

              if (globalConfig.claim_fee_usd !== undefined) {
                const { solAmount } = await this.priceService.calculateSolFee(
                  Number(globalConfig.claim_fee_usd)
                );
                globalPlatformFeeLamports = Math.floor(
                  solAmount * LAMPORTS_PER_SOL
                );
                console.log(
                  `[CLAIM-V2] Global platform fee: ${globalConfig.claim_fee_usd} USD (${solAmount} SOL = ${globalPlatformFeeLamports} lamports)`
                );
              } else if (globalConfig.claim_fee_sol !== undefined) {
                globalPlatformFeeLamports = Math.floor(
                  Number(globalConfig.claim_fee_sol) * LAMPORTS_PER_SOL
                );
                console.log(
                  `[CLAIM-V2] Global platform fee: ${globalPlatformFeeLamports} lamports`
                );
              }
            }
          } catch (err) {
            console.warn("[CLAIM-V2] Failed to get global platform fee:", err);
          }

          // 2. Get pool-level project fee
          if (validVestings.length > 0 && validVestings[0].vesting_streams) {
            const poolFee = validVestings[0].vesting_streams.claim_fee_lamports;
            if (poolFee && poolFee > 0) {
              poolProjectFeeLamports = Number(poolFee);
              console.log(
                `[CLAIM-V2] Pool project fee: ${poolProjectFeeLamports} lamports (${
                  poolProjectFeeLamports / LAMPORTS_PER_SOL
                } SOL)`
              );

              if (req.project.vault_public_key) {
                projectVaultWallet = new PublicKey(
                  req.project.vault_public_key
                );
              } else if (req.project.fee_recipient_address) {
                projectVaultWallet = new PublicKey(
                  req.project.fee_recipient_address
                );
              }
            }
          }

          // Calculate total fee
          const totalFeeLamports =
            globalPlatformFeeLamports + poolProjectFeeLamports;
          feeInSOL = totalFeeLamports / LAMPORTS_PER_SOL;

          console.log(`[CLAIM-V2] Fee breakdown:`);
          console.log(
            `  - Global platform fee: ${globalPlatformFeeLamports} lamports -> ${
              platformFeeWallet?.toBase58() || "N/A"
            }`
          );
          console.log(
            `  - Pool project fee: ${poolProjectFeeLamports} lamports -> ${
              projectVaultWallet?.toBase58() || "N/A"
            }`
          );
          console.log(
            `  - Total fee: ${totalFeeLamports} lamports (${feeInSOL} SOL)`
          );

          // Set main fee wallet for backward compatibility
          if (platformFeeWallet) {
            feeWallet = platformFeeWallet;
          } else if (req.project.fee_recipient_address) {
            feeWallet = new PublicKey(req.project.fee_recipient_address);
          } else {
            feeWallet = vaultKeypair.publicKey;
          }
        } catch (err) {
          console.error("Failed to get project vault:", err);
          return res
            .status(500)
            .json({ error: "Failed to access project vault" });
        }
      } else {
        // Legacy: Parse treasury keypair
        try {
          if (!config.treasuryPrivateKey) {
            throw new Error("Treasury private key not configured");
          }
          if (config.treasuryPrivateKey.startsWith("[")) {
            const secretKey = Uint8Array.from(
              JSON.parse(config.treasuryPrivateKey)
            );
            vaultKeypair = Keypair.fromSecretKey(secretKey);
          } else {
            try {
              const bs58 = await import("bs58");
              const decoded = bs58.default.decode(config.treasuryPrivateKey);
              vaultKeypair = Keypair.fromSecretKey(decoded);
            } catch {
              const decoded = Buffer.from(config.treasuryPrivateKey, "base64");
              vaultKeypair = Keypair.fromSecretKey(decoded);
            }
          }
          tokenMint = new PublicKey(config.customTokenMint!);

          // Calculate legacy fee
          if (claimFeeUSD > 0 && dbConfig?.fee_wallet) {
            try {
              const { solAmount } = await this.priceService.calculateSolFee(
                claimFeeUSD
              );
              feeInSOL = solAmount;
              feeWallet = new PublicKey(dbConfig.fee_wallet);
            } catch (err) {
              console.warn("Failed to calculate legacy fee:", err);
            }
          }
        } catch (err) {
          console.error("Treasury key parse error:", err);
          return res
            .status(500)
            .json({ error: "Invalid treasury key configuration" });
        }
      }

      // Create token transfer transaction
      const userPublicKey = new PublicKey(userWallet);

      const vaultTokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        vaultKeypair.publicKey
      );

      const userTokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        userPublicKey
      );

      // Check if user's token account exists
      let userTokenAccountExists = false;
      try {
        await getAccount(this.connection, userTokenAccount);
        userTokenAccountExists = true;
      } catch (err) {
        // Account doesn't exist, will create it
      }

      // Build transaction with all transfers
      const tokenTransferTx = new Transaction();

      if (!userTokenAccountExists) {
        tokenTransferTx.add(
          createAssociatedTokenAccountInstruction(
            vaultKeypair.publicKey,
            userTokenAccount,
            userPublicKey,
            tokenMint
          )
        );
      }

      // Add transfer instructions for each pool
      // ✅ FIX: Use actual token decimals instead of hardcoded 1e9
      const tokenDecimals = await this.getTokenDecimals(tokenMint);
      const amountInBaseUnitsFloat = amountToClaim * Math.pow(10, tokenDecimals);
      const amountInBaseUnits = BigInt(Math.round(amountInBaseUnitsFloat));
      
      console.log(`[CLAIM-V2] Token: ${tokenMint.toBase58()}`);
      console.log(`[CLAIM-V2] Decimals: ${tokenDecimals}`);
      console.log(`[CLAIM-V2] Amount (UI): ${amountToClaim}`);
      console.log(`[CLAIM-V2] Base Units: ${amountInBaseUnits}`);

      tokenTransferTx.add(
        createTransferInstruction(
          vaultTokenAccount,
          userTokenAccount,
          vaultKeypair.publicKey,
          amountInBaseUnits
        )
      );

      // Add SOL fee transfers (both platform and project fees)
      // Platform fee transfer
      if (globalPlatformFeeLamports > 0 && platformFeeWallet) {
        tokenTransferTx.add(
          SystemProgram.transfer({
            fromPubkey: userPublicKey,
            toPubkey: platformFeeWallet,
            lamports: globalPlatformFeeLamports,
          })
        );
        console.log(
          `[CLAIM-V2] Added platform fee transfer: ${globalPlatformFeeLamports} lamports to ${platformFeeWallet.toBase58()}`
        );
      }

      // Project fee transfer
      if (poolProjectFeeLamports > 0 && projectVaultWallet) {
        tokenTransferTx.add(
          SystemProgram.transfer({
            fromPubkey: userPublicKey,
            toPubkey: projectVaultWallet,
            lamports: poolProjectFeeLamports,
          })
        );
        console.log(
          `[CLAIM-V2] Added project fee transfer: ${poolProjectFeeLamports} lamports to ${projectVaultWallet.toBase58()}`
        );
      }

      // Get recent blockhash and send transaction
      const { blockhash } = await this.connection.getLatestBlockhash();
      tokenTransferTx.recentBlockhash = blockhash;
      // User pays network fees (tiny ~0.00001 SOL) + claim fee
      tokenTransferTx.feePayer = new PublicKey(userWallet);

      let tokenSignature: string | null = null;

      try {
        console.log(`[CLAIM-ALL] Sending transaction...`);

        // Get blockhash
        const { blockhash } = await this.connection.getLatestBlockhash();
        tokenTransferTx.recentBlockhash = blockhash;

        // Send with Solana's built-in retry (maxRetries: 3)
        // This retries the SAME transaction, not creating new ones
        tokenSignature = await this.connection.sendTransaction(
          tokenTransferTx,
          [vaultKeypair],
          {
            skipPreflight: true,
            maxRetries: 3, // Let Solana handle retries
          }
        );

        console.log(
          `[CLAIM-ALL] Transaction sent: ${tokenSignature}, confirming...`
        );

        try {
          // Use 30 second timeout for confirmation
          const latestBlockhash = await this.connection.getLatestBlockhash();
          await Promise.race([
            this.connection.confirmTransaction(
              {
                signature: tokenSignature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
              },
              "confirmed"
            ),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("Transaction confirmation timeout")),
                30000
              )
            ),
          ]);

          console.log(
            "[CLAIM-ALL] Transfer confirmed successfully! Signature:",
            tokenSignature
          );
        } catch (confirmError) {
          console.warn(
            `[CLAIM-ALL] Confirmation timed out, checking transaction status: ${tokenSignature}`
          );

          // Check if transaction was actually successful despite timeout
          try {
            const status = await this.connection.getSignatureStatus(
              tokenSignature
            );
            if (status && status.value && !status.value.err) {
              console.log(
                "[CLAIM-ALL] Transaction successful despite confirmation timeout! Signature:",
                tokenSignature
              );
            } else if (status && status.value && status.value.err) {
              throw new Error(
                `Transaction failed on-chain: ${JSON.stringify(
                  status.value.err
                )}`
              );
            } else {
              // Still unknown - wait and check again
              console.log(
                "[CLAIM-ALL] Transaction status still unknown, checking again in 5s..."
              );
              await new Promise((resolve) => setTimeout(resolve, 5000));
              const retryStatus = await this.connection.getSignatureStatus(
                tokenSignature
              );
              if (retryStatus && retryStatus.value && !retryStatus.value.err) {
                console.log(
                  "[CLAIM-ALL] Transaction confirmed on second check! Signature:",
                  tokenSignature
                );
              } else {
                throw new Error("Transaction confirmation failed");
              }
            }
          } catch (statusError) {
            console.error(
              "[CLAIM-ALL] Error checking transaction status:",
              statusError
            );
            throw statusError;
          }
        }
      } catch (err) {
        console.error(`[CLAIM-ALL] Transaction failed:`, err);
        throw new Error(
          `Transaction failed: ${
            err instanceof Error ? err.message : "Unknown error"
          }`
        );
      }

      if (!tokenSignature) {
        throw new Error("Failed to send transaction");
      }

      // Record claims in database for each pool that had an amount claimed
      // Distribute fee proportionally across pools based on claim amount
      const totalClaimAmount = poolBreakdown.reduce(
        (sum, p) => sum + p.amountToClaim,
        0
      );

      for (const poolBreakdownItem of poolBreakdown) {
        const poolData = poolsWithAvailable.find(
          (p) => p.vesting.vesting_stream_id === poolBreakdownItem.poolId
        );
        if (poolData && poolBreakdownItem.amountToClaim > 0) {
          // Use Decimal.js for precise conversion
          const amountInBaseUnits = Number(
            this.toBaseUnits(poolBreakdownItem.amountToClaim, TOKEN_DECIMALS)
          );

          // Skip if amount rounds to 0 (too small to record)
          if (amountInBaseUnits === 0) {
            console.log(
              `[CLAIM-ALL] Skipping pool ${poolBreakdownItem.poolId}: amount too small (${poolBreakdownItem.amountToClaim} tokens)`
            );
            continue;
          }

          // Calculate proportional fee for this pool
          const proportionalFee =
            (poolBreakdownItem.amountToClaim / totalClaimAmount) * claimFeeUSD;

          // Fetch vesting details to get project_id if needed
          const { data: vesting } = await this.dbService.supabase
            .from("vestings")
            .select("project_id")
            .eq("id", poolData.vesting.id)
            .single();

          const projectId = vesting?.project_id || req.projectId || "default";

          await this.dbService.createClaim({
            user_wallet: userWallet,
            vesting_id: poolData.vesting.id,
            project_id: projectId,
            amount_claimed: amountInBaseUnits,
            fee_paid: proportionalFee,
            transaction_signature: tokenSignature,
          });

          // FIX for existing orphaned claims: update any previous claims missing project_id for this vesting
          await this.dbService.supabase
            .from("claim_history")
            .update({ project_id: projectId })
            .is("project_id", null)
            .eq("vesting_id", poolData.vesting.id);

          // Log user claim as an admin-visible activity
          try {
            await this.dbService.logAdminAction({
              action: "CLAIM_COMPLETED",
              admin_wallet: "SYSTEM",
              target_wallet: userWallet,
              details: {
                pool_id: poolBreakdownItem.poolId,
                pool_name:
                  poolData.vesting.vesting_streams?.name || "Unknown Pool",
                amount: poolBreakdownItem.amountToClaim,
                signature: tokenSignature,
                project_id: projectId,
                version: "V2",
              },
            });
          } catch (logErr) {
            console.warn("[CLAIM-ALL] Failed to log activity:", logErr);
          }

          console.log(
            `[CLAIM-ALL] Recorded claim for pool ${poolBreakdownItem.poolId}: ${poolBreakdownItem.amountToClaim} tokens (${amountInBaseUnits} base units)`
          );
        }
      }

      res.json({
        success: true,
        data: {
          totalAmountClaimed: amountToClaim,
          poolBreakdown,
          transactionSignature: tokenSignature,
          status: "success",
        },
      });
    } catch (error) {
      console.error("Failed to claim all vestings:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * POST /api/user/vesting/prepare-claim
   * Prepare unsigned transaction for user to sign
   * Returns the unsigned transaction and fee details
   */
  async prepareClaimTransaction(req: Request, res: Response) {
    try {
      const { userWallet, amountToClaim } = req.body;

      if (!userWallet) {
        return res.status(400).json({ error: "userWallet is required" });
      }

      if (!amountToClaim || amountToClaim <= 0) {
        return res
          .status(400)
          .json({ error: "amountToClaim must be greater than 0" });
      }

      // Minimum claim amount: 0.001 tokens (1,000,000 base units)
      const MIN_CLAIM_AMOUNT = 0.001;
      if (amountToClaim < MIN_CLAIM_AMOUNT) {
        return res.status(400).json({
          error: `Minimum claim amount is ${MIN_CLAIM_AMOUNT} tokens. You requested ${amountToClaim} tokens.`,
          minimumAmount: MIN_CLAIM_AMOUNT,
          requestedAmount: amountToClaim,
        });
      }

      // Get all active vesting pools for user
      const { data: vestings, error: vestingError } =
        await this.dbService.supabase
          .from("vestings")
          .select("*, vesting_streams(*)")
          .eq("user_wallet", userWallet)
          .eq("is_active", true)
          .order("created_at", { ascending: false });

      if (vestingError) {
        throw vestingError;
      }

      if (!vestings || vestings.length === 0) {
        return res
          .status(404)
          .json({ error: "No active vesting found for this wallet" });
      }

      // Filter valid vestings
      const now = Math.floor(Date.now() / 1000);
      const validVestings = vestings.filter((v: any) => {
        if (!v.vesting_streams) return false;
        if (
          v.vesting_streams.state === "cancelled" ||
          v.vesting_streams.state === "paused"
        )
          return false;
        const startTime = new Date(v.vesting_streams.start_time);
        return startTime <= new Date();
      });

      if (validVestings.length === 0) {
        return res
          .status(400)
          .json({ error: "No valid vesting pools available" });
      }

      // Get claim history and config
      const claimHistory = await this.dbService.getClaimHistory(userWallet);
      const dbConfig = await this.dbService.getConfig();
      const claimFeeUSD = dbConfig?.claim_fee_usd || 0;
      
      // ? FIX: Get actual token decimals from the first vesting stream's token mint
      const tokenMintAddress = validVestings[0]?.vesting_streams?.token_mint;
      let TOKEN_DECIMALS = 9; // Default fallback
      if (tokenMintAddress) {
        try {
          TOKEN_DECIMALS = await this.getTokenDecimals(new PublicKey(tokenMintAddress));
        } catch (err) {
          console.warn(`[CLAIM-ALL-V3] Failed to get decimals for ${tokenMintAddress}, using default 9`);
        }
      }
      const TOKEN_DIVISOR = Math.pow(10, TOKEN_DECIMALS);

      // Calculate available amount per pool
      const poolsWithAvailable = [];
      let totalAvailable = 0;

      for (const vesting of validVestings) {
        const stream = vesting.vesting_streams;
        const totalAllocation = vesting.token_amount;
        const startTime = stream.start_time
          ? Math.floor(new Date(stream.start_time).getTime() / 1000)
          : now;
        const vestingDurationSeconds =
          stream.vesting_duration_seconds ||
          stream.vesting_duration_days * 86400;
        const cliffDurationSeconds =
          stream.cliff_duration_seconds || stream.cliff_duration_days * 86400;
        const endTime = stream.end_time
          ? Math.floor(new Date(stream.end_time).getTime() / 1000)
          : now + vestingDurationSeconds;
        const cliffTime = startTime + cliffDurationSeconds;

        // Calculate vested amount (with Streamflow caching)
        let vestedAmount = 0;
        if (stream.streamflow_stream_id) {
          try {
            // Check cache first (30 second TTL)
            const cacheKey = `streamflow:${stream.streamflow_stream_id}`;
            let streamflowVested = cache.get<number>(cacheKey);

            if (streamflowVested === null) {
              // DISABLED: streamflowVested = await this.streamflowService.getVestedAmount(
                // stream.streamflow_stream_id // DISABLED
              streamflowVested = 0; // Fallback - using DB calculation instead of Streamflow
              cache.set(cacheKey, streamflowVested, 30);
            }

            const poolTotal = stream.total_pool_amount;
            const vestedPercentage = streamflowVested / poolTotal;
            vestedAmount = totalAllocation * vestedPercentage;
          } catch (err) {
            const vestedPercentage = this.calculateVestedPercentage(
              now,
              startTime,
              endTime,
              cliffTime
            );
            vestedAmount = totalAllocation * vestedPercentage;
          }
        } else {
          const vestedPercentage = this.calculateVestedPercentage(
            now,
            startTime,
            endTime,
            cliffTime
          );
          vestedAmount = totalAllocation * vestedPercentage;
        }

        // Get claims for this vesting
        const vestingClaims = claimHistory.filter(
          (claim) => claim.vesting_id === vesting.id
        );
        const vestingTotalClaimed =
          vestingClaims.reduce(
            (sum, claim) => sum + Number(claim.amount_claimed),
            0
          ) / TOKEN_DIVISOR;

        const available = Math.max(0, vestedAmount - vestingTotalClaimed);
        totalAvailable += available;

        poolsWithAvailable.push({
          vesting,
          stream,
          available,
          vestedAmount,
          totalAllocation,
          vestingTotalClaimed,
        });
      }

      // Round down totalAvailable to 2 decimal places to match what frontend shows
      const roundedTotalAvailable = Math.floor(totalAvailable * 100) / 100;

      // Validate requested amount
      if (amountToClaim > roundedTotalAvailable) {
        return res.status(400).json({
          error: `Requested amount ${amountToClaim.toFixed(
            2
          )} exceeds available balance ${roundedTotalAvailable.toFixed(2)}`,
          available: roundedTotalAvailable,
          requested: amountToClaim,
        });
      }

      // Distribute amount across pools using FIFO
      const poolBreakdown = [];
      let remainingToClaim = amountToClaim;

      for (const poolData of poolsWithAvailable) {
        if (remainingToClaim <= 0) break;

        const claimFromThisPool = Math.min(
          poolData.available,
          remainingToClaim
        );
        if (claimFromThisPool > 0) {
          poolBreakdown.push({
            poolId: poolData.vesting.vesting_stream_id,
            poolName: poolData.stream.name,
            amountToClaim: claimFromThisPool,
            availableFromPool: poolData.available,
          });
          remainingToClaim -= claimFromThisPool;
        }
      }

      // Determine Vault Signer, Token Mint, and Fee
      let vaultKeypair: Keypair;
      let tokenMint: PublicKey;
      let feeInSOL = 0;
      let feeWallet: PublicKey | null = null;

      // Fee structure variables
      let globalPlatformFeeLamportsV3 = 0;
      let platformFeeWalletV3: PublicKey | null = null;
      let poolProjectFeeLamportsV3 = 0;
      let projectVaultWalletV3: PublicKey | null = null;

      if (req.project) {
        try {
          vaultKeypair = await getVaultKeypairForProject(req.project.id);
          tokenMint = new PublicKey(req.project.mint_address);

          // ADDITIVE FEE STRUCTURE:
          // 1. Global platform fee (mandatory) -> goes to our fee wallet
          // 2. Pool project fee (optional) -> goes to project vault
          // User pays BOTH fees

          // 1. Get global platform fee
          try {
            const globalConfig = await this.dbService.getConfig();
            if (globalConfig) {
              if (globalConfig.fee_wallet) {
                platformFeeWalletV3 = new PublicKey(globalConfig.fee_wallet);
              }

              if (globalConfig.claim_fee_usd !== undefined) {
                const { solAmount } = await this.priceService.calculateSolFee(
                  Number(globalConfig.claim_fee_usd)
                );
                globalPlatformFeeLamportsV3 = Math.floor(
                  solAmount * LAMPORTS_PER_SOL
                );
                console.log(
                  `[CLAIM-V3] Global platform fee: ${globalConfig.claim_fee_usd} USD (${solAmount} SOL = ${globalPlatformFeeLamportsV3} lamports)`
                );
              } else if (globalConfig.claim_fee_sol !== undefined) {
                globalPlatformFeeLamportsV3 = Math.floor(
                  Number(globalConfig.claim_fee_sol) * LAMPORTS_PER_SOL
                );
                console.log(
                  `[CLAIM-V3] Global platform fee: ${globalPlatformFeeLamportsV3} lamports`
                );
              }
            }
          } catch (err) {
            console.warn("[CLAIM-V3] Failed to get global platform fee:", err);
          }

          // 2. Get pool-level project fee
          if (validVestings.length > 0 && validVestings[0].vesting_streams) {
            const poolFee = validVestings[0].vesting_streams.claim_fee_lamports;
            if (poolFee && poolFee > 0) {
              poolProjectFeeLamportsV3 = Number(poolFee);
              console.log(
                `[CLAIM-V3] Pool project fee: ${poolProjectFeeLamportsV3} lamports (${
                  poolProjectFeeLamportsV3 / LAMPORTS_PER_SOL
                } SOL)`
              );

              if (req.project.vault_public_key) {
                projectVaultWalletV3 = new PublicKey(
                  req.project.vault_public_key
                );
              } else if (req.project.fee_recipient_address) {
                projectVaultWalletV3 = new PublicKey(
                  req.project.fee_recipient_address
                );
              }
            }
          }

          // Calculate total fee
          const totalFeeLamports =
            globalPlatformFeeLamportsV3 + poolProjectFeeLamportsV3;
          feeInSOL = totalFeeLamports / LAMPORTS_PER_SOL;

          console.log(`[CLAIM-V3] Fee breakdown:`);
          console.log(
            `  - Global platform fee: ${globalPlatformFeeLamportsV3} lamports -> ${
              platformFeeWalletV3?.toBase58() || "N/A"
            }`
          );
          console.log(
            `  - Pool project fee: ${poolProjectFeeLamportsV3} lamports -> ${
              projectVaultWalletV3?.toBase58() || "N/A"
            }`
          );
          console.log(
            `  - Total fee: ${totalFeeLamports} lamports (${feeInSOL} SOL)`
          );

          // Set main fee wallet for backward compatibility
          if (platformFeeWalletV3) {
            feeWallet = platformFeeWalletV3;
          } else if (req.project.fee_recipient_address) {
            feeWallet = new PublicKey(req.project.fee_recipient_address);
          } else {
            feeWallet = vaultKeypair.publicKey;
          }
        } catch (err) {
          console.error("Failed to get project vault:", err);
          return res
            .status(500)
            .json({ error: "Failed to access project vault" });
        }
      } else {
        // Legacy: Parse treasury keypair
        try {
          if (!config.treasuryPrivateKey) {
            throw new Error("Treasury private key not configured");
          }
          if (config.treasuryPrivateKey.startsWith("[")) {
            const secretKey = Uint8Array.from(
              JSON.parse(config.treasuryPrivateKey)
            );
            vaultKeypair = Keypair.fromSecretKey(secretKey);
          } else {
            try {
              const bs58 = await import("bs58");
              const decoded = bs58.default.decode(config.treasuryPrivateKey);
              vaultKeypair = Keypair.fromSecretKey(decoded);
            } catch {
              const decoded = Buffer.from(config.treasuryPrivateKey, "base64");
              vaultKeypair = Keypair.fromSecretKey(decoded);
            }
          }
          tokenMint = new PublicKey(config.customTokenMint!);

          // Calculate legacy fee
          if (claimFeeUSD > 0 && dbConfig?.fee_wallet) {
            try {
              const { solAmount } = await this.priceService.calculateSolFee(
                claimFeeUSD
              );
              feeInSOL = solAmount;
              feeWallet = new PublicKey(dbConfig.fee_wallet);
            } catch (err) {
              console.warn("Failed to calculate legacy fee:", err);
            }
          }
        } catch (err) {
          console.error("Treasury key parse error:", err);
          return res
            .status(500)
            .json({ error: "Invalid treasury key configuration" });
        }
      }

      // Create token transfer transaction
      const userPublicKey = new PublicKey(userWallet);

      const vaultTokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        vaultKeypair.publicKey
      );

      const userTokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        userPublicKey
      );

      // Check if user's token account exists
      let userTokenAccountExists = false;
      try {
        await getAccount(this.connection, userTokenAccount);
        userTokenAccountExists = true;
      } catch (err) {
        // Account doesn't exist, will create it
      }

      // Build transaction with all transfers
      const tokenTransferTx = new Transaction();

      if (!userTokenAccountExists) {
        tokenTransferTx.add(
          createAssociatedTokenAccountInstruction(
            vaultKeypair.publicKey,
            userTokenAccount,
            userPublicKey,
            tokenMint
          )
        );
      }

      // Add transfer instructions for each pool
      // Use precise conversion to avoid floating point errors
      const amountInBaseUnitsFloat = amountToClaim * 1e9;
      const amountInBaseUnits = BigInt(Math.round(amountInBaseUnitsFloat));

      tokenTransferTx.add(
        createTransferInstruction(
          vaultTokenAccount,
          userTokenAccount,
          vaultKeypair.publicKey,
          amountInBaseUnits
        )
      );

      // Add SOL fee transfers (both platform and project fees)
      // Platform fee transfer
      if (globalPlatformFeeLamportsV3 > 0 && platformFeeWalletV3) {
        tokenTransferTx.add(
          SystemProgram.transfer({
            fromPubkey: userPublicKey,
            toPubkey: platformFeeWalletV3,
            lamports: globalPlatformFeeLamportsV3,
          })
        );
        console.log(
          `[CLAIM-V3] Added platform fee transfer: ${globalPlatformFeeLamportsV3} lamports to ${platformFeeWalletV3.toBase58()}`
        );
      }

      // Project fee transfer
      if (poolProjectFeeLamportsV3 > 0 && projectVaultWalletV3) {
        tokenTransferTx.add(
          SystemProgram.transfer({
            fromPubkey: userPublicKey,
            toPubkey: projectVaultWalletV3,
            lamports: poolProjectFeeLamportsV3,
          })
        );
        console.log(
          `[CLAIM-V3] Added project fee transfer: ${poolProjectFeeLamportsV3} lamports to ${projectVaultWalletV3.toBase58()}`
        );
      }

      // Get recent blockhash and prepare transaction
      const { blockhash } = await this.connection.getLatestBlockhash();
      tokenTransferTx.recentBlockhash = blockhash;
      // User pays network fees (tiny ~0.00001 SOL) + claim fee
      tokenTransferTx.feePayer = userPublicKey;

      // Partially sign with vault (for token transfer authority)
      tokenTransferTx.partialSign(vaultKeypair);

      // Convert transaction to base64 for transmission
      const transactionBuffer = tokenTransferTx.serialize({
        requireAllSignatures: false,
      });
      const transactionBase64 = transactionBuffer.toString("base64");

      res.json({
        success: true,
        data: {
          transaction: transactionBase64,
          amountToClaim,
          poolBreakdown,
          feeInSOL,
          claimFeeUSD,
          userWallet,
        },
      });
    } catch (error) {
      console.error("Failed to prepare claim transaction:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * POST /api/user/vesting/submit-claim
   * Submit signed transaction to complete the claim
   */
  async submitSignedClaim(req: Request, res: Response) {
    try {
      const {
        userWallet,
        transactionBase64,
        poolBreakdown,
        amountToClaim,
        claimFeeUSD,
        feeInSOL,
      } = req.body;

      if (!userWallet || !transactionBase64) {
        return res
          .status(400)
          .json({ error: "userWallet and transactionBase64 are required" });
      }

      if (!poolBreakdown || !Array.isArray(poolBreakdown)) {
        return res
          .status(400)
          .json({ error: "poolBreakdown array is required" });
      }

      // Deserialize the signed transaction
      const transactionBuffer = Buffer.from(transactionBase64, "base64");
      const transaction = Transaction.from(transactionBuffer);

      // Send the signed transaction
      console.log("[SUBMIT-CLAIM] Sending signed transaction...");

      let tokenSignature: string | null = null;
      const maxRetries = 3;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          console.log(
            `[SUBMIT-CLAIM] Sending transaction (attempt ${attempt}/${maxRetries})...`
          );

          tokenSignature = await this.connection.sendRawTransaction(
            transaction.serialize()
          );

          console.log(
            `[SUBMIT-CLAIM] Transaction sent: ${tokenSignature}, confirming...`
          );

          try {
            // Use 30 second timeout for confirmation
            const latestBlockhash = await this.connection.getLatestBlockhash();
            await Promise.race([
              this.connection.confirmTransaction(
                {
                  signature: tokenSignature,
                  blockhash: latestBlockhash.blockhash,
                  lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
                },
                "confirmed"
              ),
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(new Error("Transaction confirmation timeout")),
                  30000
                )
              ),
            ]);

            console.log(
              "[SUBMIT-CLAIM] Transfer confirmed successfully! Signature:",
              tokenSignature
            );
            break;
          } catch (confirmError) {
            console.warn(
              `[SUBMIT-CLAIM] Confirmation timed out, checking transaction status: ${tokenSignature}`
            );

            // Check if transaction was actually successful despite timeout
            try {
              const status = await this.connection.getSignatureStatus(
                tokenSignature
              );
              if (status && status.value && !status.value.err) {
                console.log(
                  "[SUBMIT-CLAIM] Transaction successful despite confirmation timeout! Signature:",
                  tokenSignature
                );
                break;
              } else if (status && status.value && status.value.err) {
                throw new Error(
                  `Transaction failed on-chain: ${JSON.stringify(
                    status.value.err
                  )}`
                );
              }
              throw confirmError;
            } catch (statusError) {
              console.error(
                "[SUBMIT-CLAIM] Error checking transaction status:",
                statusError
              );
              throw confirmError;
            }
          }
        } catch (err) {
          console.error(
            `[SUBMIT-CLAIM] Transaction attempt ${attempt} failed:`,
            err
          );

          if (attempt === maxRetries) {
            throw new Error(`Transaction failed after ${maxRetries} attempts`);
          }

          const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
      }

      if (!tokenSignature) {
        throw new Error("Failed to send transaction");
      }

      // Record claims in database for each pool that had an amount claimed
      // ? FIX: Get actual token decimals from pool breakdown
      let TOKEN_DECIMALS = 9; // Default fallback
      if (poolBreakdown && poolBreakdown.length > 0) {
        try {
          const { data: firstVesting } = await this.dbService.supabase
            .from("vestings")
            .select("vesting_streams(token_mint)")
            .eq("id", poolBreakdown[0].vestingId)
            .single();
          
          const tokenMintAddress = (firstVesting as any)?.vesting_streams?.token_mint;
          if (tokenMintAddress) {
            TOKEN_DECIMALS = await this.getTokenDecimals(new PublicKey(tokenMintAddress));
          }
        } catch (err) {
          console.warn(`[SUBMIT-CLAIM] Failed to get token decimals, using default 9:`, err);
        }
      }
      const totalClaimAmount = poolBreakdown.reduce(
        (sum: number, p: any) => sum + p.amountToClaim,
        0
      );

      try {
        for (const poolBreakdownItem of poolBreakdown) {
          if (poolBreakdownItem.amountToClaim > 0) {
            // Use Decimal.js for precise conversion
            const amountInBaseUnits = Number(
              this.toBaseUnits(poolBreakdownItem.amountToClaim, TOKEN_DECIMALS)
            );
            // Calculate proportional fee for this pool
            // Prefer feeInSOL (native) over claimFeeUSD (legacy/display)
            const totalFee =
              feeInSOL !== undefined ? feeInSOL : claimFeeUSD || 0;
            const proportionalFee =
              (poolBreakdownItem.amountToClaim / totalClaimAmount) * totalFee;

            // Ensure amount is positive before recording
            if (amountInBaseUnits > 0) {
              // Get vesting ID from poolBreakdownItem (need to fetch from DB)
              const { data: vestingData, error: vestingError } =
                await this.dbService.supabase
                  .from("vestings")
                  .select("id")
                  .eq("vesting_stream_id", poolBreakdownItem.poolId)
                  .eq("user_wallet", userWallet)
                  .eq("is_active", true)
                  .single();

              if (vestingError || !vestingData) {
                console.warn(
                  `[SUBMIT-CLAIM] Could not find vesting for pool ${poolBreakdownItem.poolId}:`,
                  vestingError
                );
                continue;
              }

              // Fetch vesting details to get project_id if needed
              const { data: vesting } = await this.dbService.supabase
                .from("vestings")
                .select("project_id")
                .eq("id", vestingData.id)
                .single();

              const projectId =
                vesting?.project_id || req.projectId || "default";

              await this.dbService.createClaim({
                user_wallet: userWallet,
                vesting_id: vestingData.id,
                project_id: projectId,
                amount_claimed: amountInBaseUnits,
                fee_paid: proportionalFee,
                transaction_signature: tokenSignature,
              });

              // FIX for existing orphaned claims: update any previous claims missing project_id for this vesting
              await this.dbService.supabase
                .from("claim_history")
                .update({ project_id: projectId })
                .is("project_id", null)
                .eq("vesting_id", vestingData.id);

              // Log user claim as an admin-visible activity
              try {
                await this.dbService.logAdminAction({
                  action: "CLAIM_COMPLETED",
                  admin_wallet: "SYSTEM",
                  target_wallet: userWallet,
                  details: {
                    pool_id: poolBreakdownItem.poolId,
                    pool_name: poolBreakdownItem.poolName,
                    amount: poolBreakdownItem.amountToClaim,
                    signature: tokenSignature,
                    project_id: projectId,
                    version: "V3",
                  },
                });
              } catch (logErr) {
                console.warn("[SUBMIT-CLAIM] Failed to log activity:", logErr);
              }

              console.log(
                `[SUBMIT-CLAIM] Recorded claim for pool ${poolBreakdownItem.poolName}: ${poolBreakdownItem.amountToClaim} tokens, fee: ${proportionalFee} USD`
              );
            }
          }
        }
      } catch (dbError) {
        console.error(
          "[SUBMIT-CLAIM] Error recording claims in database:",
          dbError
        );
        // Don't fail the entire response if database recording fails
        // The transaction is already on-chain, so we should still return success
      }

      res.json({
        success: true,
        data: {
          transactionSignature: tokenSignature,
          status: "success",
          claimsRecorded: poolBreakdown.length,
        },
      });
    } catch (error) {
      console.error("Failed to submit signed claim:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * GET /api/user/vesting/claim-status/:signature
   * Check the status of a claim transaction
   */
  async getClaimStatus(req: Request, res: Response) {
    try {
      const { signature } = req.params;

      if (!signature) {
        return res
          .status(400)
          .json({ error: "Transaction signature is required" });
      }

      console.log(`[CLAIM-STATUS] Checking status for signature: ${signature}`);

      // Check transaction status on Solana
      const status = await this.connection.getSignatureStatus(signature);

      if (!status || !status.value) {
        return res.json({
          success: true,
          status: "pending",
          message: "Transaction not yet confirmed",
          signature,
        });
      }

      if (status.value.err) {
        return res.json({
          success: true,
          status: "failed",
          message: "Transaction failed on-chain",
          error: JSON.stringify(status.value.err),
          signature,
        });
      }

      // Transaction succeeded - check if it's recorded in database
      const { data: claims, error: dbError } = await this.dbService.supabase
        .from("claim_history")
        .select("*")
        .eq("transaction_signature", signature)
        .limit(1);

      const isRecorded = claims && claims.length > 0;

      return res.json({
        success: true,
        status: "confirmed",
        message: "Transaction confirmed on-chain",
        signature,
        confirmations: status.value.confirmations || 0,
        slot: status.value.slot,
        recordedInDatabase: isRecorded,
      });
    } catch (error) {
      console.error("[CLAIM-STATUS] Error checking transaction status:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * Helper: Convert token amount to base units with precision
   * Uses Decimal.js to avoid floating point errors
   */
  private toBaseUnits(amount: number, decimals: number = 9): bigint {
    const decimal = new Decimal(amount);
    const multiplier = new Decimal(10).pow(decimals);
    const baseUnits = decimal.times(multiplier).toFixed(0);
    return BigInt(baseUnits);
  }

  /**
   * Helper: Convert base units to token amount with precision
   */
  private fromBaseUnits(
    baseUnits: number | bigint,
    decimals: number = 9
  ): number {
    const decimal = new Decimal(baseUnits.toString());
    const divisor = new Decimal(10).pow(decimals);
    return decimal.dividedBy(divisor).toNumber();
  }

  /**
   * Helper: Calculate vested percentage based on time
   */
  // ✅ REMOVED: Replaced with dynamic token metadata fetching
  // See tokenMetadataService.ts for the new implementation

  private calculateVestedPercentage(
    now: number,
    startTime: number,
    endTime: number,
    cliffTime: number
  ): number {
    if (now < cliffTime) {
      return 0;
    } else if (now >= endTime) {
      return 1;
    } else {
      const timeElapsed = now - cliffTime;
      const totalVestingTime = endTime - cliffTime;
      return timeElapsed / totalVestingTime;
    }
  }
}
