import { Request, Response } from 'express';
import { SupabaseService } from '../services/supabaseService';
import { getSupabaseClient } from '../lib/supabaseClient';

/**
 * Admin API Controller
 * Handles admin operations for pool management
 */
export class AdminController {
  private dbService: SupabaseService;

  constructor() {
    const supabaseClient = getSupabaseClient();
    this.dbService = new SupabaseService(supabaseClient);
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
}
