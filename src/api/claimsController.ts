import { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { SupabaseService } from '../services/supabaseService';
import { config } from '../config';

/**
 * Claims API Controller
 * Handles claim history, statistics, and verification logs
 */
export class ClaimsController {
  private dbService: SupabaseService;

  constructor() {
    const supabaseClient = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    this.dbService = new SupabaseService(supabaseClient);
  }

  /**
   * GET /api/claims
   * List recent claims with optional filters
   */
  async listClaims(req: Request, res: Response) {
    try {
      const { limit = 50, offset = 0, status, wallet } = req.query;

      let query = this.dbService.supabase
        .from('claim_history')
        .select('*')
        .order('claimed_at', { ascending: false })
        .range(Number(offset), Number(offset) + Number(limit) - 1);

      if (status) {
        // claim_history doesn't have status, assuming all are 'approved' or 'completed'
        // query = query.eq('status', status); 
      }

      if (wallet) {
        query = query.eq('user_wallet', wallet);
      }

      const { data, error } = await query;

      if (error) throw error;

      // Map columns to match expected interface (frontend expects these field names)
      const claims = (data || []).map((c: any) => ({
        id: c.id,
        user_wallet: c.user_wallet,  // Frontend expects user_wallet, not wallet
        pool_id: c.pool_id,
        pool_name: c.pool_name,
        amount: Number(c.amount_claimed) / 1e9, // Convert base units to tokens
        timestamp: c.claimed_at,  // Frontend expects timestamp, not created_at
        status: 'completed', // Default for history
        signature: c.transaction_signature  // Frontend expects signature
      }));

      res.json(claims);  // Return array directly, frontend handles both formats
    } catch (error) {
      console.error('Failed to list claims:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/claims/stats
   * Get claim statistics
   */
  async getClaimStats(req: Request, res: Response) {
    try {
      // Get total claims count
      const { count: totalClaims } = await this.dbService.supabase
        .from('claim_history')
        .select('*', { count: 'exact', head: true });

      // claim_history only stores successful claims, so approved = total
      const approvedClaims = totalClaims;
      const flaggedClaims = 0; // No flag support in claim_history yet

      // Get total amount claimed (sum)
      const { data: claimData } = await this.dbService.supabase
        .from('claim_history')
        .select('amount_claimed');

      const totalAmountClaimed = claimData?.reduce((sum: number, c: any) => sum + (Number(c.amount_claimed) || 0), 0) / 1e9 || 0;

      // Get claims in last 24h
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count: claims24h } = await this.dbService.supabase
        .from('claim_history')
        .select('*', { count: 'exact', head: true })
        .gte('claimed_at', yesterday);

      // Get claims in last 7 days
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { count: claims7d } = await this.dbService.supabase
        .from('claim_history')
        .select('*', { count: 'exact', head: true })
        .gte('claimed_at', weekAgo);

      // Get unique users
      const { data: uniqueUsers } = await this.dbService.supabase
        .from('claim_history')
        .select('user_wallet');
      
      const uniqueUserCount = new Set(uniqueUsers?.map((u: any) => u.user_wallet)).size;

      res.json({
        total: totalClaims || 0,
        last24h: claims24h || 0,
        last7d: claims7d || 0,
        totalAmount: totalAmountClaimed,
        uniqueUsers: uniqueUserCount,
      });
    } catch (error) {
      console.error('Failed to get claim stats:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/claims/:id
   * Get claim details by ID
   */
  async getClaimDetails(req: Request, res: Response) {
    try {
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({ error: 'Claim ID is required' });
      }

      const { data, error } = await this.dbService.supabase
        .from('claim_history')
        .select('*')
        .eq('id', id)
        .single();

      if (error) throw error;

      if (!data) {
        return res.status(404).json({ error: 'Claim not found' });
      }

      res.json(data);
    } catch (error) {
      console.error('Failed to get claim details:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
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

      if (!id || !adminWallet) {
        return res.status(400).json({ error: 'Claim ID and adminWallet are required' });
      }

      // Note: claim_history table doesn't have status/flag_reason columns
      // For now, log the flag action in admin_actions table
      // TODO: Add flagged_claims table or add columns to claim_history
      
      await this.dbService.supabase
        .from('admin_actions')
        .insert({
          action: 'flag_claim',
          admin_wallet: adminWallet,
          details: { claimId: id, reason },
          target_type: 'claim',
          target_id: id,
          created_at: new Date().toISOString(),
        });

      res.json({
        success: true,
        message: 'Claim flagged successfully (logged in admin actions)',
        note: 'Flag tracking requires database schema update',
      });
    } catch (error) {
      console.error('Failed to flag claim:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/claims/wallet/:wallet
   * Get all claims for a specific wallet
   */
  async getWalletClaims(req: Request, res: Response) {
    try {
      const { wallet } = req.params;

      if (!wallet) {
        return res.status(400).json({ error: 'Wallet address is required' });
      }

      const { data, error } = await this.dbService.supabase
        .from('claim_history')
        .select('*')
        .eq('user_wallet', wallet)
        .order('claimed_at', { ascending: false });

      if (error) throw error;

      // Map to frontend format
      const claims = (data || []).map((c: any) => ({
        id: c.id,
        user_wallet: c.user_wallet,
        pool_id: c.pool_id,
        pool_name: c.pool_name,
        amount: Number(c.amount_claimed) / 1e9,
        timestamp: c.claimed_at,
        status: 'completed',
        signature: c.transaction_signature
      }));

      res.json(claims);  // Return array directly
    } catch (error) {
      console.error('Failed to get wallet claims:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
