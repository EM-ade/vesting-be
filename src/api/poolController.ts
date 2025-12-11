import { Request, Response } from 'express';
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAccount } from '@solana/spl-token';
import bs58 from 'bs58';
import { SupabaseService } from '../services/supabaseService';
import { StreamflowService } from '../services/streamflowService';
import { getVaultKeypairForProject } from '../services/vaultService';
import { syncDynamicPool } from '../utils/syncDynamicPool';
import { config } from '../config';
import { getSupabaseClient } from '../lib/supabaseClient';

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  checks: {
    timestamp: { valid: boolean; message: string; adjustedStart?: number };
    solBalance: { valid: boolean; current: number; required: number; message: string };
    tokenBalance: { valid: boolean; current: number; required: number; message: string };
    treasury: { valid: boolean; address: string };
    allocations: { valid: boolean; total: number; message: string };
  };
  canProceedWithoutStreamflow: boolean;
}

/**
 * Pool Management API Controller
 * Handles vesting pool operations (list, details, topup, activity)
 */
export class PoolController {
  private dbService: SupabaseService;
  private connection: Connection;
  private streamflowService: StreamflowService;

  constructor() {
    const supabaseClient = getSupabaseClient();
    this.dbService = new SupabaseService(supabaseClient);
    this.connection = new Connection(config.rpcEndpoint, 'confirmed');
    this.streamflowService = new StreamflowService();
  }

  /**
   * Validate pool creation requirements
   */
  private async validatePoolCreation(params: {
    start_time?: string;
    total_pool_amount: number;
    vesting_mode: string;
    manual_allocations?: Array<{ allocationType: string; allocationValue: number }>;
    rules?: Array<{
      name: string;
      nftContract: string;
      threshold: number;
      allocationType: string;
      allocationValue: number;
      enabled: boolean;
    }>;
    projectId?: string; // Add projectId parameter
  }): Promise<ValidationResult> {
    const result: ValidationResult = {
      valid: true,
      errors: [],
      warnings: [],
      checks: {
        timestamp: { valid: true, message: '' },
        solBalance: { valid: true, current: 0, required: 0.015, message: '' }, // ~0.01266 SOL + buffer
        tokenBalance: { valid: true, current: 0, required: params.total_pool_amount, message: '' },
        treasury: { valid: true, address: '' },
        allocations: { valid: true, total: 0, message: '' },
      },
      canProceedWithoutStreamflow: true,
    };

    try {
      // Get vault keypair (project-specific or fallback to admin)
      let adminKeypair: Keypair;
      try {
        // Try to get project-specific vault first
        if (params.projectId) {
          try {
            adminKeypair = await getVaultKeypairForProject(params.projectId);
            result.checks.treasury.address = adminKeypair.publicKey.toBase58();
            console.log(`[VALIDATION] Using project vault: ${result.checks.treasury.address}`);
          } catch (vaultErr) {
            console.warn(`[VALIDATION] Failed to get project vault, falling back to admin key:`, vaultErr);
            // Fallback to admin key
            if (config.adminPrivateKey.startsWith('[')) {
              const secretKey = Uint8Array.from(JSON.parse(config.adminPrivateKey));
              if (secretKey.length !== 64) {
                throw new Error(`Invalid secret key length: ${secretKey.length} bytes (expected 64)`);
              }
              adminKeypair = Keypair.fromSecretKey(secretKey);
            } else {
              const decoded = bs58.decode(config.adminPrivateKey);
              if (decoded.length !== 64) {
                throw new Error(`Invalid secret key length after base58 decode: ${decoded.length} bytes (expected 64)`);
              }
              adminKeypair = Keypair.fromSecretKey(decoded);
            }
            result.checks.treasury.address = adminKeypair.publicKey.toBase58();
          }
        } else {
          // No project ID, use admin key
          if (config.adminPrivateKey.startsWith('[')) {
            const secretKey = Uint8Array.from(JSON.parse(config.adminPrivateKey));
            if (secretKey.length !== 64) {
              throw new Error(`Invalid secret key length: ${secretKey.length} bytes (expected 64)`);
            }
            adminKeypair = Keypair.fromSecretKey(secretKey);
          } else {
            const decoded = bs58.decode(config.adminPrivateKey);
            if (decoded.length !== 64) {
              throw new Error(`Invalid secret key length after base58 decode: ${decoded.length} bytes (expected 64)`);
            }
            adminKeypair = Keypair.fromSecretKey(decoded);
          }
          result.checks.treasury.address = adminKeypair.publicKey.toBase58();
        }
      } catch (err) {
        result.valid = false;
        const msg = err instanceof Error ? err.message : 'Unknown key error';
        result.errors.push(`Treasury Wallet Error: ${msg}`);
        // Return early as we can't check balances without a wallet
        return result;
      }

      // 1. Validate timestamp
      const startTimestamp = params.start_time
        ? Math.floor(new Date(params.start_time).getTime() / 1000)
        : Math.floor(Date.now() / 1000);
      const nowTimestamp = Math.floor(Date.now() / 1000);

      if (startTimestamp < nowTimestamp) {
        result.checks.timestamp.valid = false;
        result.checks.timestamp.adjustedStart = nowTimestamp + 60;
        result.checks.timestamp.message = `Start time is in the past. Will be adjusted to ${new Date((nowTimestamp + 60) * 1000).toISOString()}`;
        result.warnings.push(result.checks.timestamp.message);
      } else {
        result.checks.timestamp.message = 'Start time is valid';
      }

      // 2. Check SOL balance
      const solBalance = await this.connection.getBalance(adminKeypair.publicKey);
      const solBalanceInSOL = solBalance / LAMPORTS_PER_SOL;
      result.checks.solBalance.current = solBalanceInSOL;

      if (solBalanceInSOL < 0.015) {
        result.checks.solBalance.valid = false;
        result.checks.solBalance.message = `Insufficient SOL for Streamflow deployment. Required: ~0.015 SOL, Available: ${solBalanceInSOL.toFixed(4)} SOL`;
        result.errors.push(result.checks.solBalance.message);
        result.valid = false;
      } else {
        result.checks.solBalance.message = `SOL balance sufficient: ${solBalanceInSOL.toFixed(4)} SOL`;
      }

      // 3. Check token balance
      if (config.customTokenMint) {
        try {
          const { getAssociatedTokenAddress } = await import('@solana/spl-token');
          const treasuryTokenAccount = await getAssociatedTokenAddress(
            config.customTokenMint,
            adminKeypair.publicKey
          );

          const tokenAccountInfo = await getAccount(this.connection, treasuryTokenAccount);
          const tokenBalance = Number(tokenAccountInfo.amount) / 1e9;
          result.checks.tokenBalance.current = tokenBalance;

          if (tokenBalance < params.total_pool_amount) {
            result.checks.tokenBalance.valid = false;
            result.checks.tokenBalance.message = `Insufficient tokens. Required: ${params.total_pool_amount}, Available: ${tokenBalance}`;
            result.errors.push(result.checks.tokenBalance.message);
            result.valid = false;
          } else {
            result.checks.tokenBalance.message = `Token balance sufficient: ${tokenBalance}`;
          }
        } catch (err) {
          result.checks.tokenBalance.valid = false;
          result.checks.tokenBalance.message = `Token account not found or error checking balance`;
          result.errors.push(result.checks.tokenBalance.message);
          result.valid = false;
        }
      }

      // 4. Validate allocations (manual mode only)
      if (params.vesting_mode === 'manual' && params.manual_allocations) {
        let totalPercentage = 0;
        let totalFixed = 0;

        for (const allocation of params.manual_allocations) {
          if (allocation.allocationType === 'PERCENTAGE') {
            totalPercentage += allocation.allocationValue;
          } else {
            totalFixed += allocation.allocationValue;
          }
        }

        result.checks.allocations.total = totalPercentage;

        // Check if percentages EXCEED 100% (ERROR - impossible to fulfill)
        if (totalPercentage > 100) {
          result.checks.allocations.valid = false;
          result.checks.allocations.message = `Percentage allocations sum to ${totalPercentage.toFixed(2)}%, which exceeds 100%. Cannot allocate more than the pool.`;
          result.errors.push(result.checks.allocations.message);
          result.valid = false;
        }
        // Warn if less than 100% (OK - remainder stays in treasury)
        else if (totalPercentage > 0 && totalPercentage < 100) {
          const unallocated = 100 - totalPercentage;
          result.checks.allocations.message = `Percentage allocations sum to ${totalPercentage.toFixed(2)}%. ${unallocated.toFixed(2)}% (${(params.total_pool_amount * unallocated / 100).toFixed(2)} tokens) will remain in treasury wallet.`;
          result.warnings.push(result.checks.allocations.message);
        }

        // Check if fixed amounts exceed pool (ERROR)
        if (totalFixed > params.total_pool_amount) {
          result.checks.allocations.valid = false;
          result.checks.allocations.message = `Fixed allocations (${totalFixed} tokens) exceed pool amount (${params.total_pool_amount} tokens)`;
          result.errors.push(result.checks.allocations.message);
          result.valid = false;
        }
        // Warn if fixed amounts leave remainder
        else if (totalFixed > 0 && totalFixed < params.total_pool_amount) {
          const unallocated = params.total_pool_amount - totalFixed;
          result.checks.allocations.message = `Fixed allocations total ${totalFixed} tokens. ${unallocated.toFixed(2)} tokens will remain in treasury wallet.`;
          result.warnings.push(result.checks.allocations.message);
        }

        if (result.checks.allocations.valid && result.checks.allocations.message === '') {
          result.checks.allocations.message = 'Allocations are valid (100% allocated)';
        }
      }

      // 5. Validate NFT rules (snapshot/dynamic modes)
      if ((params.vesting_mode === 'snapshot' || params.vesting_mode === 'dynamic') && params.rules) {
        // Check if at least one rule exists
        if (params.rules.length === 0) {
          result.checks.allocations.valid = false;
          result.checks.allocations.message = 'At least one NFT rule is required for snapshot/dynamic mode';
          result.errors.push(result.checks.allocations.message);
          result.valid = false;
        } else {
          let totalPercentage = 0;
          const enabledRules = params.rules.filter(r => r.enabled);

          if (enabledRules.length === 0) {
            result.warnings.push('No rules are enabled. Pool will have no eligible wallets.');
          }

          for (const rule of params.rules) {
            // Validate NFT contract address
            if (!rule.nftContract || rule.nftContract.length < 32) {
              result.checks.allocations.valid = false;
              result.checks.allocations.message = `Invalid NFT contract address in rule "${rule.name}"`;
              result.errors.push(result.checks.allocations.message);
              result.valid = false;
            }

            // Validate threshold
            if (rule.threshold <= 0) {
              result.checks.allocations.valid = false;
              result.checks.allocations.message = `Threshold must be greater than 0 in rule "${rule.name}"`;
              result.errors.push(result.checks.allocations.message);
              result.valid = false;
            }

            // Validate allocation value
            if (rule.allocationValue <= 0) {
              result.checks.allocations.valid = false;
              result.checks.allocations.message = `Allocation value must be greater than 0 in rule "${rule.name}"`;
              result.errors.push(result.checks.allocations.message);
              result.valid = false;
            }

            // Sum up percentages
            if (rule.allocationType === 'PERCENTAGE') {
              totalPercentage += rule.allocationValue;
            }
          }

          result.checks.allocations.total = totalPercentage;

          // Check if percentages exceed 100%
          if (totalPercentage > 100) {
            result.checks.allocations.valid = false;
            result.checks.allocations.message = `Rule allocations sum to ${totalPercentage.toFixed(2)}%, which exceeds 100%`;
            result.errors.push(result.checks.allocations.message);
            result.valid = false;
          } else if (totalPercentage > 0 && totalPercentage < 100) {
            const unallocated = 100 - totalPercentage;
            result.warnings.push(`Rule allocations sum to ${totalPercentage.toFixed(2)}%. ${unallocated.toFixed(2)}% of pool will remain unallocated.`);
          }

          if (result.checks.allocations.valid && result.checks.allocations.message === '') {
            result.checks.allocations.message = `${params.rules.length} rule(s) configured (${enabledRules.length} enabled)`;
          }
        }
      }

      // Determine if can proceed without Streamflow
      result.canProceedWithoutStreamflow = result.checks.treasury.valid && result.checks.allocations.valid;

    } catch (error) {
      result.valid = false;
      result.errors.push(`Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return result;
  }

  /**
   * Helper: Verify that a pool belongs to the user's current project
   * SECURITY: Prevents cross-project access
   */
  private async verifyPoolOwnership(poolId: string, projectId: string): Promise<boolean> {
    const { data: pool, error } = await this.dbService.supabase
      .from('vesting_streams')
      .select('project_id')
      .eq('id', poolId)
      .single();

    if (error || !pool) {
      return false;
    }

    return pool.project_id === projectId;
  }

  /**
   * POST /api/pools/validate
   * Validate pool creation requirements before creating
   */
  async validatePool(req: Request, res: Response) {
    try {
      const { start_time, total_pool_amount, vesting_mode, manual_allocations, rules } = req.body;
      const projectId = req.projectId || req.project?.id;

      const validation = await this.validatePoolCreation({
        start_time,
        total_pool_amount,
        vesting_mode: vesting_mode || 'snapshot',
        manual_allocations,
        rules,
        projectId, // Pass projectId
      });

      res.json(validation);
    } catch (error) {
      console.error('Failed to validate pool:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/pools
   * Create a new vesting pool
   */
  async createPool(req: Request, res: Response) {
    try {
      const {
        name,
        description,
        total_pool_amount,
        vesting_duration_days,
        cliff_duration_days,
        vesting_duration_seconds,
        cliff_duration_seconds,
        start_time,
        end_time,
        is_active,
        vesting_mode,
        rules, // Array of eligibility rules from frontend
        manual_allocations, // Array of {wallet, amount, tier?, note?} for manual mode
        skipStreamflow, // Optional: skip Streamflow deployment
      } = req.body;

      if (!name || !total_pool_amount || vesting_duration_days === undefined) {
        return res.status(400).json({
          error: 'name, total_pool_amount, and vesting_duration_days are required',
        });
      }

      // Allow fractional days for testing (minimum 0.001 days = ~1.5 minutes)
      if (vesting_duration_days < 0.001) {
        return res.status(400).json({
          error: 'vesting_duration_days must be at least 0.001 (about 1.5 minutes)',
        });
      }

      // SECURITY: Project ID is REQUIRED for pool creation
      const poolProjectId = req.projectId || req.project?.id;

      if (!poolProjectId) {
        return res.status(400).json({
          error: 'Project ID is required. Please select a project or include x-project-id header.',
        });
      }

      // Run validation with projectId
      const validation = await this.validatePoolCreation({
        start_time,
        total_pool_amount,
        vesting_mode: vesting_mode || 'snapshot',
        manual_allocations,
        projectId: poolProjectId, // Pass projectId for vault keypair lookup
      });

      // If validation fails and not skipping Streamflow, return error with options
      if (!validation.valid && !skipStreamflow) {
        return res.status(400).json({
          success: false,
          error: 'Pool validation failed',
          errorType: validation.checks.solBalance.valid ? 'INSUFFICIENT_TOKENS' : 'INSUFFICIENT_SOL',
          validation,
          options: {
            canProceedWithoutStreamflow: validation.canProceedWithoutStreamflow,
            canAdjustTimestamp: !validation.checks.timestamp.valid,
            adjustedTimestamp: validation.checks.timestamp.adjustedStart,
          },
          suggestions: [
            ...(!validation.checks.solBalance.valid ? [`Fund treasury wallet (${validation.checks.treasury.address}) with at least 0.015 SOL`] : []),
            ...(!validation.checks.tokenBalance.valid ? [`Fund treasury wallet with at least ${total_pool_amount} tokens`] : []),
            ...(validation.canProceedWithoutStreamflow ? ['Create pool without Streamflow deployment (database only)'] : []),
          ],
        });
      }

      // Convert fractional days to integer (round up to at least 1 day for DB storage)
      // For short test durations, we'll use 1 day in DB but track actual duration via start/end times
      const durationDaysInt = Math.max(1, Math.ceil(vesting_duration_days));
      const cliffDaysInt = cliff_duration_days ? Math.max(0, Math.ceil(cliff_duration_days)) : 0;

      // Convert rules to nft_requirements format
      const nftRequirements = rules ? rules.map((rule: any) => ({
        name: rule.name,
        nftContract: rule.nftContract,
        threshold: rule.threshold,
        allocationType: rule.allocationType,
        allocationValue: rule.allocationValue,
        enabled: rule.enabled !== false, // Default to true
      })) : [];

      const { data: stream, error } = await this.dbService.supabase
        .from('vesting_streams')
        .insert({
          project_id: poolProjectId,
          name,
          description: description || '',
          total_pool_amount,
          vesting_duration_days: durationDaysInt,
          cliff_duration_days: cliffDaysInt,
          vesting_duration_seconds: vesting_duration_seconds || (vesting_duration_days * 86400),
          cliff_duration_seconds: cliff_duration_seconds || (cliffDaysInt * 86400),
          start_time: start_time || new Date().toISOString(),
          end_time: end_time || new Date(Date.now() + vesting_duration_days * 24 * 60 * 60 * 1000).toISOString(),
          is_active: is_active !== undefined ? is_active : true,
          vesting_mode: vesting_mode || 'snapshot',
          pool_type: (vesting_mode || 'snapshot').toUpperCase(), // Ensure pool_type matches vesting_mode
          state: 'active', // Explicitly set state to active
          snapshot_taken: vesting_mode === 'manual' ? true : false, // Manual allocations are pre-taken
          nft_requirements: nftRequirements,
          tier_allocations: {}, // Empty object for now
          grace_period_days: 30,
        })
        .select()
        .single();

      if (error) {
        throw new Error(`Failed to create pool: ${error.message}`);
      }

      // If manual mode, create allocations for specified wallets
      if (vesting_mode === 'manual' && manual_allocations && Array.isArray(manual_allocations)) {
        console.log(`Creating ${manual_allocations.length} manual allocations...`);

        // Import AllocationCalculator dynamically
        const { AllocationCalculator } = await import('../services/allocationCalculator');

        // Map frontend input to AllocationInput format
        const allocationInputs = manual_allocations.map((alloc: any) => ({
          wallet: alloc.wallet,
          type: (alloc.allocationType || 'FIXED').toLowerCase() as 'percentage' | 'fixed',
          value: alloc.allocationValue,
          note: alloc.note,
          tier: 1
        }));

        // Calculate allocations
        const calculatedAllocations = AllocationCalculator.calculateAllocations(
          allocationInputs,
          total_pool_amount
        );

        // Validate allocations
        const validation = AllocationCalculator.validateAllocations(
          calculatedAllocations,
          total_pool_amount
        );

        if (!validation.valid) {
          console.warn(`Allocation validation warning: ${validation.message}`);
          // We continue anyway but log the warning, or we could throw error
        }

        for (const allocation of calculatedAllocations) {
          const { error: vestingError } = await this.dbService.supabase
            .from('vestings')
            .insert({
              project_id: poolProjectId,
              vesting_stream_id: stream.id,
              user_wallet: allocation.wallet,
              token_amount: allocation.tokenAmount,
              share_percentage: allocation.percentage,
              allocation_type: allocation.originalType.toUpperCase(),
              allocation_value: allocation.originalValue,
              original_percentage: allocation.percentage, // Store for reference
              tier: allocation.tier,
              nft_count: 0,
              is_active: true,
              is_cancelled: false,
            });

          if (vestingError) {
            console.error(`Failed to create vesting for ${allocation.wallet}:`, vestingError);
          } else {
            console.log(`✅ Allocated ${allocation.tokenAmount} tokens (${allocation.percentage.toFixed(2)}%) to ${allocation.wallet}${allocation.note ? ' (' + allocation.note + ')' : ''}`);
          }
        }
      }

      // Auto-deploy to Streamflow (unless skipped)
      let streamflowId = null;
      let streamflowSignature = null;
      let streamflowError = null;

      if (!skipStreamflow) {
        try {
          console.log('Auto-deploying pool to Streamflow...');

          // Parse admin keypair
          let adminKeypair: Keypair;

          // PRIORITY: Use token_mint from request body if provided (per-pool token)
          // Otherwise, fall back to project mint_address
          let tokenMint: PublicKey;
          const requestTokenMint = req.body.token_mint;

          if (requestTokenMint) {
            tokenMint = new PublicKey(requestTokenMint);
            console.log('Using per-pool token mint from request:', requestTokenMint);
          } else if (req.project && req.project.mint_address) {
            tokenMint = new PublicKey(req.project.mint_address);
            console.log('Using project default mint:', req.project.mint_address);
          } else if (config.customTokenMint) {
            tokenMint = config.customTokenMint;
            console.log('Using global config token mint');
          } else {
            throw new Error('No token mint specified. Please provide token_mint in request or configure project mint.');
          }

          if (req.projectId) {
            try {
              adminKeypair = await getVaultKeypairForProject(req.projectId);
            } catch (err) {
              console.error('Failed to get project vault:', err);
              throw new Error('Failed to access project vault');
            }
          } else if (config.adminPrivateKey.startsWith('[')) {
            const secretKey = Uint8Array.from(JSON.parse(config.adminPrivateKey));
            adminKeypair = Keypair.fromSecretKey(secretKey);
          } else {
            const decoded = bs58.decode(config.adminPrivateKey);
            adminKeypair = Keypair.fromSecretKey(decoded);
          }

          const startTimestamp = Math.floor(new Date(stream.start_time).getTime() / 1000);
          const endTimestamp = Math.floor(new Date(stream.end_time).getTime() / 1000);
          const nowTimestamp = Math.floor(Date.now() / 1000);

          // Calculate cliff time if cliff_duration_days was provided
          let cliffTimestamp: number | undefined = undefined;
          if (stream.cliff_duration_days && stream.cliff_duration_days > 0) {
            const effectiveStart = startTimestamp < nowTimestamp ? nowTimestamp + 60 : startTimestamp;
            cliffTimestamp = effectiveStart + Math.floor(stream.cliff_duration_days * 86400);
            console.log(`Cliff time calculated: ${cliffTimestamp} (${stream.cliff_duration_days} days after start)`);
          }

          // Validate timestamps for Streamflow
          if (startTimestamp < nowTimestamp) {
            console.warn(`Start time ${startTimestamp} is in the past (now: ${nowTimestamp}). Adjusting to current time + 60 seconds.`);
            // Adjust start time to be 60 seconds in the future
            const adjustedStart = nowTimestamp + 60;
            const duration = endTimestamp - startTimestamp;
            const adjustedEnd = adjustedStart + duration;
            // Adjust cliff time if it was set
            if (cliffTimestamp) {
              cliffTimestamp = adjustedStart + Math.floor(stream.cliff_duration_days * 86400);
            }

            const streamflowResult = await this.streamflowService.createVestingPool({
              adminKeypair,
              tokenMint,
              totalAmount: stream.total_pool_amount,
              startTime: adjustedStart,
              endTime: adjustedEnd,
              cliffTime: cliffTimestamp,
              poolName: stream.name,
            });

            streamflowId = streamflowResult.streamId;
            streamflowSignature = streamflowResult.signature;
          } else {
            const streamflowResult = await this.streamflowService.createVestingPool({
              adminKeypair,
              tokenMint,
              totalAmount: stream.total_pool_amount,
              startTime: startTimestamp,
              endTime: endTimestamp,
              cliffTime: cliffTimestamp,
              poolName: stream.name,
            });

            streamflowId = streamflowResult.streamId;
            streamflowSignature = streamflowResult.signature;
          }

          // Update DB with Streamflow ID
          await this.dbService.supabase
            .from('vesting_streams')
            .update({ streamflow_stream_id: streamflowId })
            .eq('id', stream.id);

          console.log('Pool deployed to Streamflow:', streamflowId);
        } catch (error) {
          streamflowError = error instanceof Error ? error.message : 'Unknown error';
          console.error('Failed to deploy to Streamflow (pool still created in DB):', streamflowError);
          // Don't fail the entire request - pool is still created in DB
        }
      } else {
        console.log('Skipping Streamflow deployment (skipStreamflow=true)');
      }

      // Run immediate sync for snapshot/dynamic pools to populate vestings
      if (vesting_mode === 'snapshot') {
        // Snapshot pools: trigger snapshot immediately
        console.log(`📸 Triggering immediate snapshot for pool: ${stream.name}`);

        // Import snapshot services
        const { SnapshotConfigService } = await import('../services/snapshotConfigService');
        const { HeliusNFTService } = await import('../services/heliusNFTService');

        const heliusService = new HeliusNFTService(config.heliusApiKey, 'mainnet-beta');
        const snapshotConfigService = new SnapshotConfigService(heliusService);

        // Convert pool rules to snapshot config
        const snapshotConfig = {
          poolSize: stream.total_pool_amount,
          cycleStartTime: new Date(stream.start_time).getTime(),
          cycleDuration: stream.vesting_duration_seconds * 1000,
          rules: nftRequirements.map((rule: any) => ({
            id: rule.id || `rule_${Date.now()}`,
            name: rule.name,
            nftContract: rule.nftContract,
            threshold: rule.threshold,
            allocationType: rule.allocationType,
            allocationValue: rule.allocationValue,
            enabled: rule.enabled !== false,
          })),
        };

        // Process snapshot asynchronously with better error handling
        console.log(`[SNAPSHOT] Starting snapshot process for pool ${stream.id}`);
        console.log(`[SNAPSHOT] Rules:`, JSON.stringify(snapshotConfig.rules, null, 2));

        snapshotConfigService.processSnapshotRules(snapshotConfig)
          .then(async (result) => {
            console.log(`[SNAPSHOT] Process completed. Result:`, JSON.stringify({
              allocationsCount: result.allocations?.length || 0,
              totalAllocated: result.totalAllocated,
              totalWallets: result.totalWallets
            }, null, 2));

            if (result.allocations && result.allocations.length > 0) {
              console.log(`✅ Snapshot found ${result.allocations.length} eligible wallets`);

              // Create vesting records
              const vestingRecords = result.allocations.map((allocation: any) => ({
                project_id: poolProjectId,
                vesting_stream_id: stream.id,
                user_wallet: allocation.address,
                token_amount: allocation.amount,
                share_percentage: (allocation.amount / stream.total_pool_amount) * 100,
                nft_count: allocation.sources?.length || 1,
                tier: 1,
                is_active: true,
                is_cancelled: false,
                snapshot_locked: true,
              }));

              console.log(`[SNAPSHOT] Inserting ${vestingRecords.length} vesting records...`);
              const { error: insertError } = await this.dbService.supabase.from('vestings').insert(vestingRecords);

              if (insertError) {
                console.error(`[SNAPSHOT] Failed to insert vestings:`, insertError);
                throw insertError;
              }

              // Mark snapshot as taken
              const { error: updateError } = await this.dbService.supabase
                .from('vesting_streams')
                .update({ snapshot_taken: true })
                .eq('id', stream.id);

              if (updateError) {
                console.error(`[SNAPSHOT] Failed to mark snapshot as taken:`, updateError);
              }

              console.log(`✅ Snapshot completed: ${vestingRecords.length} vestings created for pool ${stream.id}`);
            } else {
              console.warn(`⚠️ No eligible wallets found for snapshot pool ${stream.name}`);
              console.warn(`[SNAPSHOT] Check: 1) NFT contract is correct, 2) Threshold settings, 3) Helius API key`);
            }
          })
          .catch(err => {
            console.error(`❌ Failed to process snapshot for pool ${stream.id}:`, err);
            console.error(`[SNAPSHOT] Error details:`, err.message || err);
            console.error(`[SNAPSHOT] Stack trace:`, err.stack);
          });
      } else if (vesting_mode === 'dynamic') {
        // Dynamic pools: trigger initial sync
        console.log(`🔄 Triggering initial sync for dynamic pool: ${stream.name}`);
        syncDynamicPool(stream).catch(err => {
          console.error(`❌ Failed to sync pool ${stream.id}:`, err);
        });
      }

      res.json({
        success: true,
        stream: {
          ...stream,
          streamflow_stream_id: streamflowId,
        },
        streamflowDeployed: !!streamflowId,
        streamflowSignature,
        streamflowError,
        validation: !skipStreamflow ? validation : undefined,
      });
    } catch (error) {
      console.error('Failed to create pool:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/pools
   * List all vesting pools with Streamflow status
   * SECURITY: Always filters by project_id to ensure project isolation
   */
  async listPools(req: Request, res: Response) {
    try {
      // SECURITY: Project ID is REQUIRED for listing pools
      const projectId = req.projectId || req.headers['x-project-id'] as string;

      if (!projectId) {
        return res.status(400).json({
          error: 'Project ID is required. Please select a project first.'
        });
      }

      // Get all vesting streams for THIS PROJECT ONLY
      const { data: streams, error } = await this.dbService.supabase
        .from('vesting_streams')
        .select('*')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false });

      if (error) {
        throw new Error(`Failed to fetch pools: ${error.message}`);
      }

      // Enrich with Streamflow status and stats
      const pools = await Promise.all((streams || []).map(async (stream: any) => {
        // DEBUG: Log raw state from DB
        // console.log(`Pool ${stream.id} raw DB state: ${stream.state}, is_active: ${stream.is_active}`);

        // Get user count and allocation stats
        const { data: vestings } = await this.dbService.supabase
          .from('vestings')
          .select('token_amount')
          .eq('vesting_stream_id', stream.id)
          .eq('is_active', true);

        const totalAllocated = vestings?.reduce((sum: number, v: any) => sum + Number(v.token_amount), 0) || 0;
        const userCount = vestings?.length || 0;

        // Get Streamflow status if deployed
        let streamflowStatus = null;
        if (stream.streamflow_stream_id && this.streamflowService) {
          try {
            const status = await this.streamflowService.getPoolStatus(stream.streamflow_stream_id);
            streamflowStatus = {
              vestedAmount: status.withdrawnAmount,
              depositedAmount: status.depositedAmount,
              vestedPercentage: (status.withdrawnAmount / status.depositedAmount) * 100,
            };
          } catch (err) {
            console.error('Failed to get Streamflow status:', err);
          }
        }

        return {
          id: stream.id,
          name: stream.name,
          description: stream.description,
          totalAmount: stream.total_pool_amount,
          vestingDuration: stream.vesting_duration_days,
          cliffDuration: stream.cliff_duration_days,
          isActive: stream.is_active,
          startTime: stream.start_time,
          endTime: stream.end_time,
          streamflowId: stream.streamflow_stream_id,
          vestingMode: stream.vesting_mode,
          // Sanitize state (handle 'stable' legacy value)
          // If state is explicitly 'cancelled', respect it. Otherwise infer from is_active.
          state: (stream.state === 'cancelled')
            ? 'cancelled'
            : (stream.state === 'stable' || !stream.state || stream.state === 'active')
              ? (stream.is_active ? 'active' : 'cancelled')
              : stream.state,
          createdAt: stream.created_at,
          stats: {
            userCount,
            totalAllocated,
          },
          streamflow: streamflowStatus,
        };
      }));

      res.json(pools);
    } catch (error) {
      console.error('Failed to list pools:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/pools/:id
   * Get pool details
   * SECURITY: Verifies pool belongs to user's project
   */
  async getPoolDetails(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const projectId = req.projectId || req.headers['x-project-id'] as string;

      if (!id) {
        return res.status(400).json({ error: 'Pool ID is required' });
      }

      if (!projectId) {
        return res.status(400).json({ error: 'Project ID is required' });
      }

      // Get pool from database - MUST belong to user's project
      const { data: stream, error } = await this.dbService.supabase
        .from('vesting_streams')
        .select('*')
        .eq('id', id)
        .eq('project_id', projectId)
        .single();

      if (error || !stream) {
        return res.status(404).json({ error: 'Pool not found or access denied' });
      }

      res.json({
        id: stream.id,
        name: stream.name,
        description: stream.description,
        totalAmount: stream.total_pool_amount,
        vestingDuration: stream.vesting_duration_days,
        cliffDuration: stream.cliff_duration_days,
        isActive: stream.is_active,
        startTime: stream.start_time,
        endTime: stream.end_time,
        createdAt: stream.created_at,
        nftRequirements: stream.nft_requirements || [],
        tierAllocations: stream.tier_allocations || {},
        vestingMode: stream.vesting_mode,
        // Sanitize state (handle 'stable' legacy value)
        state: (stream.state === 'stable' || !stream.state)
          ? (stream.is_active ? 'active' : 'cancelled')
          : stream.state,
      });
    } catch (error) {
      console.error('Failed to get pool details:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * PUT /api/pools/:id
   * Update pool details (name, description)
   * SECURITY: Verifies pool belongs to user's project
   */
  async updatePool(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { name, description } = req.body;
      const projectId = req.projectId || req.headers['x-project-id'] as string;

      if (!id) {
        return res.status(400).json({ error: 'Pool ID is required' });
      }

      if (!projectId) {
        return res.status(400).json({ error: 'Project ID is required' });
      }

      const updates: any = {};
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      // SECURITY: Update only if pool belongs to user's project
      const { data: pool, error } = await this.dbService.supabase
        .from('vesting_streams')
        .update(updates)
        .eq('id', id)
        .eq('project_id', projectId)
        .select()
        .single();

      if (error) {
        throw new Error(`Failed to update pool: ${error.message}`);
      }

      res.json({
        success: true,
        pool,
      });
    } catch (error) {
      console.error('Failed to update pool:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * PUT /api/pools/:id/rules
   * Update a rule in the pool's nft_requirements
   */
  async updatePoolRule(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { ruleId, name, nftContract, threshold, allocationType, allocationValue } = req.body;
      const projectId = req.projectId || req.headers['x-project-id'] as string;

      if (!id || !ruleId) {
        return res.status(400).json({ error: 'Pool ID and rule ID are required' });
      }

      if (!projectId) {
        return res.status(400).json({ error: 'Project ID is required' });
      }

      // SECURITY: Verify pool belongs to user's project
      const hasAccess = await this.verifyPoolOwnership(id, projectId);
      if (!hasAccess) {
        return res.status(404).json({ error: 'Pool not found or access denied' });
      }

      // SECURITY: Get current pool - must belong to user's project
      const { data: pool, error: fetchError } = await this.dbService.supabase
        .from('vesting_streams')
        .select('nft_requirements')
        .eq('id', id)
        .eq('project_id', projectId)
        .single();

      if (fetchError || !pool) {
        return res.status(404).json({ error: 'Pool not found' });
      }

      // Update the specific rule
      const nftRequirements = pool.nft_requirements || [];
      const ruleIndex = nftRequirements.findIndex((r: any) =>
        r.name === ruleId || nftRequirements.indexOf(r).toString() === ruleId.replace('rule-', '')
      );

      if (ruleIndex === -1) {
        return res.status(404).json({ error: 'Rule not found' });
      }

      nftRequirements[ruleIndex] = {
        name,
        collection: nftContract,
        min_nfts: threshold,
        allocationType,
        allocationValue,
      };

      // SECURITY: Update pool - verify project ownership again
      const { error: updateError } = await this.dbService.supabase
        .from('vesting_streams')
        .update({ nft_requirements: nftRequirements })
        .eq('id', id)
        .eq('project_id', projectId);

      if (updateError) {
        throw new Error(`Failed to update rule: ${updateError.message}`);
      }

      res.json({
        success: true,
        message: 'Rule updated successfully',
      });
    } catch (error) {
      console.error('Failed to update pool rule:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * PUT /api/pools/:id/allocations
   * Update manual pool allocations (add/remove/edit wallets)
   * Uses AllocationCalculator to properly handle percentage and fixed allocations
   */
  async updateAllocations(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { allocations } = req.body;
      const projectId = req.projectId || req.headers['x-project-id'] as string;

      if (!id || !allocations || !Array.isArray(allocations)) {
        return res.status(400).json({ error: 'Pool ID and allocations array are required' });
      }

      if (!projectId) {
        return res.status(400).json({ error: 'Project ID is required' });
      }

      // SECURITY: Get pool details - must belong to user's project
      const { data: pool, error: fetchError } = await this.dbService.supabase
        .from('vesting_streams')
        .select('*')
        .eq('id', id)
        .eq('project_id', projectId)
        .single();

      if (fetchError || !pool) {
        return res.status(404).json({ error: 'Pool not found' });
      }

      // Only allow editing manual mode pools
      if (pool.vesting_mode !== 'manual') {
        return res.status(400).json({
          error: 'Only manual mode pools can have allocations edited directly'
        });
      }

      // Import AllocationCalculator
      const { AllocationCalculator } = await import('../services/allocationCalculator');

      // Map input to AllocationInput format
      const allocationInputs = allocations.map((alloc: any) => ({
        wallet: alloc.wallet,
        type: (alloc.allocationType || 'FIXED').toLowerCase() as 'percentage' | 'fixed',
        value: alloc.allocationValue,
        note: alloc.note,
        tier: alloc.tier || 1
      }));

      // Calculate allocations
      const calculatedAllocations = AllocationCalculator.calculateAllocations(
        allocationInputs,
        pool.total_pool_amount
      );

      // Validate allocations
      const validation = AllocationCalculator.validateAllocations(
        calculatedAllocations,
        pool.total_pool_amount
      );

      if (!validation.valid) {
        return res.status(400).json({
          error: 'Allocation validation failed',
          details: validation.message
        });
      }

      // SECURITY: Delete existing vestings for this pool (verify project ownership)
      const { error: deleteError } = await this.dbService.supabase
        .from('vestings')
        .delete()
        .eq('vesting_stream_id', id)
        .eq('project_id', projectId);

      if (deleteError) {
        throw new Error(`Failed to delete old allocations: ${deleteError.message}`);
      }

      // Insert new allocations with metadata
      const vestingRecords = calculatedAllocations.map(allocation => ({
        project_id: projectId,
        vesting_stream_id: id,
        user_wallet: allocation.wallet,
        token_amount: allocation.tokenAmount,
        share_percentage: allocation.percentage,
        allocation_type: allocation.originalType.toUpperCase(),
        allocation_value: allocation.originalValue,
        original_percentage: allocation.percentage,
        tier: allocation.tier,
        nft_count: 0,
        is_active: true,
        is_cancelled: false,
      }));

      const { error: insertError } = await this.dbService.supabase
        .from('vestings')
        .insert(vestingRecords);

      if (insertError) {
        throw new Error(`Failed to insert new allocations: ${insertError.message}`);
      }

      res.json({
        success: true,
        message: `Successfully updated allocations for ${allocations.length} wallet(s)`,
        count: vestingRecords.length,
        allocations: calculatedAllocations,
      });
    } catch (error) {
      console.error('Failed to update allocations:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/pools/:id/streamflow-status
   * Get Streamflow pool status (vested amount, remaining, etc)
   */
  async getStreamflowStatus(req: Request, res: Response) {
    try {
      const { id } = req.params;

      // Get pool details
      const { data: pool, error: fetchError } = await this.dbService.supabase
        .from('vesting_streams')
        .select('*')
        .eq('id', id)
        .single();

      if (fetchError || !pool) {
        return res.status(404).json({ error: 'Pool not found' });
      }

      if (!pool.streamflow_stream_id) {
        return res.json({
          deployed: false,
          message: 'Pool not deployed to Streamflow',
        });
      }

      // Get Streamflow status
      const status = await this.streamflowService.getPoolStatus(pool.streamflow_stream_id);
      const vestedAmount = await this.streamflowService.getVestedAmount(pool.streamflow_stream_id);

      res.json({
        deployed: true,
        streamflowId: pool.streamflow_stream_id,
        ...status,
        vestedAmount,
        vestedPercentage: (vestedAmount / status.depositedAmount) * 100,
      });
    } catch (error) {
      console.error('Failed to get Streamflow status:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/pools/:id/rules
   * Add a new snapshot rule to an existing pool
   */
  async addRule(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { name, nftContract, threshold, allocationType, allocationValue, enabled } = req.body;
      const projectId = req.projectId || req.headers['x-project-id'] as string;

      // SECURITY: Verify project context
      if (!projectId) {
        return res.status(400).json({ error: 'Project ID is required' });
      }

      // SECURITY: Verify pool belongs to user's project
      const hasAccess = await this.verifyPoolOwnership(id, projectId);
      if (!hasAccess) {
        return res.status(404).json({ error: 'Pool not found or access denied' });
      }

      // Get current pool
      const { data: pool, error: fetchError } = await this.dbService.supabase
        .from('vesting_streams')
        .select('*')
        .eq('id', id)
        .eq('project_id', projectId)
        .single();

      if (fetchError || !pool) {
        return res.status(404).json({ error: 'Pool not found' });
      }

      // Only allow adding rules to dynamic pools
      if (pool.vesting_mode !== 'dynamic') {
        return res.status(400).json({
          error: 'Can only add rules to dynamic pools. Snapshot pools are immutable after creation.'
        });
      }

      // Get existing rules
      const existingRules = pool.nft_requirements || [];

      // Create new rule
      const newRule = {
        id: `rule-${Date.now()}`,
        name,
        nftContract,
        threshold,
        allocationType,
        allocationValue,
        enabled: enabled !== false,
      };

      // Add to rules array
      const updatedRules = [...existingRules, newRule];

      // Update pool
      const { error: updateError } = await this.dbService.supabase
        .from('vesting_streams')
        .update({ nft_requirements: updatedRules })
        .eq('id', id);

      if (updateError) {
        throw new Error(`Failed to update pool: ${updateError.message}`);
      }

      res.json({
        success: true,
        rule: newRule,
        message: 'Rule added successfully. Dynamic sync will process new allocations.',
      });
    } catch (error) {
      console.error('Failed to add rule:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/pools/:id/sync
   * Manually trigger sync for a dynamic pool
   */
  async syncPool(req: Request, res: Response) {
    try {
      const { id } = req.params;

      // Get pool
      const { data: pool } = await this.dbService.supabase
        .from('vesting_streams')
        .select('*')
        .eq('id', id)
        .single();

      if (!pool) {
        return res.status(404).json({ error: 'Pool not found' });
      }

      if (pool.vesting_mode !== 'dynamic') {
        return res.status(400).json({ error: 'Can only sync dynamic pools' });
      }

      console.log('🔄 Manually triggering sync for pool:', pool.name);

      // Import and run sync
      const { syncDynamicPool } = require('../utils/syncDynamicPool');
      await syncDynamicPool(pool);

      res.json({ success: true, message: 'Sync completed' });
    } catch (error) {
      console.error('Sync failed:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Sync failed' });
    }
  }

  /**
   * DELETE /api/pools/:id
   * Cancel/deactivate a vesting pool
   */
  async cancelPool(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const projectId = req.projectId || req.headers['x-project-id'] as string;

      if (!projectId) {
        return res.status(400).json({ error: 'Project ID is required' });
      }

      // SECURITY: Get pool details - must belong to user's project
      const { data: pool, error: fetchError } = await this.dbService.supabase
        .from('vesting_streams')
        .select('*')
        .eq('id', id)
        .eq('project_id', projectId)
        .single();

      if (fetchError || !pool) {
        return res.status(404).json({ error: 'Pool not found' });
      }

      // Check if pool is snapshot mode and already has allocations
      if (pool.vesting_mode === 'snapshot') {
        const { data: vestings } = await this.dbService.supabase
          .from('vestings')
          .select('id')
          .eq('vesting_stream_id', id)
          .eq('project_id', projectId)
          .eq('snapshot_locked', true);

        if (vestings && vestings.length > 0) {
          return res.status(400).json({
            error: 'Cannot cancel snapshot pool with locked allocations. Users have already been allocated tokens.'
          });
        }
      }

      // Cancel Streamflow pool if deployed
      if (pool.streamflow_stream_id && this.streamflowService) {
        try {
          // Parse admin keypair
          let adminKeypair: Keypair;
          if (config.adminPrivateKey.startsWith('[')) {
            const secretKey = Uint8Array.from(JSON.parse(config.adminPrivateKey));
            adminKeypair = Keypair.fromSecretKey(secretKey);
          } else {
            const decoded = bs58.decode(config.adminPrivateKey);
            adminKeypair = Keypair.fromSecretKey(decoded);
          }

          await this.streamflowService.cancelPool(pool.streamflow_stream_id, adminKeypair);
          console.log('Streamflow pool cancelled:', pool.streamflow_stream_id);
        } catch (err) {
          console.error('Failed to cancel Streamflow pool:', err);
          // Continue with DB deactivation even if Streamflow cancel fails
        }
      }

      // SECURITY: Deactivate pool in database - verify project ownership
      const { data: updatedPool, error: updateError } = await this.dbService.supabase
        .from('vesting_streams')
        .update({
          is_active: false,
          state: 'cancelled'
        })
        .eq('id', id)
        .eq('project_id', projectId)
        .select()
        .single();

      if (updateError) {
        console.error('DB Update Error:', updateError);
        throw new Error(`Failed to deactivate pool: ${updateError.message}`);
      }

      // Double check the update
      if (updatedPool.state !== 'cancelled') {
        console.warn(`⚠️ Pool ${id} update mismatch. Requested 'cancelled', got '${updatedPool.state}'. Retrying force update.`);
        // Force retry just state
        await this.dbService.supabase
          .from('vesting_streams')
          .update({ state: 'cancelled' })
          .eq('id', id);
      }

      console.log(`Pool ${id} deactivated. Final state: ${updatedPool?.state}, is_active: ${updatedPool?.is_active}`);

      // Deactivate all user vestings
      await this.dbService.supabase
        .from('vestings')
        .update({ is_active: false, is_cancelled: true, cancelled_at: new Date().toISOString() })
        .eq('vesting_stream_id', id);

      res.json({
        success: true,
        message: 'Pool cancelled successfully',
        pool: updatedPool
      });
    } catch (error) {
      console.error('Failed to cancel pool:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/pools/:id/deploy-streamflow
   * Deploy pool to Streamflow (creates on-chain vesting stream)
   */
  async deployToStreamflow(req: Request, res: Response) {
    try {
      const { id } = req.params;

      // Get pool details
      const { data: pool, error: fetchError } = await this.dbService.supabase
        .from('vesting_streams')
        .select('*')
        .eq('id', id)
        .single();

      if (fetchError || !pool) {
        return res.status(404).json({ error: 'Pool not found' });
      }

      if (pool.streamflow_stream_id) {
        return res.status(400).json({ error: 'Pool already deployed to Streamflow' });
      }

      // Parse admin keypair
      let adminKeypair: Keypair;
      try {
        if (config.adminPrivateKey.startsWith('[')) {
          const secretKey = Uint8Array.from(JSON.parse(config.adminPrivateKey));
          adminKeypair = Keypair.fromSecretKey(secretKey);
        } else {
          const decoded = bs58.decode(config.adminPrivateKey);
          adminKeypair = Keypair.fromSecretKey(decoded);
        }
      } catch (err) {
        return res.status(500).json({ error: 'Invalid admin key configuration' });
      }

      // Create Streamflow pool
      const startTime = Math.floor(new Date(pool.start_time).getTime() / 1000);
      const endTime = Math.floor(new Date(pool.end_time).getTime() / 1000);

      const result = await this.streamflowService.createVestingPool({
        adminKeypair,
        tokenMint: config.customTokenMint!,
        totalAmount: pool.total_pool_amount,
        startTime,
        endTime,
        poolName: pool.name,
      });

      // Update database with Streamflow ID
      const { error: updateError } = await this.dbService.supabase
        .from('vesting_streams')
        .update({ streamflow_stream_id: result.streamId })
        .eq('id', id);

      if (updateError) {
        throw new Error(`Failed to update pool: ${updateError.message}`);
      }

      res.json({
        success: true,
        streamflowId: result.streamId,
        signature: result.signature,
        message: 'Pool deployed to Streamflow successfully',
      });
    } catch (error) {
      console.error('Failed to deploy to Streamflow:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/pools/:id/cancel-streamflow
   * Cancel a Streamflow pool and reclaim rent + unvested tokens
   * Accepts either database pool ID or Streamflow stream ID
   */
  async cancelStreamflowPool(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { streamflowId } = req.body; // Optional: direct Streamflow ID

      if (!id && !streamflowId) {
        return res.status(400).json({ error: 'Pool ID or Streamflow ID is required' });
      }

      let streamId: string;
      let poolId: string | null = null;

      // If streamflowId provided directly, use it
      if (streamflowId) {
        streamId = streamflowId;

        // Try to find pool in database for cleanup
        const { data: pool } = await this.dbService.supabase
          .from('vesting_streams')
          .select('id')
          .eq('streamflow_stream_id', streamflowId)
          .single();

        if (pool) {
          poolId = pool.id;
        }
      } else {
        // Get pool details from database
        const { data: pool, error: poolError } = await this.dbService.supabase
          .from('vesting_streams')
          .select('*')
          .eq('id', id)
          .single();

        if (poolError || !pool) {
          return res.status(404).json({ error: 'Pool not found' });
        }

        if (!pool.streamflow_stream_id) {
          return res.status(400).json({ error: 'Pool is not deployed to Streamflow' });
        }

        streamId = pool.streamflow_stream_id;
        poolId = pool.id;
      }

      // Parse admin keypair
      let adminKeypair: Keypair;
      if (config.adminPrivateKey.startsWith('[')) {
        const secretKey = Uint8Array.from(JSON.parse(config.adminPrivateKey));
        adminKeypair = Keypair.fromSecretKey(secretKey);
      } else {
        const decoded = bs58.decode(config.adminPrivateKey);
        adminKeypair = Keypair.fromSecretKey(decoded);
      }

      // Cancel the stream
      const result = await this.streamflowService.cancelVestingPool(
        streamId,
        adminKeypair
      );

      // Update database if pool found
      if (poolId) {
        await this.dbService.supabase
          .from('vesting_streams')
          .update({
            is_active: false,
            state: 'cancelled', // Explicitly update state
            streamflow_stream_id: null // Clear Streamflow ID
          })
          .eq('id', poolId);
      }

      res.json({
        success: true,
        signature: result.signature,
        streamflowId: streamId,
        message: 'Pool canceled successfully. Rent and unvested tokens returned to treasury.',
      });
    } catch (error) {
      console.error('Failed to cancel pool:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/pools/:id/topup
   * Top up a vesting pool (not implemented - manual transfers only)
   */
  async topupPool(req: Request, res: Response) {
    res.status(501).json({
      error: 'Topup not implemented. Admin manually transfers tokens for claims.',
    });
  }

  /**
   * GET /api/pools/:id/activity
   * Get pool vestings (user allocations)
   */
  async getPoolActivity(req: Request, res: Response) {
    try {
      const { id } = req.params;

      if (!id) {
        return res.status(400).json({ error: 'Pool ID is required' });
      }

      // Get all vestings for this pool
      const { data: vestings, error } = await this.dbService.supabase
        .from('vestings')
        .select('*')
        .eq('vesting_stream_id', id)
        .eq('is_active', true);

      if (error) {
        throw new Error(`Failed to fetch vestings: ${error.message}`);
      }

      res.json(vestings || []);
    } catch (error) {
      console.error('Failed to get pool activity:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/pools/:id/users/:wallet
   * Get user status in pool
   */
  async getUserStatus(req: Request, res: Response) {
    try {
      const { id, wallet } = req.params;

      if (!id || !wallet) {
        return res.status(400).json({ error: 'Pool ID and wallet are required' });
      }

      // Get user vesting record
      const { data: vesting, error } = await this.dbService.supabase
        .from('vestings')
        .select('*')
        .eq('vesting_stream_id', id)
        .eq('user_wallet', wallet)
        .single();

      if (error || !vesting) {
        return res.status(404).json({ error: 'User not found in pool' });
      }

      res.json({
        wallet: vesting.user_wallet,
        tokenAmount: vesting.token_amount,
        isActive: vesting.is_active,
        isCancelled: vesting.is_cancelled,
        createdAt: vesting.created_at,
      });
    } catch (error) {
      console.error('Failed to get user status:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * DELETE /api/pools/:id
   * Delete a vesting pool (only if not started)
   */
  async deletePool(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const projectId = req.projectId || req.headers['x-project-id'] as string;

      if (!projectId) {
        return res.status(400).json({ error: 'Project ID is required' });
      }

      // SECURITY: Get pool details - must belong to user's project
      const { data: pool, error: fetchError } = await this.dbService.supabase
        .from('vesting_streams')
        .select('*')
        .eq('id', id)
        .eq('project_id', projectId)
        .single();

      if (fetchError || !pool) {
        return res.status(404).json({ error: 'Pool not found' });
      }

      // Check if pool has started (ignore paused pools - they can still be deleted if not started)
      const startTime = new Date(pool.start_time);
      const now = new Date();

      if (startTime <= now && pool.state !== 'paused') {
        return res.status(400).json({
          error: 'Cannot delete a pool that has already started. Use cancel instead.',
          suggestion: 'Use PATCH /api/pools/:id/cancel or the cancel action from admin interface'
        });
      }

      // Allow deletion of paused pools that have started (admin override)
      if (pool.state === 'paused') {
        console.log(`Allowing deletion of paused pool: ${pool.name}`);
      }

      // SECURITY: Delete pool (cascade will delete vestings) - verify project ownership
      const { error: deleteError } = await this.dbService.supabase
        .from('vesting_streams')
        .delete()
        .eq('id', id)
        .eq('project_id', projectId);

      if (deleteError) {
        throw new Error(`Failed to delete pool: ${deleteError.message}`);
      }

      res.json({
        success: true,
        message: 'Pool deleted successfully',
      });
    } catch (error) {
      console.error('Failed to delete pool:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * PUT /api/pools/:id/details
   * Update pool name and description
   */
  async updatePoolDetails(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { name, description } = req.body;

      if (!name && !description) {
        return res.status(400).json({
          error: 'At least one field (name or description) is required',
        });
      }

      const updates: any = {};
      if (name) updates.name = name;
      if (description !== undefined) updates.description = description;

      const { data, error } = await this.dbService.supabase
        .from('vesting_streams')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        throw new Error(`Failed to update pool: ${error.message}`);
      }

      res.json({
        success: true,
        message: 'Pool updated successfully',
        pool: data,
      });
    } catch (error) {
      console.error('Failed to update pool details:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/pools/:id/snapshot
   * Trigger snapshot for a snapshot pool and create vestings from NFT holders
   */
  async triggerSnapshot(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const projectId = req.projectId || req.project?.id;

      // Get pool info
      const { data: pool } = await this.dbService.supabase
        .from('vesting_streams')
        .select('*')
        .eq('id', id)
        .single();

      if (!pool) {
        return res.status(404).json({ error: 'Pool not found' });
      }

      if (pool.vesting_mode !== 'snapshot') {
        return res.status(400).json({ error: 'Only snapshot pools support snapshot triggering' });
      }

      if (pool.snapshot_taken) {
        return res.status(400).json({ error: 'Snapshot has already been taken for this pool' });
      }

      // Check if pool has rules defined
      if (!pool.nft_requirements || pool.nft_requirements.length === 0) {
        return res.status(400).json({ error: 'Pool has no snapshot rules defined' });
      }

      console.log(`🔄 Processing snapshot for pool: ${pool.name}`);

      // Import snapshot services
      const { SnapshotConfigService } = await import('../services/snapshotConfigService');
      const { HeliusNFTService } = await import('../services/heliusNFTService');
      const { config } = await import('../config');

      const heliusService = new HeliusNFTService(config.heliusApiKey, 'mainnet-beta');
      const snapshotConfigService = new SnapshotConfigService(heliusService);

      // Convert pool rules to snapshot config format
      const snapshotConfig = {
        poolSize: pool.total_pool_amount,
        cycleStartTime: new Date(pool.start_time).getTime(),
        cycleDuration: pool.vesting_duration_seconds * 1000, // Convert to milliseconds
        rules: pool.nft_requirements.map((rule: any) => ({
          id: rule.id || `rule_${Date.now()}`,
          name: rule.name,
          nftContract: rule.nftContract,
          threshold: rule.threshold,
          allocationType: rule.allocationType,
          allocationValue: rule.allocationValue,
          enabled: rule.enabled !== false,
        })),
      };

      // Process snapshot rules to get allocations
      const result = await snapshotConfigService.processSnapshotRules(snapshotConfig);

      if (!result.allocations || result.allocations.length === 0) {
        return res.status(400).json({
          error: 'Snapshot processed but no eligible wallets found',
          breakdown: result.breakdown,
          totalWallets: result.totalWallets
        });
      }

      console.log(`✅ Found ${result.allocations.length} eligible wallets`);

      // Create vesting records for each allocation
      const vestingRecords = result.allocations.map((allocation: any) => ({
        project_id: projectId,
        vesting_stream_id: pool.id,
        user_wallet: allocation.address,
        token_amount: allocation.amount,
        share_percentage: (allocation.amount / pool.total_pool_amount) * 100,
        nft_count: allocation.sources?.length || 1,
        tier: 1,
        is_active: true,
        is_cancelled: false,
        snapshot_locked: true, // Lock snapshot allocations
      }));

      const { error: insertError } = await this.dbService.supabase
        .from('vestings')
        .insert(vestingRecords);

      if (insertError) {
        throw new Error(`Failed to create vesting records: ${insertError.message}`);
      }

      // Mark pool snapshot as taken
      await this.dbService.supabase
        .from('vesting_streams')
        .update({ snapshot_taken: true })
        .eq('id', id);

      console.log(`✅ Snapshot completed: ${vestingRecords.length} vestings created`);

      res.json({
        success: true,
        message: `Snapshot completed successfully`,
        summary: {
          eligibleWallets: result.allocations.length,
          totalAllocated: result.totalAllocated,
          totalWallets: result.totalWallets,
          vestingsCreated: vestingRecords.length,
          breakdown: result.breakdown,
        },
        allocations: result.allocations,
      });
    } catch (error) {
      console.error('Failed to trigger snapshot:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}
