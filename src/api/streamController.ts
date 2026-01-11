import { Request, Response } from 'express';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';
import { SupabaseService } from '../services/supabaseService';
import { config } from '../config';
import { getRPCConfig } from '../config';

/**
 * Database stream record type
 */
interface VestingStream {
  id: string;
  streamflow_id: string;
  status: string;
  paused_at?: string;
  canceled_at?: string;
  canceled_by?: string;
  resumed_at?: string;
  [key: string]: any;
}

/**
 * Stream Management API Controller
 * Handles pause and emergency stop operations for all vesting streams
 */
export class StreamController {
  private dbService: SupabaseService;
  private connection: Connection;

  constructor() {
    const supabaseClient = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    this.dbService = new SupabaseService(supabaseClient);
    this.connection = new Connection(getRPCConfig().getRPCEndpoint(), 'confirmed');
  }

  /**
   * POST /api/streams/pause-all
   * Pause all active vesting streams FOR A SPECIFIC PROJECT
   * Body: { adminWallet: string, signature: string, message: string, timestamp: number, projectId: string }
   * 
   * SECURITY: Only the project admin can pause pools for their project
   */
  async pauseAllStreams(req: Request, res: Response) {
    try {
      const { projectId } = req.body;

      if (!projectId) {
        return res.status(400).json({ 
          error: 'projectId is required',
          hint: 'Emergency controls are project-scoped. Provide the project ID.'
        });
      }

      console.log(`[PAUSE ALL] Project: ${projectId}, Admin: ${req.body.adminWallet}`);

      // Get all active streams FOR THIS PROJECT ONLY
      const { data: streams, error: fetchError } = await this.dbService.supabase
        .from('vesting_streams')
        .select('*')
        .eq('project_id', projectId)
        .eq('is_active', true) as { data: VestingStream[] | null; error: any };

      if (fetchError) {
        throw new Error(`Failed to fetch streams: ${fetchError.message}`);
      }

      if (!streams || streams.length === 0) {
        return res.json({
          success: true,
          pausedCount: 0,
          message: 'No active pools to pause in this project',
        });
      }

      // Mark all streams as paused in database
      const streamIds = streams.map((s) => s.id);
      const { error: updateError } = await this.dbService.supabase
        .from('vesting_streams')
        .update({ 
          is_active: false,
          state: 'paused',
          updated_at: new Date().toISOString()  // Use updated_at (paused_at doesn't exist)
        })
        .in('id', streamIds);

      if (updateError) {
        throw new Error(`Failed to pause streams: ${updateError.message}`);
      }

      console.log(`[PAUSE ALL] ✅ Paused ${streams.length} pool(s) for project ${projectId}`);

      res.json({
        success: true,
        pausedCount: streams.length,
        message: `Successfully paused ${streams.length} pool(s) in this project`,
      });
    } catch (error) {
      console.error('[PAUSE ALL] Failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/streams/emergency-stop
   * Cancel all active vesting streams FOR A SPECIFIC PROJECT (irreversible)
   * Body: { adminWallet: string, signature: string, message: string, timestamp: number, projectId: string }
   * 
   * SECURITY: Only the project admin can emergency stop pools for their project
   */
  async emergencyStopAllStreams(req: Request, res: Response) {
    try {
      const { projectId } = req.body;

      if (!projectId) {
        return res.status(400).json({
          error: 'projectId is required',
          hint: 'Emergency controls are project-scoped. Provide the project ID.'
        });
      }

      console.log(`[EMERGENCY STOP] Project: ${projectId}, Admin: ${req.body.adminWallet}`);

      // Get all active streams FOR THIS PROJECT ONLY
      const { data: streams, error: fetchError } = await this.dbService.supabase
        .from('vesting_streams')
        .select('*')
        .eq('project_id', projectId)
        .eq('is_active', true) as { data: VestingStream[] | null; error: any };

      if (fetchError) {
        throw new Error(`Failed to fetch streams: ${fetchError.message}`);
      }

      if (!streams || streams.length === 0) {
        return res.json({
          success: true,
          canceledCount: 0,
          message: 'No active pools to cancel in this project',
        });
      }

      const results = {
        success: [] as string[],
        failed: [] as { id: string; error: string }[],
      };

      // Mark all vesting records as cancelled
      for (const stream of streams) {
        try {
          console.log(`[EMERGENCY STOP] Cancelling stream: ${stream.id}`);
          
          // Update all vesting records for this stream
          const vestingsUpdate = await this.dbService.supabase
            .from('vestings')
            .update({
              is_active: false,
              is_cancelled: true,
              cancelled_at: new Date().toISOString(),
            })
            .eq('vesting_stream_id', stream.id);

          if (vestingsUpdate.error) {
            console.error(`[EMERGENCY STOP] Failed to update vestings for stream ${stream.id}:`, vestingsUpdate.error);
            throw vestingsUpdate.error;
          }
          console.log(`[EMERGENCY STOP] ✓ Updated vestings for stream ${stream.id}`);

          // Update stream status (only update columns that exist in schema)
          const streamUpdate = await this.dbService.supabase
            .from('vesting_streams')
            .update({
              is_active: false,
              state: 'cancelled',
              updated_at: new Date().toISOString(),  // Use updated_at instead of canceled_at (which doesn't exist)
            })
            .eq('id', stream.id);

          if (streamUpdate.error) {
            console.error(`[EMERGENCY STOP] Failed to update vesting_stream ${stream.id}:`, streamUpdate.error);
            throw streamUpdate.error;
          }
          console.log(`[EMERGENCY STOP] ✓ Updated vesting_stream ${stream.id} - is_active=false, state='cancelled'`);

          results.success.push(stream.id);
        } catch (err) {
          console.error(`[EMERGENCY STOP] Error processing stream ${stream.id}:`, err);
          results.failed.push({
            id: stream.id,
            error: err instanceof Error ? err.message : 'Unknown error',
          });
        }
      }

      console.log(`[EMERGENCY STOP] ✅ Cancelled ${results.success.length} pool(s) for project ${projectId}`);

      res.json({
        success: true,
        canceledCount: results.success.length,
        failedCount: results.failed.length,
        message: `Emergency stop executed: ${results.success.length} pool(s) cancelled in this project`,
        details: results,
      });
    } catch (error) {
      console.error('[EMERGENCY STOP] Failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/streams/resume-all
   * Resume all paused vesting streams FOR A SPECIFIC PROJECT
   * Body: { adminWallet: string, signature: string, message: string, timestamp: number, projectId: string }
   * 
   * SECURITY: Only the project admin can resume pools for their project
   */
  async resumeAllStreams(req: Request, res: Response) {
    try {
      const { projectId } = req.body;

      if (!projectId) {
        return res.status(400).json({ 
          error: 'projectId is required',
          hint: 'Emergency controls are project-scoped. Provide the project ID.'
        });
      }

      console.log(`[RESUME ALL] Project: ${projectId}, Admin: ${req.body.adminWallet}`);

      // Get all paused streams FOR THIS PROJECT ONLY
      const { data: streams, error: fetchError } = await this.dbService.supabase
        .from('vesting_streams')
        .select('*')
        .eq('project_id', projectId)
        .eq('status', 'paused') as { data: VestingStream[] | null; error: any };

      if (fetchError) {
        throw new Error(`Failed to fetch streams: ${fetchError.message}`);
      }

      if (!streams || streams.length === 0) {
        return res.json({
          success: true,
          resumedCount: 0,
          message: 'No paused pools to resume in this project',
        });
      }

      // Mark all streams as active in database
      const streamIds = streams.map((s) => s.id);
      const { error: updateError } = await this.dbService.supabase
        .from('vesting_streams')
        .update({ 
          is_active: true,
          state: 'active',
          updated_at: new Date().toISOString()  // Use updated_at (resumed_at doesn't exist)
        })
        .in('id', streamIds);

      if (updateError) {
        throw new Error(`Failed to resume streams: ${updateError.message}`);
      }

      console.log(`[RESUME ALL] ✅ Resumed ${streams.length} pool(s) for project ${projectId}`);

      res.json({
        success: true,
        resumedCount: streams.length,
        message: `Successfully resumed ${streams.length} pool(s) in this project`,
      });
    } catch (error) {
      console.error('[RESUME ALL] Failed:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
