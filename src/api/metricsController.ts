import { Request, Response } from 'express';
import { Connection, PublicKey } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';
import NodeCache from 'node-cache';
import { SupabaseService } from '../services/supabaseService';
import { config } from '../config';

/**
 * Metrics API Controller
 * Aggregates dashboard metrics from various sources
 */
export class MetricsController {
  private dbService: SupabaseService;
  private connection: Connection;
  private cache: NodeCache;

  constructor() {
    const supabaseClient = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    this.dbService = new SupabaseService(supabaseClient);
    this.connection = new Connection(config.rpcEndpoint, 'confirmed');
    this.cache = new NodeCache({ stdTTL: 60 }); // Cache for 60 seconds by default
  }

  /**
   * GET /api/metrics/dashboard
   * Get aggregated dashboard metrics
   */
  async getDashboardMetrics(req: Request, res: Response) {
    try {
      const projectId = req.projectId || req.headers['x-project-id'] as string || req.query.projectId as string;
      const cacheKey = `dashboard_metrics_${projectId || 'all'}`;
      const cachedData = this.cache.get(cacheKey);

      if (cachedData) {
        return res.json(cachedData);
      }

      // SECURITY: Get metrics for this project only
      const poolBalance = await this.getPoolBalance(projectId);
      const eligibleWallets = await this.getEligibleWalletsCount(projectId);
      const nextUnlock = await this.getNextUnlockTime();
      const cycleWindow = await this.getCycleWindow(projectId);

      const responseData = {
        poolBalance,
        eligibleWallets,
        nextUnlock,
        cycleWindow,
        lastUpdated: new Date().toISOString(),
      };

      this.cache.set(cacheKey, responseData);
      res.json(responseData);
    } catch (error) {
      console.error('Failed to get dashboard metrics:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/metrics/pool-balance
   * Get current pool balance
   */
  async getPoolBalanceEndpoint(req: Request, res: Response) {
    try {
      const cacheKey = 'pool_balance_endpoint';
      const cachedData = this.cache.get(cacheKey);

      if (cachedData) {
        return res.json(cachedData);
      }

      const balance = await this.getPoolBalance();

      const responseData = {
        balance,
        unit: 'tokens',
        timestamp: new Date().toISOString(),
      };

      this.cache.set(cacheKey, responseData);
      res.json(responseData);
    } catch (error) {
      console.error('Failed to get pool balance:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
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
      const projectId = req.projectId || req.headers['x-project-id'] as string || req.query.projectId as string;
      const cacheKey = `eligible_wallets_endpoint_${projectId || 'all'}`;
      const cachedData = this.cache.get(cacheKey);

      if (cachedData) {
        return res.json(cachedData);
      }

      // SECURITY: Count eligible wallets for this project only
      const count = await this.getEligibleWalletsCount(projectId);

      const responseData = {
        count,
        timestamp: new Date().toISOString(),
      };

      this.cache.set(cacheKey, responseData);
      res.json(responseData);
    } catch (error) {
      console.error('Failed to get eligible wallets:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
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
      const projectId = req.projectId || req.headers['x-project-id'] as string || req.query.projectId as string;
      const cacheKey = `activity_log_${limit}_${projectId || 'all'}`;
      const cachedData = this.cache.get(cacheKey);

      if (cachedData) {
        return res.json(cachedData);
      }

      let query = this.dbService.supabase
        .from('admin_actions')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(Number(limit));

      // SECURITY: Filter by project if provided
      if (projectId) {
        query = query.eq('project_id', projectId);
      }

      const { data, error } = await query;

      if (error) throw error;

      const responseData = {
        activities: data || [],
        total: data?.length || 0,
      };

      this.cache.set(cacheKey, responseData, 10); // Short cache for activity log (10s)
      res.json(responseData);
    } catch (error) {
      console.error('Failed to get activity log:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/metrics/claim-history-stats
   * Get aggregated claim history for charts (last 30 days)
   * SECURITY: Filters by project
   */
  async getClaimHistoryStats(req: Request, res: Response) {
    try {
      const projectId = req.projectId || req.headers['x-project-id'] as string || req.query.projectId as string;
      const cacheKey = `claim_history_stats_${projectId || 'all'}`;
      const cachedData = this.cache.get(cacheKey);

      if (cachedData) {
        return res.json(cachedData);
      }

      // Get claims from last 30 days
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      
      let query = this.dbService.supabase
        .from('claim_history')
        .select('amount_claimed, claimed_at')
        .gte('claimed_at', thirtyDaysAgo)
        .order('claimed_at', { ascending: true });

      // SECURITY: Filter by project if provided
      if (projectId) {
        query = query.eq('project_id', projectId);
      }

      const { data, error } = await query;

      if (error) throw error;

      // Aggregate by day
      const claimsByDay = new Map<string, number>();
      
      // Initialize last 30 days with 0
      for (let i = 0; i < 30; i++) {
        const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
        const dateStr = d.toISOString().split('T')[0]; // YYYY-MM-DD
        claimsByDay.set(dateStr, 0);
      }

      data?.forEach((claim: any) => {
        const dateStr = new Date(claim.claimed_at).toISOString().split('T')[0];
        const amount = Number(claim.amount_claimed) / 1e9;
        
        if (claimsByDay.has(dateStr)) {
          claimsByDay.set(dateStr, (claimsByDay.get(dateStr) || 0) + amount);
        }
      });

      // Convert to array for chart
      const chartData = Array.from(claimsByDay.entries())
        .map(([date, amount]) => ({
          name: new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          claims: amount,
          date // keep ISO for sorting if needed
        }))
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      this.cache.set(cacheKey, chartData, 300); // Cache charts for 5 minutes
      res.json(chartData);
    } catch (error) {
      console.error('Failed to get claim history stats:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
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
        .from('vesting_streams')
        .select('total_pool_amount')
        .eq('is_active', true);

      if (projectId) {
        query = query.eq('project_id', projectId);
      }

      const { data: streams } = await query;

      if (streams && streams.length > 0) {
        return streams.reduce((sum: number, s: any) => sum + (s.total_pool_amount || 0), 0);
      }

      return 0;
    } catch (error) {
      console.error('Error getting pool balance:', error);
      return 0;
    }
  }

  /**
   * Helper: Get eligible wallets count
   * SECURITY: Should filter by project
   */
  private async getEligibleWalletsCount(projectId?: string): Promise<number> {
    try {
      // SECURITY: Count active vesting records for this project
      let query = this.dbService.supabase
        .from('vestings')
        .select('*', { count: 'exact', head: true })
        .eq('is_active', true)
        .eq('is_cancelled', false);

      if (projectId) {
        query = query.eq('project_id', projectId);
      }

      const { count } = await query;

      return count || 0;
    } catch (error) {
      console.error('Error getting eligible wallets:', error);
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
      return 'Continuous';
    } catch (error) {
      console.error('Error getting next unlock:', error);
      return 'Continuous';
    }
  }

  /**
   * Helper: Get cycle window
   * SECURITY: Should filter by project
   */
  private async getCycleWindow(projectId?: string): Promise<{ start: string; end: string; daysRemaining: number }> {
    try {
      // SECURITY: Get the earliest start time and latest end time from active streams for this project
      let query = this.dbService.supabase
        .from('vesting_streams')
        .select('start_time, end_time')
        .eq('is_active', true)
        .order('start_time', { ascending: true })
        .limit(1);

      if (projectId) {
        query = query.eq('project_id', projectId);
      }

      const { data: streams } = await query;

      if (!streams || streams.length === 0) {
        return {
          start: 'N/A',
          end: 'N/A',
          daysRemaining: 0,
        };
      }

      const startDate = new Date(streams[0].start_time);
      const endDate = new Date(streams[0].end_time);
      const now = new Date();
      const daysRemaining = Math.max(0, Math.floor((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));

      return {
        start: startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        end: endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        daysRemaining,
      };
    } catch (error) {
      console.error('Error getting cycle window:', error);
      return {
        start: 'N/A',
        end: 'N/A',
        daysRemaining: 0,
      };
    }
  }
}
