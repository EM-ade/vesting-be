import { Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { SupabaseService } from "../services/supabaseService";
import { config } from "../config";

/**
 * Claims API Controller
 * Handles claim history, statistics, and verification logs
 */
export class ClaimsController {
  private dbService: SupabaseService;

  constructor() {
    const supabaseClient = createClient(
      config.supabaseUrl,
      config.supabaseServiceRoleKey
    );
    this.dbService = new SupabaseService(supabaseClient);
  }

  /**
   * GET /api/claims
   * List recent claims with optional filters
   * SECURITY: Filters by project
   */
  async listClaims(req: Request, res: Response) {
    try {
      const { limit = 50, offset = 0, status, wallet } = req.query;
      const projectId =
        req.projectId ||
        (req.headers["x-project-id"] as string) ||
        (req.query.projectId as string);
      const poolId = req.query.poolId as string;

      let query = this.dbService.supabase
        .from("claim_history")
        .select("*, vestings(id, vesting_stream_id, vesting_streams(id, name))")
        .order("claimed_at", { ascending: false })
        .range(Number(offset), Number(offset) + Number(limit) - 1);

      // SECURITY: Filter by project if provided
      if (projectId) {
        query = query.eq("project_id", projectId);
      }

      if ((poolId && poolId !== "all") || req.query.poolIds) {
        // Filter claims by pool (vesting_stream_id)
        let vestingsQuery = this.dbService.supabase
          .from("vestings")
          .select("id");

        if (poolId && poolId !== "all") {
          vestingsQuery = vestingsQuery.eq("vesting_stream_id", poolId);
        } else if (req.query.poolIds) {
          const ids = (req.query.poolIds as string).split(",").filter(Boolean);
          if (ids.length > 0) {
            vestingsQuery = vestingsQuery.in("vesting_stream_id", ids);
          }
        }

        const { data: poolVestings } = await vestingsQuery;
        const vestingIds = poolVestings?.map((v: { id: string }) => v.id) || [];

        if (vestingIds.length > 0) {
          query = query.in("vesting_id", vestingIds);
        } else {
          query = query.in("vesting_id", [-1]);
        }
      }

      if (status) {
        // claim_history doesn't have status, assuming all are 'approved' or 'completed'
        // query = query.eq('status', status);
      }

      if (wallet) {
        query = query.eq("user_wallet", wallet);
      }

      const { data, error } = await query;

      if (error) throw error;

      // Map columns to match expected interface (frontend expects these field names)
      const claims = (data || []).map((c: any) => ({
        id: c.id,
        wallet: c.user_wallet, // Standard field for formatting
        user_wallet: c.user_wallet, // Explicit field
        pool_id: c.vestings?.vesting_stream_id || c.pool_id,
        pool_name:
          c.vestings?.vesting_streams?.name || c.pool_name || "Unknown Pool",
        amount: Number(c.amount_claimed) / 1e9, // Convert base units to tokens
        timestamp: c.claimed_at, // Frontend expects timestamp, not created_at
        status: "completed", // Default for history
        signature: c.transaction_signature, // Frontend expects signature
      }));

      res.json({ success: true, claims }); // Return object with claims array to match Frontend Overview expectations
    } catch (error) {
      console.error("Failed to list claims:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * GET /api/claims/stats
   * Get claim statistics
   * SECURITY: Filters by project
   */
  async getClaimStats(req: Request, res: Response) {
    try {
      const projectId =
        req.projectId ||
        (req.headers["x-project-id"] as string) ||
        (req.query.projectId as string);
      const poolId = req.query.poolId as string;
      const poolIds = req.query.poolIds as string;

      // SECURITY: Get total claims count for this project
      let totalQuery = this.dbService.supabase
        .from("claim_history")
        .select("*", { count: "exact", head: true });

      if (projectId) {
        totalQuery = totalQuery.eq("project_id", projectId);
      }

      // Helper to apply pool filter
      const applyPoolFilter = async (query: any) => {
        if ((poolId && poolId !== "all") || (poolIds && poolIds !== "")) {
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

          const vestingIds =
            poolVestings?.map((v: { id: string }) => v.id) || [];

          if (vestingIds.length > 0) {
            return query.in("vesting_id", vestingIds);
          } else {
            return query.in("vesting_id", [-1]);
          }
        }
        return query;
      };

      totalQuery = await applyPoolFilter(totalQuery);

      const { count: totalClaims } = await totalQuery;

      // claim_history only stores successful claims, so approved = total
      const approvedClaims = totalClaims;
      const flaggedClaims = 0; // No flag support in claim_history yet

      // Get total amount claimed (sum) for this project
      let claimDataQuery = this.dbService.supabase
        .from("claim_history")
        .select("amount_claimed");

      if (projectId) {
        claimDataQuery = claimDataQuery.eq("project_id", projectId);
      }
      claimDataQuery = await applyPoolFilter(claimDataQuery);

      const { data: claimData } = await claimDataQuery;
      const totalAmountClaimed =
        claimData?.reduce(
          (sum: number, c: any) => sum + (Number(c.amount_claimed) || 0),
          0
        ) / 1e9 || 0;

      // Get claims in last 24h for this project
      const yesterday = new Date(
        Date.now() - 24 * 60 * 60 * 1000
      ).toISOString();
      let claims24hQuery = this.dbService.supabase
        .from("claim_history")
        .select("*", { count: "exact", head: true })
        .gte("claimed_at", yesterday);

      if (projectId) {
        claims24hQuery = claims24hQuery.eq("project_id", projectId);
      }
      claims24hQuery = await applyPoolFilter(claims24hQuery);

      const { count: claims24h } = await claims24hQuery;

      // Get claims in last 7 days for this project
      const weekAgo = new Date(
        Date.now() - 7 * 24 * 60 * 60 * 1000
      ).toISOString();
      let claims7dQuery = this.dbService.supabase
        .from("claim_history")
        .select("*", { count: "exact", head: true })
        .gte("claimed_at", weekAgo);

      if (projectId) {
        claims7dQuery = claims7dQuery.eq("project_id", projectId);
      }
      claims7dQuery = await applyPoolFilter(claims7dQuery);

      const { count: claims7d } = await claims7dQuery;

      // Get unique users for this project
      let uniqueUsersQuery = this.dbService.supabase
        .from("claim_history")
        .select("user_wallet");

      if (projectId) {
        uniqueUsersQuery = uniqueUsersQuery.eq("project_id", projectId);
      }
      uniqueUsersQuery = await applyPoolFilter(uniqueUsersQuery);

      const { data: uniqueUsers } = await uniqueUsersQuery;

      const uniqueUserCount = new Set(
        uniqueUsers?.map((u: any) => u.user_wallet)
      ).size;

      res.json({
        total: totalClaims || 0,
        last24h: claims24h || 0,
        last7d: claims7d || 0,
        totalAmount: totalAmountClaimed,
        uniqueUsers: uniqueUserCount,
      });
    } catch (error) {
      console.error("Failed to get claim stats:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * GET /api/claims/:id
   * Get claim details by ID
   * SECURITY: Verifies claim belongs to user's project
   */
  async getClaimDetails(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const projectId =
        req.projectId || (req.headers["x-project-id"] as string);

      if (!id) {
        return res.status(400).json({ error: "Claim ID is required" });
      }

      let query = this.dbService.supabase
        .from("claim_history")
        .select("*")
        .eq("id", id);

      // SECURITY: Verify claim belongs to user's project
      if (projectId) {
        query = query.eq("project_id", projectId);
      }

      const { data, error } = await query.single();

      if (error) throw error;

      if (!data) {
        return res.status(404).json({ error: "Claim not found" });
      }

      res.json(data);
    } catch (error) {
      console.error("Failed to get claim details:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * POST /api/claims/:id/flag
   * Flag a claim for review
   */
  async flagClaim(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { reason, adminWallet } = req.body;
      const projectId =
        req.projectId ||
        (req.headers["x-project-id"] as string) ||
        req.body.projectId;

      if (!id || !adminWallet) {
        return res
          .status(400)
          .json({ error: "Claim ID and adminWallet are required" });
      }

      // Note: claim_history table doesn't have status/flag_reason columns
      // For now, log the flag action in admin_actions table
      // TODO: Add flagged_claims table or add columns to claim_history

      await this.dbService.supabase.from("admin_logs").insert({
        action: "flag_claim",
        admin_wallet: adminWallet,
        details: {
          project_id: projectId, // Add project_id to details since column doesn't exist
          claimId: id,
          reason,
          target_type: "claim",
          target_id: id,
        },
        created_at: new Date().toISOString(),
      });

      res.json({
        success: true,
        message: "Claim flagged successfully (logged in admin actions)",
        note: "Flag tracking requires database schema update",
      });
    } catch (error) {
      console.error("Failed to flag claim:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * GET /api/claims/wallet/:wallet
   * Get all claims for a specific wallet
   * SECURITY: Filters by project
   */
  async getWalletClaims(req: Request, res: Response) {
    try {
      const { wallet } = req.params;
      const projectId =
        req.projectId ||
        (req.headers["x-project-id"] as string) ||
        (req.query.projectId as string);

      if (!wallet) {
        return res.status(400).json({ error: "Wallet address is required" });
      }

      let query = this.dbService.supabase
        .from("claim_history")
        .select("*")
        .eq("user_wallet", wallet)
        .order("claimed_at", { ascending: false });

      // SECURITY: Filter by project if provided
      if (projectId) {
        query = query.eq("project_id", projectId);
      }

      const { data, error } = await query;

      if (error) throw error;

      // Map to frontend format
      const claims = (data || []).map((c: any) => ({
        id: c.id,
        user_wallet: c.user_wallet,
        pool_id: c.pool_id,
        pool_name: c.pool_name,
        amount: Number(c.amount_claimed) / 1e9,
        timestamp: c.claimed_at,
        status: "completed",
        signature: c.transaction_signature,
      }));

      res.json(claims); // Return array directly
    } catch (error) {
      console.error("Failed to get wallet claims:", error);
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
}
