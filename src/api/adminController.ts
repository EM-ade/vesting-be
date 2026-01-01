import { Request, Response } from 'express';
import { SupabaseService } from '../services/supabaseService';
import { getSupabaseClient } from '../lib/supabaseClient';
import { TreasuryController } from './treasuryController';
import { PoolController } from './poolController';
import { ClaimsController } from './claimsController';
import { MetricsController } from './metricsController';

/**
 * Admin API Controller
 * Handles admin operations for pool management
 */
export class AdminController {
  private dbService: SupabaseService;
  private treasuryController: TreasuryController;
  private poolController: PoolController;
  private claimsController: ClaimsController;
  private metricsController: MetricsController;

  constructor() {
    const supabaseClient = getSupabaseClient();
    this.dbService = new SupabaseService(supabaseClient);
    this.treasuryController = new TreasuryController();
    this.poolController = new PoolController();
    this.claimsController = new ClaimsController();
    this.metricsController = new MetricsController();
  }

  /**
   * GET /api/admin/pool/:poolId/members
   * Get all members in a vesting pool with their allocations and NFT counts
   * SECURITY: Verifies pool belongs to user's project
   */
  async getPoolMembers(req: Request, res: Response) {
    try {
      const { poolId } = req.params;
      const projectId = req.projectId || req.headers['x-project-id'] as string;

      if (!poolId) {
        return res.status(400).json({ error: 'Pool ID is required' });
      }

      if (!projectId) {
        return res.status(400).json({ error: 'Project ID is required' });
      }

      // SECURITY: First verify the pool belongs to user's project
      const { data: pool, error: poolError } = await this.dbService.supabase
        .from('vesting_streams')
        .select('id')
        .eq('id', poolId)
        .eq('project_id', projectId)
        .single();

      if (poolError || !pool) {
        return res.status(404).json({ error: 'Pool not found or access denied' });
      }

      // Get all active vestings for this pool (exclude cancelled members)
      const { data: members, error } = await this.dbService.supabase
        .from('vestings')
        .select('id, user_wallet, token_amount, nft_count, tier, created_at, is_active, is_cancelled')
        .eq('vesting_stream_id', poolId)
        .eq('project_id', projectId)
        .eq('is_cancelled', false);

      if (error) {
        throw new Error(`Failed to fetch pool members: ${error.message}`);
      }

      res.json({
        success: true,
        members: members || []
      });
    } catch (error) {
      console.error('Failed to get pool members:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * PATCH /api/admin/pool/:poolId/member/:wallet
   * Update or remove a member from a vesting pool
   * SECURITY: Verifies pool belongs to user's project
   */
  async updatePoolMember(req: Request, res: Response) {
    try {
      const { poolId, wallet } = req.params;
      const { allocation, nftCount, remove } = req.body;
      const projectId = req.projectId || req.headers['x-project-id'] as string;

      if (!poolId || !wallet) {
        return res.status(400).json({ error: 'Pool ID and wallet are required' });
      }

      if (!projectId) {
        return res.status(400).json({ error: 'Project ID is required' });
      }

      // SECURITY: First verify the pool belongs to user's project
      const { data: pool, error: poolError } = await this.dbService.supabase
        .from('vesting_streams')
        .select('id')
        .eq('id', poolId)
        .eq('project_id', projectId)
        .single();

      if (poolError || !pool) {
        return res.status(404).json({ error: 'Pool not found or access denied' });
      }

      if (remove) {
        // SECURITY: Remove member from pool - verify project ownership
        const { error } = await this.dbService.supabase
          .from('vestings')
          .update({ 
            is_active: false, 
            is_cancelled: true,
            cancellation_reason: 'Removed by admin'
          })
          .eq('vesting_stream_id', poolId)
          .eq('user_wallet', wallet)
          .eq('project_id', projectId);

        if (error) {
          throw new Error(`Failed to remove member: ${error.message}`);
        }

        res.json({
          success: true,
          message: 'Member removed successfully'
        });
      } else {
        // Update member allocation or NFT count
        const updates: any = {};
        if (allocation !== undefined) updates.token_amount = allocation;
        if (nftCount !== undefined) updates.nft_count = nftCount;

        if (Object.keys(updates).length === 0) {
          return res.status(400).json({ error: 'Either allocation or nftCount must be provided' });
        }

        // SECURITY: Update member - verify project ownership
        const { error } = await this.dbService.supabase
          .from('vestings')
          .update(updates)
          .eq('vesting_stream_id', poolId)
          .eq('user_wallet', wallet)
          .eq('project_id', projectId);

        if (error) {
          throw new Error(`Failed to update member: ${error.message}`);
        }

        res.json({
          success: true,
          message: 'Member updated successfully'
        });
      }
    } catch (error) {
      console.error('Failed to update pool member:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * PATCH /api/admin/pool/:poolId/state
   * Pause, resume, or cancel a vesting pool
   * SECURITY: Verifies pool belongs to user's project
   */
  async updatePoolState(req: Request, res: Response) {
    try {
      const { poolId } = req.params;
      const { action, reason } = req.body;
      const projectId = req.projectId || req.headers['x-project-id'] as string;

      if (!poolId) {
        return res.status(400).json({ error: 'Pool ID is required' });
      }

      if (!projectId) {
        return res.status(400).json({ error: 'Project ID is required' });
      }

      if (!action || !['pause', 'resume', 'cancel'].includes(action)) {
        return res.status(400).json({ error: 'Valid action (pause, resume, cancel) is required' });
      }

      // SECURITY: First verify the pool belongs to user's project
      const { data: pool, error: poolError } = await this.dbService.supabase
        .from('vesting_streams')
        .select('id')
        .eq('id', poolId)
        .eq('project_id', projectId)
        .single();

      if (poolError || !pool) {
        return res.status(404).json({ error: 'Pool not found or access denied' });
      }

      // Update pool state using SupabaseService method
      let newState: string;
      switch (action) {
        case 'pause':
          newState = 'paused';
          break;
        case 'resume':
          newState = 'active';
          break;
        case 'cancel':
          newState = 'cancelled';
          break;
        default:
          newState = 'active';
      }

      try {
        await this.dbService.updatePoolState(poolId, newState);
      } catch (err) {
        throw new Error(`Failed to update pool state: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }

      // If cancelling, also cancel all vestings in this pool
      if (action === 'cancel') {
        // SECURITY: Cancel vestings - verify project ownership
        await this.dbService.supabase
          .from('vestings')
          .update({ 
            is_active: false, 
            is_cancelled: true,
            cancellation_reason: reason || 'Pool cancelled by admin'
          })
          .eq('vesting_stream_id', poolId)
          .eq('project_id', projectId);
      }

      res.json({
        success: true,
        message: `Pool ${action}d successfully`
      });
    } catch (error) {
      console.error('Failed to update pool state:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/admin/dashboard-batch
   * Batch endpoint that consolidates multiple dashboard API calls into one
   * Reduces network roundtrips from 5-6 calls to 1 single call
   * SECURITY: Verifies project access
   * PERFORMANCE: Parallel execution with timeout protection
   */
  async getDashboardBatch(req: Request, res: Response) {
    try {
      const projectId = req.projectId || (req.query.projectId as string);
      const poolIds = req.query.poolIds as string;
      const claimsLimit = parseInt(req.query.claimsLimit as string) || 8;
      const activityLimit = parseInt(req.query.activityLimit as string) || 20;

      if (!projectId) {
        return res.status(400).json({ 
          success: false,
          error: 'Project ID is required' 
        });
      }

      // PERFORMANCE OPTIMIZATION: Add timeout protection to prevent hanging
      const BATCH_TIMEOUT_MS = 15000; // 15 seconds max for entire batch
      
      const withTimeout = <T,>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
        return Promise.race([
          promise,
          new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
          ),
        ]);
      };

      // Execute all data fetches in parallel for maximum performance
      const [
        treasuryResult,
        poolsResult,
        claimsResult,
        eligibleWalletsResult,
        activityLogResult
      ] = await Promise.allSettled([
        // Treasury status
        withTimeout(
          this.fetchTreasuryStatus(req, projectId, poolIds),
          BATCH_TIMEOUT_MS,
          'Treasury'
        ),
        
        // Pools list
        withTimeout(
          this.fetchPools(req),
          BATCH_TIMEOUT_MS,
          'Pools'
        ),
        
        // Recent claims
        withTimeout(
          this.fetchClaims(req, projectId, claimsLimit, poolIds),
          BATCH_TIMEOUT_MS,
          'Claims'
        ),
        
        // Eligible wallets count
        withTimeout(
          this.fetchEligibleWallets(req, projectId, poolIds),
          BATCH_TIMEOUT_MS,
          'EligibleWallets'
        ),
        
        // Activity log
        withTimeout(
          this.fetchActivityLog(req, activityLimit, poolIds),
          BATCH_TIMEOUT_MS,
          'ActivityLog'
        )
      ]);

      // Extract data from settled promises
      const treasury = treasuryResult.status === 'fulfilled' ? treasuryResult.value : null;
      const pools = poolsResult.status === 'fulfilled' ? poolsResult.value : [];
      const claims = claimsResult.status === 'fulfilled' ? claimsResult.value : { claims: [] };
      const eligibleWallets = eligibleWalletsResult.status === 'fulfilled' ? eligibleWalletsResult.value : { count: 0 };
      const activityLog = activityLogResult.status === 'fulfilled' ? activityLogResult.value : { activities: [] };

      // Log any failures for debugging
      const failures = [
        { name: 'treasury', result: treasuryResult },
        { name: 'pools', result: poolsResult },
        { name: 'claims', result: claimsResult },
        { name: 'eligibleWallets', result: eligibleWalletsResult },
        { name: 'activityLog', result: activityLogResult }
      ].filter(({ result }) => result.status === 'rejected');

      if (failures.length > 0) {
        console.warn('Dashboard batch - some requests failed:', 
          failures.map(f => ({ 
            name: f.name, 
            reason: f.result.status === 'rejected' ? f.result.reason : null 
          }))
        );
      }

      // Return consolidated response
      res.json({
        success: true,
        data: {
          treasury,
          pools,
          claims,
          eligibleWallets,
          activityLog
        },
        timestamp: Date.now(),
        cached: false,
        partialFailures: failures.length > 0 ? failures.map(f => f.name) : undefined
      });
    } catch (error) {
      console.error('Failed to fetch dashboard batch:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Helper method to fetch treasury status
   */
  private async fetchTreasuryStatus(req: Request, projectId: string, poolIds?: string) {
    // Create a mock response object to capture the controller's output
    let capturedData: any = null;
    const mockRes = {
      json: (data: any) => { capturedData = data; },
      status: () => mockRes
    } as any;

    // Create a new request-like object
    const mockReq = {
      ...req,
      projectId,
      query: {
        projectId,
        poolIds
      }
    } as any;

    await this.treasuryController.getTreasuryStatus(mockReq, mockRes);
    return capturedData;
  }

  /**
   * Helper method to fetch pools
   */
  private async fetchPools(req: Request) {
    let capturedData: any = null;
    const mockRes = {
      json: (data: any) => { capturedData = data; },
      status: () => mockRes
    } as any;

    // Use original request for pools (no modifications needed)
    await this.poolController.listPools(req, mockRes);
    return capturedData;
  }

  /**
   * Helper method to fetch claims
   */
  private async fetchClaims(req: Request, projectId: string, limit: number, poolIds?: string) {
    let capturedData: any = null;
    const mockRes = {
      json: (data: any) => { capturedData = data; },
      status: () => mockRes
    } as any;

    // Create a new request-like object
    const mockReq = {
      ...req,
      projectId,
      query: {
        projectId,
        limit: limit.toString(),
        poolIds
      }
    } as any;

    await this.claimsController.listClaims(mockReq, mockRes);
    return capturedData;
  }

  /**
   * Helper method to fetch eligible wallets
   */
  private async fetchEligibleWallets(req: Request, projectId: string, poolIds?: string) {
    let capturedData: any = null;
    const mockRes = {
      json: (data: any) => { capturedData = data; },
      status: () => mockRes
    } as any;

    // Create a new request-like object
    const mockReq = {
      ...req,
      projectId,
      query: {
        projectId,
        poolIds
      }
    } as any;

    await this.metricsController.getEligibleWalletsEndpoint(mockReq, mockRes);
    return capturedData;
  }

  /**
   * Helper method to fetch activity log
   */
  private async fetchActivityLog(req: Request, limit: number, poolIds?: string) {
    let capturedData: any = null;
    const mockRes = {
      json: (data: any) => { capturedData = data; },
      status: () => mockRes
    } as any;

    // Create a new request-like object
    const mockReq = {
      ...req,
      query: {
        limit: limit.toString(),
        poolIds
      }
    } as any;

    await this.metricsController.getActivityLog(mockReq, mockRes);
    return capturedData;
  }
}
