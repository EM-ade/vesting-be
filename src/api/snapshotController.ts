import { Request, Response } from 'express';
import { PublicKey } from '@solana/web3.js';
import { HeliusNFTService } from '../services/heliusNFTService';
import { SnapshotConfigService } from '../services/snapshotConfigService';
import { SupabaseService } from '../services/supabaseService';
import { SnapshotConfig } from '../types';
import { config, getNetwork } from '../config';
import { getSupabaseClient } from '../lib/supabaseClient';

/**
 * Snapshot API Controller
 * Handles snapshot configuration requests from admin console
 */
export class SnapshotController {
  private heliusService: HeliusNFTService;
  private snapshotConfigService: SnapshotConfigService;
  private dbService: SupabaseService;

  constructor() {
    this.heliusService = new HeliusNFTService(config.heliusApiKey, getNetwork());
    this.snapshotConfigService = new SnapshotConfigService(this.heliusService);
    const supabaseClient = getSupabaseClient();
    this.dbService = new SupabaseService(supabaseClient);
  }

  /**
   * GET /api/snapshot/holders
   * Get all holders of an NFT collection
   */
  async getHolders(req: Request, res: Response) {
    try {
      const { contractAddress } = req.body;

      if (!contractAddress) {
        return res.status(400).json({ error: 'contractAddress is required' });
      }

      let holders;
      try {
        holders = await this.heliusService.getAllHolders(
          new PublicKey(contractAddress)
        );
      } catch (heliusError) {
        console.error('Failed to fetch holders from Helius:', heliusError);
        return res.status(503).json({
          error: 'Failed to fetch NFT holders from Helius. Please try again.',
          details: heliusError instanceof Error ? heliusError.message : 'Unknown error',
        });
      }

      res.json({
        holders: holders.map((h) => ({
          address: h.wallet,
          balance: h.nftCount,
        })),
      });
    } catch (error) {
      console.error('Failed to get holders:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/snapshot/collection-stats
   * Get quick stats for a collection
   */
  async getCollectionStats(req: Request, res: Response) {
    try {
      const { contractAddress } = req.body;

      if (!contractAddress) {
        return res.status(400).json({ error: 'contractAddress is required' });
      }

      let holders;
      try {
        holders = await this.heliusService.getAllHolders(
          new PublicKey(contractAddress)
        );
      } catch (heliusError) {
        console.error('Failed to fetch collection stats from Helius:', heliusError);
        return res.status(503).json({
          error: 'Failed to fetch NFT collection data from Helius. Please try again.',
          details: heliusError instanceof Error ? heliusError.message : 'Unknown error',
        });
      }

      res.json({
        totalSupply: holders.reduce((sum, h) => sum + h.nftCount, 0),
        uniqueHolders: holders.length,
      });
    } catch (error) {
      console.error('Failed to get collection stats:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/snapshot/preview-rule
   * Get preview for a single snapshot rule
   */
  async previewRule(req: Request, res: Response) {
    try {
      const { rule, poolSize } = req.body;

      if (!rule || !poolSize) {
        return res.status(400).json({ error: 'rule and poolSize are required' });
      }

      const preview = await this.snapshotConfigService.calculateRulePreview(
        rule,
        poolSize
      );

      res.json(preview);
    } catch (error) {
      console.error('Failed to preview rule:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/snapshot/calculate-summary
   * Calculate summary for all rules
   */
  async calculateSummary(req: Request, res: Response) {
    try {
      const { config: snapshotConfig } = req.body as { config: SnapshotConfig };

      if (!snapshotConfig) {
        return res.status(400).json({ error: 'config is required' });
      }

      const summary = await this.snapshotConfigService.calculateSnapshotSummary(
        snapshotConfig
      );

      res.json(summary);
    } catch (error) {
      console.error('Failed to calculate summary:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/snapshot/process
   * Process snapshot configuration and calculate allocations
   */
  async processSnapshot(req: Request, res: Response) {
    try {
      const { config: snapshotConfig } = req.body as { config: SnapshotConfig };

      if (!snapshotConfig) {
        return res.status(400).json({ error: 'config is required' });
      }

      const result = await this.snapshotConfigService.processSnapshotRules(
        snapshotConfig
      );

      res.json(result);
    } catch (error) {
      console.error('Failed to process snapshot:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/snapshot/commit
   * Commit snapshot results to database (create vesting records)
   * Body: { allocations: AllocationResult[], vestingStreamId: number, startTime: number, cliffDays: number, vestingDays: number }
   */
  async commitSnapshot(req: Request, res: Response) {
    try {
      const { allocations, vestingStreamId, startTime, cliffDays, vestingDays } = req.body;

      if (!allocations || !Array.isArray(allocations)) {
        return res.status(400).json({ error: 'allocations array is required' });
      }

      if (!vestingStreamId) {
        return res.status(400).json({ error: 'vestingStreamId is required' });
      }

      // Create vesting records for each allocation
      const created = [];
      const errors = [];

      for (const allocation of allocations) {
        try {
          const { error } = await this.dbService.supabase
            .from('vestings')
            .insert({
              user_wallet: allocation.address,
              token_amount: allocation.amount,
              vesting_stream_id: vestingStreamId,
              nft_count: allocation.sources?.length || 1,
              tier: 1, // Default tier (can be customized based on NFT count later)
              vesting_mode: 'snapshot',
              snapshot_locked: true,
              is_active: true,
              is_cancelled: false,
              // last_verified and created_at have DEFAULT values in schema
            });

          if (error) {
            errors.push({ wallet: allocation.address, error: error.message });
          } else {
            created.push(allocation.address);
          }
        } catch (err) {
          errors.push({ 
            wallet: allocation.address, 
            error: err instanceof Error ? err.message : 'Unknown error' 
          });
        }
      }

      res.json({
        success: true,
        created: created.length,
        errors: errors.length,
        details: {
          createdWallets: created,
          errorDetails: errors,
        },
      });
    } catch (error) {
      console.error('Failed to commit snapshot:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
