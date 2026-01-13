import { Request, Response } from "express";
import { Connection, PublicKey } from "@solana/web3.js";
import { createClient } from "@supabase/supabase-js";
import NodeCache from "node-cache";
import { SupabaseService } from "../services/supabaseService";
import { config } from "../config";
import { getRPCConfig } from '../config';
import { getTokenSymbol as fetchTokenSymbol } from "../services/tokenMetadataService";

/**
 * Metrics API Controller
 * Aggregates dashboard metrics from various sources
 */
export class MetricsController {
  private dbService: SupabaseService;
  private connection: Connection;
  private cache: NodeCache;

  constructor() {
    const supabaseClient = createClient(
      config.supabaseUrl,
      config.supabaseServiceRoleKey
    );
    this.dbService = new SupabaseService(supabaseClient);
    this.connection = new Connection(getRPCConfig().getRPCEndpoint(), "confirmed");
    this.cache = new NodeCache({ stdTTL: 300 }); // Cache for 5 minutes by default
  }

  /**
   * GET /api/metrics/dashboard
   * Get aggregated dashboard metrics with multi-token support
   */
  async getDashboardMetrics(req: Request, res: Response) {
    try {
      const projectId =
        req.projectId ||
        (req.headers["x-project-id"] as string) ||
        (req.query.projectId as string);
      const cacheKey = `dashboard_metrics_${projectId || "all"}`;
      const cachedData = this.cache.get(cacheKey);

      if (cachedData) {
        return res.json(cachedData);
      }

      // Get multi-token metrics
      const tokenMetrics = await this.getMultiTokenMetrics(projectId);
      const eligibleWallets = await this.getEligibleWalletsCount(projectId);
      const nextUnlock = await this.getNextUnlockTime();
      const cycleWindow = await this.getCycleWindow(projectId);

      // Legacy single-token fields for backward compatibility
      const totalPoolBalance = Object.values(tokenMetrics).reduce(
        (sum, token) => sum + token.totalAllocated,
        0
      );

      const responseData = {
        // Legacy fields
        poolBalance: totalPoolBalance,
        eligibleWallets,
        nextUnlock,
        cycleWindow,
        lastUpdated: new Date().toISOString(),
        // New multi-token fields
        tokenMetrics,
        crossTokenMetrics: {
          totalTokenTypes: Object.keys(tokenMetrics).length,
          totalUsers: eligibleWallets,
          totalPools: Object.values(tokenMetrics).reduce(
            (sum, token) => sum + token.activePools,
            0
          ),
          totalAllocated: Object.values(tokenMetrics).reduce(
            (sum, token) => sum + token.totalAllocated,
            0
          ),
          totalClaimed: Object.values(tokenMetrics).reduce(
            (sum, token) => sum + token.totalClaimed,
            0
          ),
        },
      };

      this.cache.set(cacheKey, responseData);
      res.json(responseData);
    } catch (error) {
      console.error("Failed to get dashboard metrics:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * GET /api/metrics/pool-balance
   * Get current pool balance
   */
  async getPoolBalanceEndpoint(req: Request, res: Response) {
    try {
      const cacheKey = "pool_balance_endpoint";
      const cachedData = this.cache.get(cacheKey);

      if (cachedData) {
        return res.json(cachedData);
      }

      const balance = await this.getPoolBalance();

      const responseData = {
        balance,
        unit: "tokens",
        timestamp: new Date().toISOString(),
      };

      this.cache.set(cacheKey, responseData);
      res.json(responseData);
    } catch (error) {
      console.error("Failed to get pool balance:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * GET /api/metrics/eligible-wallets
   * Get count of eligible wallets
   * SECURITY: Filters by project
   */
  async getEligibleWalletsEndpoint(req: Request, res: Response) {
    try {
      const projectId =
        req.projectId ||
        (req.headers["x-project-id"] as string) ||
        (req.query.projectId as string);
      const poolId = req.query.poolId as string;
      const poolIds = req.query.poolIds as string; // Support multi-select

      const cacheKey = `eligible_wallets_endpoint_${projectId || "all"}_${
        poolIds || poolId || "all"
      }`;
      const cachedData = this.cache.get(cacheKey);

      if (cachedData) {
        return res.json(cachedData);
      }

      // SECURITY: Count eligible wallets for this project only
      const count = await this.getEligibleWalletsCount(
        projectId,
        poolIds || poolId
      );

      const responseData = {
        count,
        timestamp: new Date().toISOString(),
      };

      this.cache.set(cacheKey, responseData);
      res.json(responseData);
    } catch (error) {
      console.error("Failed to get eligible wallets:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * GET /api/metrics/activity-log
   * Get recent operational events
   * SECURITY: Filters by project
   */
  async getActivityLog(req: Request, res: Response) {
    try {
      const { limit = 20 } = req.query;
      const projectId =
        req.projectId ||
        (req.headers["x-project-id"] as string) ||
        (req.query.projectId as string);
      const poolIds = req.query.poolIds as string;

      const cacheKey = `activity_log_${limit}_${projectId || "all"}_${
        poolIds || "all"
      }`;
      const cachedData = this.cache.get(cacheKey);

      if (cachedData) {
        return res.json(cachedData);
      }

      let query = this.dbService.supabase
        .from("admin_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(Number(limit));

      // SECURITY: Filter by project if provided (using JSON operator)
      if (projectId) {
        // Use the arrow operator ->> for text extraction from JSONB
        query = query.eq("details->>project_id", projectId);
      }

      // Filter by poolIds if provided
      if (poolIds) {
        const ids = poolIds.split(",").filter(Boolean);
        if (ids.length > 0) {
          // We need to check if details->pool_id is in the list of ids
          // Since Supabase doesn't support 'in' on JSONB fields easily in all versions,
          // and admin logs might structure data differently, this is best effort.
          // Assuming logs have details: { pool_id: "..." }

          // Construct an OR filter for the JSON field
          // format: details->>pool_id.eq.id1,details->>pool_id.eq.id2
          const orFilter = ids
            .map((id) => `details->>pool_id.eq.${id}`)
            .join(",");
          query = query.or(orFilter);
        }
      }

      const { data, error } = await query;

      if (error) throw error;

      const responseData = {
        activities: (data || []).map((a: any) => ({
          ...a,
          timestamp: a.created_at, // Map for frontend compatibility
        })),
        total: data?.length || 0,
      };

      this.cache.set(cacheKey, responseData, 30); // Short cache for activity log (30s)
      res.json(responseData);
    } catch (error) {
      console.error("Failed to get activity log:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * GET /api/metrics/claim-history-stats
   * Get aggregated claim history for charts (last 30 days) with token filtering
   * SECURITY: Filters by project
   */
  async getClaimHistoryStats(req: Request, res: Response) {
    try {
      const projectId =
        req.projectId ||
        (req.headers["x-project-id"] as string) ||
        (req.query.projectId as string);
      const poolId = req.query.poolId as string;
      const poolIds = req.query.poolIds as string;
      const tokenMint = req.query.tokenMint as string;
      const cacheKey = `claim_history_stats_${projectId || "all"}_${
        poolIds || poolId || "all"
      }_${tokenMint || "all"}`;
      const cachedData = this.cache.get(cacheKey);

      if (cachedData) {
        return res.json(cachedData);
      }

      // Get claims from last 30 days
      const thirtyDaysAgo = new Date(
        Date.now() - 30 * 24 * 60 * 60 * 1000
      ).toISOString();

      let query = this.dbService.supabase
        .from("claim_history")
        .select("amount_claimed, claimed_at")
        .gte("claimed_at", thirtyDaysAgo)
        .order("claimed_at", { ascending: true });

      // SECURITY: Filter by project if provided
      if (projectId) {
        query = query.eq("project_id", projectId);
      }

      // Filter by pool and/or token if provided
      let vestingIds: string[] = [];
      const effectivePoolIds = poolIds
        ? poolIds.split(",").filter(Boolean)
        : poolId && poolId !== "all"
        ? [poolId]
        : [];

      if (effectivePoolIds.length > 0) {
        const { data: poolVestings } = await this.dbService.supabase
          .from("vestings")
          .select("id")
          .in("vesting_stream_id", effectivePoolIds);
        vestingIds = poolVestings?.map((v: { id: string }) => v.id) || [];
      } else if (tokenMint && tokenMint !== "all") {
        // Filter by token mint through vesting_streams
        const { data: tokenStreams } = await this.dbService.supabase
          .from("vesting_streams")
          .select("id")
          .eq("token_mint", tokenMint);

        const streamIds = tokenStreams?.map((s: { id: string }) => s.id) || [];

        if (streamIds.length > 0) {
          const { data: tokenVestings } = await this.dbService.supabase
            .from("vestings")
            .select("id")
            .in("vesting_stream_id", streamIds);
          vestingIds = tokenVestings?.map((v: { id: string }) => v.id) || [];
        }
      }

      if (vestingIds.length > 0) {
        query = query.in("vesting_id", vestingIds);
      } else if (
        (poolId && poolId !== "all") ||
        (tokenMint && tokenMint !== "all")
      ) {
        // If filtering was requested but no matches found, return empty results
        query = query.in("vesting_id", [-1]);
      }

      const { data, error } = await query;

      if (error) throw error;

      // Aggregate by day with count tracking
      const claimsByDay = new Map<string, { amount: number; count: number }>();

      // Initialize last 30 days with 0
      for (let i = 29; i >= 0; i--) {
        const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
        const dateStr = d.toISOString().split("T")[0]; // YYYY-MM-DD
        claimsByDay.set(dateStr, { amount: 0, count: 0 });
      }

      // Process actual claims
      data?.forEach((claim: any) => {
        const dateStr = new Date(claim.claimed_at).toISOString().split("T")[0];
        const amount = Number(claim.amount_claimed || "0") / 1e9; // Convert from lamports

        const existing = claimsByDay.get(dateStr);
        if (existing) {
          existing.amount += amount;
          existing.count += 1;
        }
      });

      // Convert to array with cumulative data
      let cumulativeAmount = 0;
      const chartData = Array.from(claimsByDay.entries())
        .sort(([a], [b]) => new Date(a).getTime() - new Date(b).getTime())
        .map(([date, data]) => {
          cumulativeAmount += data.amount;
          return {
            date: new Date(date).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            }),
            amount: Math.round(data.amount * 100) / 100,
            cumulativeAmount: Math.round(cumulativeAmount * 100) / 100,
            count: data.count,
          };
        });

      this.cache.set(cacheKey, chartData, 300); // Cache charts for 5 minutes
      res.json(chartData);
    } catch (error) {
      console.error("Failed to get claim history stats:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * Helper: Get multi-token metrics breakdown (DATABASE-OPTIMIZED)
   * SECURITY: Filters by project
   * PERFORMANCE: Uses database-level aggregation instead of client-side processing
   */
  private async getMultiTokenMetrics(
    projectId?: string
  ): Promise<Record<string, any>> {
    try {
      const TOKEN_DECIMALS = 9;
      const TOKEN_DIVISOR = Math.pow(10, TOKEN_DECIMALS);

      // PROACTIVE FIX: Associate orphaned claims with correct project_id (self-healing)
      // Runs async in background, doesn't block main query
      this.healOrphanedData(projectId).catch(err => 
        console.warn("[METRICS] Background healing failed:", err)
      );

      // PERFORMANCE OPTIMIZATION: Use database-level aggregation
      // This single query replaces 3+ round trips and client-side processing
      
      // Step 1: Get aggregated allocations per token
      let allocationsQuery = this.dbService.supabase
        .from("vesting_streams")
        .select("token_mint, id")
        .eq("is_active", true);

      if (projectId) {
        allocationsQuery = allocationsQuery.eq("project_id", projectId);
      }

      const { data: streams } = await allocationsQuery;

      if (!streams || streams.length === 0) {
        return {};
      }

      const streamIds = streams.map((s: { id: string }) => s.id);

      // Step 2: Aggregate allocations and claims in parallel using database
      const [allocationsResult, claimsResult] = await Promise.all([
        // Get total allocations per stream
        this.dbService.supabase
          .from("vestings")
          .select("vesting_stream_id, token_amount")
          .in("vesting_stream_id", streamIds)
          .eq("is_active", true),
        
        // Get total claims per stream (single aggregated query)
        this.dbService.supabase.rpc("get_claims_by_stream", {
          stream_ids: streamIds
        }).catch(() => {
          // Fallback: If RPC doesn't exist, use client-side aggregation
          return this.dbService.supabase
            .from("vestings")
            .select("id, vesting_stream_id")
            .in("vesting_stream_id", streamIds)
            .eq("is_active", true)
            .then(async ({ data: vestings }: { data: any[] | null }) => {
              if (!vestings || vestings.length === 0) {
                return { data: [] };
              }
              const vestingIds = vestings.map((v: any) => v.id);
              const { data: claims } = await this.dbService.supabase
                .from("claim_history")
                .select("vesting_id, amount_claimed")
                .in("vesting_id", vestingIds);
              
              // Aggregate claims by stream
              const claimsByStream = new Map<string, number>();
              claims?.forEach((claim: any) => {
                const vesting = vestings.find((v: any) => v.id === claim.vesting_id);
                if (vesting) {
                  const streamId = vesting.vesting_stream_id;
                  const current = claimsByStream.get(streamId) || 0;
                  claimsByStream.set(streamId, current + Number(claim.amount_claimed));
                }
              });
              
              return { 
                data: Array.from(claimsByStream.entries()).map(([stream_id, total_claimed]) => ({
                  stream_id,
                  total_claimed
                }))
              };
            });
        })
      ]);

      // Step 3: Process results in memory (much smaller dataset now)
      const allocationsByStream = new Map<string, number>();
      allocationsResult.data?.forEach((v: any) => {
        const current = allocationsByStream.get(v.vesting_stream_id) || 0;
        allocationsByStream.set(v.vesting_stream_id, current + Number(v.token_amount));
      });

      const claimsByStream = new Map<string, number>();
      claimsResult.data?.forEach((c: any) => {
        claimsByStream.set(c.stream_id, Number(c.total_claimed || 0));
      });

      // Step 4: Group by token mint
      const streamsByToken = new Map<string, string[]>();
      streams.forEach((s: any) => {
        const mint = s.token_mint;
        if (!streamsByToken.has(mint)) {
          streamsByToken.set(mint, []);
        }
        streamsByToken.get(mint)?.push(s.id);
      });

      const tokenMetrics: Record<string, any> = {};

      for (const [tokenMint, streamIds] of streamsByToken.entries()) {
        const tokenSymbol = await fetchTokenSymbol(tokenMint); // ✅ Dynamic token resolution

        let totalAllocated = 0;
        let totalClaimedRaw = 0;

        streamIds.forEach(streamId => {
          totalAllocated += allocationsByStream.get(streamId) || 0;
          totalClaimedRaw += claimsByStream.get(streamId) || 0;
        });

        const totalClaimed = totalClaimedRaw / TOKEN_DIVISOR;

        tokenMetrics[tokenMint] = {
          tokenMint,
          tokenSymbol,
          totalAllocated,
          totalClaimed,
          remainingNeeded: totalAllocated - totalClaimed,
          activePools: streamIds.length,
          healthScore:
            totalAllocated > 0
              ? Math.round((totalClaimed / totalAllocated) * 100)
              : 0,
          projectedDays: this.calculateProjectedDays(
            totalAllocated,
            totalClaimed
          ),
          recommendations: await this.generateTokenRecommendations(
            tokenMint,
            totalAllocated,
            totalClaimed
          ),
        };
      }

      return tokenMetrics;
    } catch (error) {
      console.error("Error getting multi-token metrics (db-optimized):", error);
      return {};
    }
  }

  /**
   * Background helper: Heal orphaned data (runs async, non-blocking)
   */
  private async healOrphanedData(projectId?: string): Promise<void> {
    try {
      // Heal orphaned claims
      const { data: orphanedClaims } = await this.dbService.supabase
        .from("claim_history")
        .select("id, vesting_id")
        .is("project_id", null)
        .limit(20);

      if (orphanedClaims && orphanedClaims.length > 0) {
        for (const claim of orphanedClaims) {
          const { data: vesting } = await this.dbService.supabase
            .from("vestings")
            .select("project_id")
            .eq("id", claim.vesting_id)
            .single();
          if (vesting?.project_id) {
            await this.dbService.supabase
              .from("claim_history")
              .update({ project_id: vesting.project_id })
              .eq("id", claim.id);
          }
        }
        this.cache.del(`dashboard_metrics_${projectId || "all"}`);
      }

      // Heal orphaned logs
      const { data: orphanedLogs } = await this.dbService.supabase
        .from("admin_logs")
        .select("id, details")
        .eq("action", "CLAIM_COMPLETED")
        .is("details->>project_id", null)
        .limit(20);

      if (orphanedLogs && orphanedLogs.length > 0) {
        for (const log of orphanedLogs) {
          const signature = log.details?.signature;
          if (signature) {
            const { data: claim } = await this.dbService.supabase
              .from("claim_history")
              .select("project_id")
              .eq("transaction_signature", signature)
              .single();

            if (claim?.project_id) {
              const newDetails = { ...log.details, project_id: claim.project_id };
              await this.dbService.supabase
                .from("admin_logs")
                .update({ details: newDetails })
                .eq("id", log.id);
            }
          }
        }
        this.cache.del(`activity_log_10_${projectId || "all"}_all`);
      }
    } catch (err) {
      // Silently fail - this is background healing
      console.warn("[METRICS] Orphaned data healing failed:", err);
    }
  }

  /**
   * Helper: Get pool balance from database or blockchain
   * SECURITY: Should filter by project, but requires project context
   */
  private async getPoolBalance(projectId?: string): Promise<number> {
    try {
      // SECURITY: Get total pool amount from active vesting streams for this project
      let query = this.dbService.supabase
        .from("vesting_streams")
        .select("total_pool_amount")
        .eq("is_active", true);

      if (projectId) {
        query = query.eq("project_id", projectId);
      }

      const { data: streams } = await query;

      if (streams && streams.length > 0) {
        return streams.reduce(
          (sum: number, s: any) => sum + (s.total_pool_amount || 0),
          0
        );
      }

      return 0;
    } catch (error) {
      console.error("Error getting pool balance:", error);
      return 0;
    }
  }

  /**
   * Helper: Get eligible wallets count
   * SECURITY: Should filter by project
   */
  private async getEligibleWalletsCount(
    projectId?: string,
    poolId?: string
  ): Promise<number> {
    try {
      // SECURITY: Count active vesting records for this project
      let query = this.dbService.supabase
        .from("vestings")
        .select("*", { count: "exact", head: true })
        .eq("is_active", true)
        .eq("is_cancelled", false);

      if (projectId) {
        query = query.eq("project_id", projectId);
      }

      if (poolId && poolId !== "all") {
        const ids = poolId.split(",").filter(Boolean);
        if (ids.length > 1) {
          query = query.in("vesting_stream_id", ids);
        } else if (ids.length === 1) {
          query = query.eq("vesting_stream_id", ids[0]);
        }
      }

      const { count } = await query;

      return count || 0;
    } catch (error) {
      console.error("Error getting eligible wallets:", error);
      return 0;
    }
  }

  /**
   * Helper: Get next unlock time
   */
  private async getNextUnlockTime(): Promise<string> {
    try {
      // Tokens unlock continuously based on vesting schedule
      // Show "Continuous" since it's linear vesting
      return "Continuous";
    } catch (error) {
      console.error("Error getting next unlock:", error);
      return "Continuous";
    }
  }

  /**
   * Helper: Get cycle window
   * SECURITY: Should filter by project
   */
  private async getCycleWindow(
    projectId?: string
  ): Promise<{ start: string; end: string; daysRemaining: number }> {
    try {
      // SECURITY: Get the earliest start time and latest end time from active streams for this project
      let query = this.dbService.supabase
        .from("vesting_streams")
        .select("start_time, end_time")
        .eq("is_active", true)
        .order("start_time", { ascending: true })
        .limit(1);

      if (projectId) {
        query = query.eq("project_id", projectId);
      }

      const { data: streams } = await query;

      if (!streams || streams.length === 0) {
        return {
          start: "N/A",
          end: "N/A",
          daysRemaining: 0,
        };
      }

      const startDate = new Date(streams[0].start_time);
      const endDate = new Date(streams[0].end_time);
      const now = new Date();
      const daysRemaining = Math.max(
        0,
        Math.floor((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      );

      return {
        start: startDate.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
        end: endDate.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
        daysRemaining,
      };
    } catch (error) {
      console.error("Error getting cycle window:", error);
      return {
        start: "N/A",
        end: "N/A",
        daysRemaining: 0,
      };
    }
  }

  /**
   * Helper: Get token symbol from mint address
   */
  // ✅ REMOVED: Replaced with dynamic token metadata fetching
  // See tokenMetadataService.ts for the new implementation

  /**
   * Helper: Calculate projected days until completion
   */
  private calculateProjectedDays(
    totalAllocated: number,
    totalClaimed: number
  ): number {
    if (totalAllocated <= totalClaimed) return 0;

    // Simple projection based on current claiming rate
    // This could be enhanced with actual vesting schedule analysis
    const remainingPercentage =
      (totalAllocated - totalClaimed) / totalAllocated;
    const estimatedDays = Math.round(remainingPercentage * 365); // Rough estimate

    return Math.min(estimatedDays, 999);
  }

  /**
   * Helper: Generate token-specific recommendations
   */
  private async generateTokenRecommendations(
    tokenMint: string,
    totalAllocated: number,
    totalClaimed: number
  ): Promise<string[]> {
    const recommendations: string[] = [];
    const claimPercentage =
      totalAllocated > 0 ? (totalClaimed / totalAllocated) * 100 : 0;
    const tokenSymbol = await fetchTokenSymbol(tokenMint); // ✅ Dynamic token resolution

    if (claimPercentage > 80) {
      recommendations.push(
        `${tokenSymbol} pools are nearing completion (${Math.round(
          claimPercentage
        )}% claimed)`
      );
    } else if (claimPercentage < 10) {
      recommendations.push(
        `${tokenSymbol} claiming has just started - monitor user engagement`
      );
    }

    if (totalAllocated > 1000000) {
      recommendations.push(
        `Large ${tokenSymbol} allocation detected - ensure sufficient treasury balance`
      );
    }

    return recommendations;
  }
}
