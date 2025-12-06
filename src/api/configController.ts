import { Request, Response } from 'express';
import { VestingModeService } from '../services/vestingModeService';
import { SupabaseService } from '../services/supabaseService';
import { VestingMode } from '../types';
import { getSupabaseClient } from '../lib/supabaseClient';

/**
 * Config API Controller
 * Handles admin configuration requests
 */
export class ConfigController {
  private modeService: VestingModeService;
  private dbService: SupabaseService;

  constructor() {
    const supabaseClient = getSupabaseClient();
    this.dbService = new SupabaseService(supabaseClient);
    this.modeService = new VestingModeService(this.dbService);
  }

  /**
   * GET /api/config/check-admin?wallet=<address>
   * Check if a wallet is an admin (no auth required, just checks)
   * Uses ADMIN_WALLETS environment variable for multiple admin support
   */
  async checkAdmin(req: Request, res: Response) {
    try {
      const { wallet } = req.query;
      const projectId = req.query.projectId as string;

      if (!wallet || typeof wallet !== 'string') {
        return res.status(400).json({ error: 'wallet parameter is required' });
      }

      // 1. Check Super Admin (Environment Variable)
      const adminWalletsEnv = process.env.ADMIN_WALLETS || '';
      const adminWallets = adminWalletsEnv
        .split(',')
        .map(w => w.trim())
        .filter(w => w.length > 0);
      
      if (adminWallets.includes(wallet)) {
        return res.json({ success: true, isAdmin: true, role: 'super_admin' });
      }

      // 2. Check Project Admin (Database)
      if (projectId) {
        // Use supabaseClient directly since auth middleware might not have run on this public-ish route
        // or we are just checking status
        const { data: access } = await this.dbService.supabase
          .from('user_project_access')
          .select('role')
          .eq('project_id', projectId)
          .eq('wallet_address', wallet)
          .single();

        if (access && (access.role === 'admin' || access.role === 'owner')) {
          return res.json({ success: true, isAdmin: true, role: access.role });
        }
      }

      // Fallback legacy check (single tenant config)
      if (!adminWalletsEnv) {
        console.warn('⚠️  ADMIN_WALLETS environment variable not set, falling back to database');
        
        // Fallback to database check
        try {
          const dbConfig = await this.dbService.getConfig();
          if (!dbConfig) {
            return res.json({
              success: true,
              isAdmin: false,
              warning: 'No admin configuration found',
            });
          }
          
          const isAdmin = dbConfig.admin_wallet === wallet;
          return res.json({
            success: true,
            isAdmin,
          });
        } catch (dbError) {
          console.error('Database connection error in checkAdmin:', dbError);
          return res.json({
            success: true,
            isAdmin: false,
            warning: 'Database temporarily unavailable',
          });
        }
      }

      // Parse comma-separated list of admin wallets
      // Already checked above
      
      // const isAdmin = adminWallets.includes(wallet); // Redundant

      res.json({
        success: true,
        isAdmin: false, // If we reached here without returning, they are not admin (unless fallback above returned)
      });
    } catch (error) {
      console.error('Failed to check admin:', error);
      // Return safe fallback instead of 500 error
      res.json({
        success: true,
        isAdmin: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/config
   * Get full admin configuration
   */
  async getConfig(req: Request, res: Response) {
    try {
      const modeConfig = await this.modeService.getModeConfig();
      const dbConfig = await this.dbService.getConfig();

      res.json({
        success: true,
        mode: modeConfig.currentMode,
        allowModeSwitch: modeConfig.allowModeSwitch,
        snapshotDate: modeConfig.snapshotDate,
        gracePeriodDays: modeConfig.gracePeriodDays,
        requireNFTOnClaim: modeConfig.requireNFTOnClaim,
        claimFee: dbConfig?.claim_fee_usd || 10.0,
        cooldownDays: dbConfig?.cooldown_days || 1,
        enableClaims: dbConfig?.enable_claims ?? true,
      });
    } catch (error) {
      console.error('Failed to get config:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * PUT /api/config
   * Update admin configuration
   */
  async updateConfig(req: Request, res: Response) {
    try {
      const {
        gracePeriodDays,
        requireNFTOnClaim,
        claimFee,
        cooldownDays,
        enableClaims,
        adminWallet,
      } = req.body;

      if (!adminWallet) {
        return res.status(400).json({ error: 'adminWallet is required' });
      }

      const updates: Record<string, unknown> = {};
      if (gracePeriodDays !== undefined) updates.grace_period_days = gracePeriodDays;
      if (requireNFTOnClaim !== undefined) updates.require_nft_on_claim = requireNFTOnClaim;
      if (claimFee !== undefined) updates.claim_fee_usd = claimFee;
      if (cooldownDays !== undefined) updates.cooldown_days = cooldownDays;
      if (enableClaims !== undefined) updates.enable_claims = enableClaims;

      const { error } = await this.dbService.supabase
        .from('config')
        .update(updates)
        .eq('id', 1);

      if (error) throw error;

      await this.dbService.logAdminAction({
        action: 'update_config',
        admin_wallet: adminWallet,
        details: updates,
      });

      res.json({
        success: true,
        message: 'Configuration updated successfully',
      });
    } catch (error) {
      console.error('Failed to update config:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/config/mode
   * Get current vesting mode
   */
  async getMode(req: Request, res: Response) {
    try {
      const mode = await this.modeService.getCurrentMode();
      const canSwitch = await this.modeService.canSwitchMode();

      res.json({
        currentMode: mode,
        canSwitch,
      });
    } catch (error) {
      console.error('Failed to get mode:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * PUT /api/config/mode
   * Switch vesting mode (snapshot/dynamic)
   */
  async switchMode(req: Request, res: Response) {
    try {
      const { mode, adminWallet } = req.body;

      if (!mode || !adminWallet) {
        return res.status(400).json({
          error: 'mode and adminWallet are required',
        });
      }

      if (mode !== VestingMode.SNAPSHOT && mode !== VestingMode.DYNAMIC && mode !== VestingMode.MANUAL) {
        return res.status(400).json({
          error: 'mode must be "snapshot", "dynamic", or "manual"',
        });
      }

      const canSwitch = await this.modeService.canSwitchMode();
      if (!canSwitch) {
        return res.status(403).json({
          error: 'Mode switching is currently disabled',
        });
      }

      await this.modeService.setMode(mode, adminWallet);

      res.json({
        success: true,
        newMode: mode,
        message: `Vesting mode switched to ${mode}`,
      });
    } catch (error) {
      console.error('Failed to switch mode:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/integrations/status
   * Check status of external integrations
   */
  async getIntegrationStatus(req: Request, res: Response) {
    try {
      // Check Supabase connection
      let supabaseConnected = false;
      try {
        await this.dbService.getConfig();
        supabaseConnected = true;
      } catch {
        supabaseConnected = false;
      }

      // Check Helius API key
      const heliusApiKeySet = !!process.env.HELIUS_API_KEY;

      // Check cluster
      const cluster = process.env.CLUSTER || 'devnet';

      res.json({
        supabase: {
          connected: supabaseConnected,
          status: supabaseConnected ? 'healthy' : 'error',
        },
        helius: {
          apiKeySet: heliusApiKeySet,
          status: heliusApiKeySet ? 'healthy' : 'missing',
        },
        cluster: {
          name: cluster,
          status: 'healthy',
        },
        streamflow: {
          authenticated: true,
          status: 'healthy',
        },
      });
    } catch (error) {
      console.error('Failed to get integration status:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/config/claim-policy
   * Get claim policy settings
   */
  async getClaimPolicy(req: Request, res: Response) {
    try {
      const config = await this.dbService.getConfig();

      res.json({
        enableClaims: config?.enable_claims ?? true,
        requireNFTOnClaim: config?.require_nft_on_claim ?? true,
        claimFeeUSD: config?.claim_fee_usd || 10.0,
        cooldownDays: config?.cooldown_days || 1,
        gracePeriodDays: config?.grace_period_days || 30,
      });
    } catch (error) {
      console.error('Failed to get claim policy:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * PUT /api/config/claim-policy
   * Update claim policy settings
   */
  async updateClaimPolicy(req: Request, res: Response) {
    try {
      const {
        enableClaims,
        requireNFTOnClaim,
        claimFeeUSD,
        cooldownDays,
        gracePeriodDays,
        adminWallet,
      } = req.body;

      if (!adminWallet) {
        return res.status(400).json({ error: 'adminWallet is required' });
      }

      const updates: Record<string, unknown> = {};
      if (enableClaims !== undefined) updates.enable_claims = enableClaims;
      if (requireNFTOnClaim !== undefined) updates.require_nft_on_claim = requireNFTOnClaim;
      if (claimFeeUSD !== undefined) updates.claim_fee_usd = claimFeeUSD;
      if (cooldownDays !== undefined) updates.cooldown_days = cooldownDays;
      if (gracePeriodDays !== undefined) updates.grace_period_days = gracePeriodDays;

      const { error } = await this.dbService.supabase
        .from('config')
        .update(updates)
        .eq('id', 1);

      if (error) throw error;

      await this.dbService.logAdminAction({
        action: 'update_claim_policy',
        admin_wallet: adminWallet,
        details: updates,
      });

      res.json({
        success: true,
        message: 'Claim policy updated successfully',
      });
    } catch (error) {
      console.error('Failed to update claim policy:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
