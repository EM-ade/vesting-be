import { Request, Response } from 'express';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';
import { SupabaseService } from '../services/supabaseService';
import { config } from '../config';

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
    this.connection = new Connection(config.rpcEndpoint, 'confirmed');
  }

  /**
   * POST /api/streams/pause-all
   * Pause all active vesting streams
   * Body: { adminWallet: string, signature: string, message: string }
   */
  async pauseAllStreams(req: Request, res: Response) {
    try {
      const { adminWallet, signature, message } = req.body;

      if (!adminWallet || !signature || !message) {
        return res.status(400).json({ error: 'adminWallet, signature, and message are required' });
      }

      // Verify admin authorization for the project
      // Get project ID from request
      const projectId = req.headers['x-project-id'] as string || req.body.projectId;

      if (!projectId) {
        return res.status(400).json({ error: 'Project ID is required' });
      }

      // Check if the wallet has admin/owner access to this project
      const { data: access } = await this.dbService.supabase
        .from('user_project_access')
        .select('role')
        .eq('project_id', projectId)
        .eq('wallet_address', adminWallet)
        .single();

      if (!access || (access.role !== 'admin' && access.role !== 'owner')) {
        return res.status(403).json({ error: 'Not authorized - not an admin wallet' });
      }

      // Verify signature
      try {
        const nacl = await import('tweetnacl');
        const messageBuffer = new TextEncoder().encode(message);
        const signatureBuffer = Buffer.from(signature, 'base64');
        const publicKey = new PublicKey(adminWallet);

        const isValid = nacl.sign.detached.verify(
          messageBuffer,
          signatureBuffer,
          publicKey.toBytes()
        );

        if (!isValid) {
          return res.status(401).json({ error: 'Invalid signature' });
        }

        // Check message freshness
        const messageData = JSON.parse(message);
        const timestamp = messageData.timestamp;
        const now = Date.now();
        const fiveMinutes = 5 * 60 * 1000;

        if (!timestamp || Math.abs(now - timestamp) > fiveMinutes) {
          return res.status(401).json({ error: 'Signature expired' });
        }
      } catch (err) {
        return res.status(401).json({ error: 'Signature verification failed' });
      }

      // Get all active streams from database
      const { data: streams, error: fetchError } = await this.dbService.supabase
        .from('vesting_streams')
        .select('*')
        .eq('is_active', true)

      if (fetchError) {
        throw new Error(`Failed to fetch streams: ${fetchError.message}`);
      }

      if (!streams || streams.length === 0) {
        return res.json({
          success: true,
          pausedCount: 0,
          message: 'No active streams to pause',
        });
      }

      // Mark all streams as paused in database
      const streamIds = streams.map((s: VestingStream) => s.id);
      const { error: updateError } = await this.dbService.supabase
        .from('vesting_streams')
        .update({ is_active: false, state: 'paused' })
        .in('id', streamIds);

      if (updateError) {
        throw new Error(`Failed to pause streams: ${updateError.message}`);
      }

      // Log the action
      await this.dbService.supabase.from('activity_log').insert({
        action: 'pause_all_streams',
        admin_wallet: adminWallet,
        affected_count: streams.length,
        timestamp: new Date().toISOString(),
      });

      res.json({
        success: true,
        pausedCount: streams.length,
        message: `Successfully paused ${streams.length} stream(s)`,
      });
    } catch (error) {
      console.error('Failed to pause streams:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/streams/emergency-stop
   * Cancel all active vesting streams (irreversible)
   * Body: { adminWallet: string, signature: string, message: string, adminPrivateKey: string }
   */
  async emergencyStopAllStreams(req: Request, res: Response) {
    try {
      const { adminWallet, signature, message } = req.body;

      if (!adminWallet || !signature || !message) {
        return res.status(400).json({
          error: 'adminWallet, signature, and message are required',
        });
      }

      // Verify admin authorization for the project
      const projectId = req.headers['x-project-id'] as string || req.body.projectId;

      if (!projectId) {
        return res.status(400).json({ error: 'Project ID is required' });
      }

      // Check if the wallet has admin/owner access to this project
      const { data: access } = await this.dbService.supabase
        .from('user_project_access')
        .select('role')
        .eq('project_id', projectId)
        .eq('wallet_address', adminWallet)
        .single();

      if (!access || (access.role !== 'admin' && access.role !== 'owner')) {
        return res.status(403).json({ error: 'Not authorized - not an admin wallet' });
      }

      // Verify signature
      try {
        const nacl = await import('tweetnacl');
        const messageBuffer = new TextEncoder().encode(message);
        const signatureBuffer = Buffer.from(signature, 'base64');
        const publicKey = new PublicKey(adminWallet);

        const isValid = nacl.sign.detached.verify(
          messageBuffer,
          signatureBuffer,
          publicKey.toBytes()
        );

        if (!isValid) {
          return res.status(401).json({ error: 'Invalid signature' });
        }

        const messageData = JSON.parse(message);
        const timestamp = messageData.timestamp;
        const now = Date.now();
        const fiveMinutes = 5 * 60 * 1000;

        if (!timestamp || Math.abs(now - timestamp) > fiveMinutes) {
          return res.status(401).json({ error: 'Signature expired' });
        }
      } catch (err) {
        return res.status(401).json({ error: 'Signature verification failed' });
      }

      // Get all active streams from database
      const { data: streams, error: fetchError } = await this.dbService.supabase
        .from('vesting_streams')
        .select('*')
        .eq('is_active', true) as { data: VestingStream[] | null; error: any };

      if (fetchError) {
        throw new Error(`Failed to fetch streams: ${fetchError.message}`);
      }

      if (!streams || streams.length === 0) {
        return res.json({
          success: true,
          canceledCount: 0,
          message: 'No active streams to cancel',
        });
      }

      const results = {
        success: [] as string[],
        failed: [] as { id: string; error: string }[],
      };

      // Mark all vesting records as cancelled (no Streamflow)
      for (const stream of streams) {
        try {
          // Update all vesting records for this stream
          await this.dbService.supabase
            .from('vestings')
            .update({
              is_active: false,
              is_cancelled: true,
              cancelled_at: new Date().toISOString(),
            })
            .eq('vesting_stream_id', stream.id);

          // Update stream status
          await this.dbService.supabase
            .from('vesting_streams')
            .update({
              is_active: false,
            })
            .eq('id', stream.id);

          results.success.push(stream.id);
        } catch (err) {
          results.failed.push({
            id: stream.id,
            error: err instanceof Error ? err.message : 'Unknown error',
          });
        }
      }

      // Log the action
      await this.dbService.supabase.from('activity_log').insert({
        action: 'emergency_stop_all_streams',
        admin_wallet: adminWallet,
        affected_count: results.success.length,
        failed_count: results.failed.length,
        timestamp: new Date().toISOString(),
      });

      res.json({
        success: true,
        canceledCount: results.success.length,
        failedCount: results.failed.length,
        message: `Emergency stop executed: ${results.success.length} canceled, ${results.failed.length} failed`,
        details: results,
      });
    } catch (error) {
      console.error('Failed to execute emergency stop:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/streams/resume-all
   * Resume all paused vesting streams
   * Body: { adminWallet: string, signature: string, message: string }
   */
  async resumeAllStreams(req: Request, res: Response) {
    try {
      const { adminWallet, signature, message } = req.body;

      if (!adminWallet || !signature || !message) {
        return res.status(400).json({ error: 'adminWallet, signature, and message are required' });
      }

      // Verify admin authorization for the project
      const projectId = req.headers['x-project-id'] as string || req.body.projectId;

      if (!projectId) {
        return res.status(400).json({ error: 'Project ID is required' });
      }

      // Check if the wallet has admin/owner access to this project
      const { data: access } = await this.dbService.supabase
        .from('user_project_access')
        .select('role')
        .eq('project_id', projectId)
        .eq('wallet_address', adminWallet)
        .single();

      if (!access || (access.role !== 'admin' && access.role !== 'owner')) {
        return res.status(403).json({ error: 'Not authorized - not an admin wallet' });
      }

      // Verify signature
      try {
        const nacl = await import('tweetnacl');
        const messageBuffer = new TextEncoder().encode(message);
        const signatureBuffer = Buffer.from(signature, 'base64');
        const publicKey = new PublicKey(adminWallet);

        const isValid = nacl.sign.detached.verify(
          messageBuffer,
          signatureBuffer,
          publicKey.toBytes()
        );

        if (!isValid) {
          return res.status(401).json({ error: 'Invalid signature' });
        }

        const messageData = JSON.parse(message);
        const timestamp = messageData.timestamp;
        const now = Date.now();
        const fiveMinutes = 5 * 60 * 1000;

        if (!timestamp || Math.abs(now - timestamp) > fiveMinutes) {
          return res.status(401).json({ error: 'Signature expired' });
        }
      } catch (err) {
        return res.status(401).json({ error: 'Signature verification failed' });
      }

      // Get all paused streams from database
      const { data: streams, error: fetchError } = await this.dbService.supabase
        .from('vesting_streams')
        .select('*')
        .eq('is_active', false)

      if (fetchError) {
        throw new Error(`Failed to fetch streams: ${fetchError.message}`);
      }

      if (!streams || streams.length === 0) {
        return res.json({
          success: true,
          resumedCount: 0,
          message: 'No paused streams to resume',
        });
      }

      // Mark all streams as active in database
      const streamIds = streams.map((s: VestingStream) => s.id);
      const { error: updateError } = await this.dbService.supabase
        .from('vesting_streams')
        .update({ is_active: true, state: 'active' })
        .in('id', streamIds);

      if (updateError) {
        throw new Error(`Failed to resume streams: ${updateError.message}`);
      }

      // Log the action
      await this.dbService.supabase.from('activity_log').insert({
        action: 'resume_all_streams',
        admin_wallet: adminWallet,
        affected_count: streams.length,
        timestamp: new Date().toISOString(),
      });

      res.json({
        success: true,
        resumedCount: streams.length,
        message: `Successfully resumed ${streams.length} stream(s)`,
      });
    } catch (error) {
      console.error('Failed to resume streams:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
