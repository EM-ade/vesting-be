import { Request, Response } from 'express';
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddress, createTransferInstruction, getAccount, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { createClient } from '@supabase/supabase-js';
import bs58 from 'bs58';
import { SupabaseService } from '../services/supabaseService';
import { StreamflowService } from '../services/streamflowService';
import { PriceService } from '../services/priceService';
import { getVaultKeypairForProject } from '../services/vaultService';
import { config } from '../config';
import { cache } from '../lib/cache';
import Decimal from 'decimal.js';
import { EligibilityService } from '../services/eligibilityService';

/**
 * User Vesting API Controller
 * Handles user-facing vesting operations (summary, history, claims)
 */
export class UserVestingController {
  private dbService: SupabaseService;
  private connection: Connection;
  private streamflowService: StreamflowService;
  private priceService: PriceService;
  private eligibilityService: EligibilityService;
  private lastBlockhash: { hash: string; timestamp: number } | null = null;

  constructor() {
    const supabaseClient = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    this.dbService = new SupabaseService(supabaseClient);
    this.connection = new Connection(config.rpcEndpoint, 'confirmed');
    this.streamflowService = new StreamflowService();
    this.priceService = new PriceService(this.connection, 'mainnet-beta');
    this.eligibilityService = new EligibilityService();
  }

  /**
   * GET /api/user/vesting/list?wallet=xxx
   * Get all active vestings for a wallet
   */
  async listUserVestings(req: Request, res: Response) {
    try {
      const { wallet } = req.query;

      if (!wallet || typeof wallet !== 'string') {
        return res.status(400).json({ error: 'wallet parameter is required' });
      }

      // Get ALL active vesting records for this wallet
      const { data: vestings, error: vestingError } = await this.dbService.supabase
        .from('vestings')
        .select('*, vesting_streams(*)')
        .eq('user_wallet', wallet)
        .eq('is_active', true)
        .order('created_at', { ascending: false });

      if (vestingError) {
        console.error('Supabase error fetching vestings:', vestingError);
        // Return empty list on error instead of failing
        return res.json({ success: true, vestings: [] });
      }

      if (!vestings || vestings.length === 0) {
        return res.json({ success: true, vestings: [] });
      }

      // Filter out vestings with missing pool data, cancelled pools, or pools that haven't started yet
      const now = new Date();
      const startedVestings = vestings.filter((v: any) => {
        // Skip if pool data is missing (orphaned vesting record)
        if (!v.vesting_streams) {
          console.warn(`⚠️ Vesting ${v.id} has no associated pool (orphaned record)`);
          return false;
        }

        // Skip if pool is cancelled
        if (v.vesting_streams.state === 'cancelled') {
          console.log(`⚠️ Vesting ${v.id} is in a cancelled pool, skipping`);
          return false;
        }

        // Skip if pool hasn't started yet
        const startTime = new Date(v.vesting_streams.start_time);
        return startTime <= now;
      });

      // Return simplified list with pool state information
      const vestingList = startedVestings.map((v: any) => ({
        id: v.id,
        poolId: v.vesting_stream_id,
        poolName: v.vesting_streams.name,
        vestingMode: v.vesting_mode,
        tokenAmount: v.token_amount,
        nftCount: v.nft_count,
        streamflowId: v.vesting_streams.streamflow_stream_id,
        poolState: v.vesting_streams.state || 'active', // Include pool state
        createdAt: v.created_at,
      }));

      res.json({
        success: true,
        vestings: vestingList,
      });
    } catch (error) {
      console.error('Failed to list user vestings:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/user/vesting/summary?wallet=<address>&signature=<sig>&message=<msg>
   * Get user's vesting summary (pool total, share %, unlocked/locked balances, next unlock)
   */
  async getVestingSummary(req: Request, res: Response) {
    try {
      const { wallet, signature, message, poolId } = req.query;

      if (!wallet || typeof wallet !== 'string') {
        return res.status(400).json({ error: 'wallet parameter is required' });
      }

      // Verify wallet signature for authentication (optional for read operations)
      if (signature && message) {
        try {
          const nacl = await import('tweetnacl');
          const messageBuffer = new TextEncoder().encode(message as string);
          const signatureBuffer = Buffer.from(signature as string, 'base64');
          const publicKey = new PublicKey(wallet);

          const isValid = nacl.sign.detached.verify(
            messageBuffer,
            signatureBuffer,
            publicKey.toBytes()
          );

          if (!isValid) {
            return res.status(401).json({ error: 'Invalid signature' });
          }

          // Check message freshness
          const messageData = JSON.parse(message as string);
          const timestamp = messageData.timestamp;
          const now = Date.now();
          const fiveMinutes = 5 * 60 * 1000;

          if (!timestamp || Math.abs(now - timestamp) > fiveMinutes) {
            return res.status(401).json({ error: 'Signature expired' });
          }
        } catch (err) {
          return res.status(401).json({ error: 'Signature verification failed' });
        }
      }

      let userWallet: PublicKey;
      try {
        userWallet = new PublicKey(wallet);
      } catch (err) {
        return res.status(400).json({ error: 'Invalid wallet address' });
      }

      // Get ALL active vesting records for this wallet
      const { data: vestings, error: vestingError } = await this.dbService.supabase
        .from('vestings')
        .select('*, vesting_streams(*)')
        .eq('user_wallet', wallet)
        .eq('is_active', true)
        .order('created_at', { ascending: false });

      if (vestingError) {
        throw vestingError;
      }

      if (!vestings || vestings.length === 0) {
        return res.status(404).json({ error: 'No active vesting found for this wallet' });
      }

      // Filter out vestings with missing pool data, cancelled pools
      const validVestings = vestings.filter((v: any) => {
        // Skip if pool data is missing (orphaned vesting record)
        if (!v.vesting_streams) {
          console.warn(`⚠️ Vesting ${v.id} has no associated pool (orphaned record)`);
          return false;
        }

        // Skip if pool is cancelled
        if (v.vesting_streams.state === 'cancelled') {
          console.log(`⚠️ Vesting ${v.id} is in a cancelled pool, skipping`);
          return false;
        }

        return true;
      });

      if (validVestings.length === 0) {
        return res.status(404).json({ error: 'No valid vesting found for this wallet' });
      }

      // Use the most recent vesting (first in the list, ordered by created_at DESC)
      // TODO: Frontend should show all vestings and let user choose
      let vesting = validVestings[0];

      if (poolId && typeof poolId === 'string') {
        const matchingVesting = validVestings.find((v: any) => v.vesting_stream_id === poolId);

        if (!matchingVesting) {
          return res.status(404).json({ error: 'Vesting not found for specified pool' });
        }

        vesting = matchingVesting;
      }

      const stream = vesting.vesting_streams;

      // Check if pool is paused
      const isPoolPaused = stream.state === 'paused';

      if (validVestings.length > 1) {
        console.log(`[SUMMARY] ⚠️ User has ${validVestings.length} active vesting(s), showing pool: ${vesting.vesting_mode} "${stream.name}"`);
        console.log('[SUMMARY] Pools:', validVestings.map((v: any) => ({
          mode: v.vesting_mode,
          pool: v.vesting_streams?.name,
          id: v.vesting_stream_id,
          state: v.vesting_streams?.state || 'active'
        })));
      } else {
        console.log(`[SUMMARY] User has 1 active vesting: ${vesting.vesting_mode} pool "${stream.name}" (state: ${stream.state || 'active'})`);
      }

      // Get user's claim history for THIS specific vesting only
      const claimHistory = await this.dbService.getClaimHistory(wallet);
      const TOKEN_DECIMALS = 9;
      const TOKEN_DIVISOR = Math.pow(10, TOKEN_DECIMALS);
      // Filter claims for this specific vesting
      const vestingClaims = claimHistory.filter(claim => claim.vesting_id === vesting.id);
      const totalClaimedBaseUnits = vestingClaims.reduce((sum, claim) => sum + Number(claim.amount_claimed), 0);
      const totalClaimed = totalClaimedBaseUnits / TOKEN_DIVISOR;

      // Calculate balances using Streamflow if deployed, otherwise use DB calculation
      const totalAllocation = vesting.token_amount;
      const now = Math.floor(Date.now() / 1000);
      const startTime = stream.start_time ? Math.floor(new Date(stream.start_time).getTime() / 1000) : now;

      // Use seconds if available, otherwise fall back to days
      const vestingDurationSeconds = stream.vesting_duration_seconds || (stream.vesting_duration_days * 86400);
      const cliffDurationSeconds = stream.cliff_duration_seconds || (stream.cliff_duration_days * 86400);

      const endTime = stream.end_time ? Math.floor(new Date(stream.end_time).getTime() / 1000) : now + vestingDurationSeconds;
      const cliffTime = startTime + cliffDurationSeconds;

      // Calculate vested amount
      let vestedAmount = 0;
      let vestedPercentage = 0;

      // If pool is deployed to Streamflow, get on-chain vested amount
      if (stream.streamflow_stream_id) {
        try {
          const streamflowVested = await this.streamflowService.getVestedAmount(stream.streamflow_stream_id);
          const poolTotal = stream.total_pool_amount;
          vestedPercentage = streamflowVested / poolTotal;
          vestedAmount = totalAllocation * vestedPercentage;
          console.log(`Streamflow vested: ${streamflowVested} / ${poolTotal} = ${vestedPercentage * 100}%`);
        } catch (err) {
          console.error('Failed to get Streamflow vested amount, falling back to DB calculation:', err);
          // Fall back to DB calculation
          vestedPercentage = this.calculateVestedPercentage(now, startTime, endTime, cliffTime);
          vestedAmount = totalAllocation * vestedPercentage;
        }
      } else {
        // No Streamflow - use DB calculation
        vestedPercentage = this.calculateVestedPercentage(now, startTime, endTime, cliffTime);
        vestedAmount = totalAllocation * vestedPercentage;
      }

      const unlockedBalance = Math.max(0, vestedAmount - totalClaimed);
      const lockedBalance = totalAllocation - vestedAmount;

      // Calculate next unlock time
      const nextUnlockSeconds = now < endTime ? endTime - now : 0;

      // Get pool total from stream
      const poolTotal = stream.total_pool_amount;

      // Calculate user's share percentage
      const sharePercentage = vesting.share_percentage || ((totalAllocation / poolTotal) * 100);

      // Check if claims are globally enabled
      const dbConfig = await this.dbService.getConfig();
      const claimsEnabled = dbConfig?.enable_claims !== false;

      res.json({
        success: true,
        data: {
          poolId: vesting.vesting_stream_id,
          poolTotal,
          poolState: stream.state || 'active', // Include pool state
          distributionType: 'Based on NFT Holdings (%)',
          userShare: {
            percentage: sharePercentage,
            totalEligible: totalAllocation,
          },
          balances: {
            unlocked: unlockedBalance,
            locked: lockedBalance,
            totalClaimed,
          },
          nextUnlock: {
            seconds: Math.max(0, nextUnlockSeconds),
            timestamp: endTime,
          },
          vestingSchedule: {
            startTime,
            cliffTime,
            endTime,
          },
          nftCount: vesting.nft_count,
          tier: vesting.tier || 0,
          eligible: vesting.is_active && !vesting.is_cancelled,
          claimsEnabled, // Add this flag so frontend knows if claims are disabled
          poolPaused: isPoolPaused, // Explicit flag for paused state
          streamflow: {
            deployed: !!stream.streamflow_stream_id,
            streamId: stream.streamflow_stream_id || null,
            vestedPercentage: vestedPercentage * 100,
          },
        },
      });
    } catch (error) {
      console.error('Failed to get vesting summary:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/user/vesting/history?wallet=<address>&signature=<sig>&message=<msg>
   * Get user's claim history
   */
  async getClaimHistory(req: Request, res: Response) {
    try {
      const { wallet, signature, message } = req.query;

      if (!wallet || typeof wallet !== 'string') {
        return res.status(400).json({ error: 'wallet parameter is required' });
      }

      // Verify wallet signature for authentication (optional for read operations)
      if (signature && message) {
        try {
          const nacl = await import('tweetnacl');
          const messageBuffer = new TextEncoder().encode(message as string);
          const signatureBuffer = Buffer.from(signature as string, 'base64');
          const publicKey = new PublicKey(wallet);

          const isValid = nacl.sign.detached.verify(
            messageBuffer,
            signatureBuffer,
            publicKey.toBytes()
          );

          if (!isValid) {
            return res.status(401).json({ error: 'Invalid signature' });
          }

          // Check message freshness
          const messageData = JSON.parse(message as string);
          const timestamp = messageData.timestamp;
          const now = Date.now();
          const fiveMinutes = 5 * 60 * 1000;

          if (!timestamp || Math.abs(now - timestamp) > fiveMinutes) {
            return res.status(401).json({ error: 'Signature expired' });
          }
        } catch (err) {
          return res.status(401).json({ error: 'Signature verification failed' });
        }
      }

      // Get claim history from database with vesting information
      const { data: historyWithVestings, error: historyError } = await this.dbService.supabase
        .from('claim_history')
        .select(`
          *,
          vestings (
            id,
            user_wallet,
            token_amount,
            vesting_stream_id,
            vesting_streams (id, name, state)
          )
        `)
        .eq('user_wallet', wallet)
        .order('claimed_at', { ascending: false });

      if (historyError) {
        console.error('Supabase error fetching claim history:', historyError);
        // Return empty history on error instead of failing
        return res.json({
          success: true,
          data: [],
        });
      }

      // Handle null or empty response
      if (!historyWithVestings) {
        return res.json({
          success: true,
          data: [],
        });
      }

      // Format history for frontend (convert from base units to human-readable)
      const TOKEN_DECIMALS = 9;
      const TOKEN_DIVISOR = Math.pow(10, TOKEN_DECIMALS);

      const formattedHistory = historyWithVestings.map((claim: any) => ({
        id: claim.id,
        date: claim.claimed_at,
        amount: Number(claim.amount_claimed) / TOKEN_DIVISOR,
        feePaid: Number(claim.fee_paid),
        transactionSignature: claim.transaction_signature,
        status: 'Claimed', // All records in history are claimed
        vestingId: claim.vestings?.id || null,
        poolName: claim.vestings?.vesting_streams?.name || 'Unknown Pool',
        poolState: claim.vestings?.vesting_streams?.state || 'active',
      }));

      res.json({
        success: true,
        data: formattedHistory,
      });
    } catch (error) {
      console.error('Failed to get claim history:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/user/vesting/claim
   * User initiates claim - pays fee to treasury, gets fee transaction to sign
   * Body: { userWallet: string, amountToClaim?: number }
   * If amountToClaim is provided, claims that amount from all pools (FIFO)
   * If not provided, claims all available from all pools
   */
  async claimVesting(req: Request, res: Response) {
    try {
      // Check if claims are globally enabled
      const dbConfig = await this.dbService.getConfig();
      if (dbConfig && dbConfig.enable_claims === false) {
        return res.status(403).json({
          error: 'Claims are currently disabled by the administrator. Please try again later.'
        });
      }

      const { userWallet, amountToClaim } = req.body;

      if (!userWallet) {
        return res.status(400).json({ error: 'userWallet is required' });
      }

      // Get all active vesting pools for user
      const { data: vestings, error: vestingError } = await this.dbService.supabase
        .from('vestings')
        .select('*, vesting_streams(*)')
        .eq('user_wallet', userWallet)
        .eq('is_active', true)
        .order('created_at', { ascending: true }); // FIFO order

      if (vestingError) {
        throw vestingError;
      }

      if (!vestings || vestings.length === 0) {
        return res.status(404).json({ error: 'No active vesting found for this wallet' });
      }

      // Filter valid vestings (exclude paused/cancelled pools)
      const now = Math.floor(Date.now() / 1000);
      const validVestings = vestings.filter((v: any) => {
        if (!v.vesting_streams) return false;
        if (v.vesting_streams.state === 'cancelled' || v.vesting_streams.state === 'paused') return false;
        const startTime = new Date(v.vesting_streams.start_time);
        return startTime <= new Date();
      });

      if (validVestings.length === 0) {
        return res.status(400).json({ error: 'No valid vesting pools available for claiming' });
      }

      // Get claim history and calculate available amounts per pool
      // Optimized: Fetch vestings with claim history in single query
      const claimHistory = await this.dbService.getClaimHistory(userWallet);
      const TOKEN_DECIMALS = 9;
      const TOKEN_DIVISOR = Math.pow(10, TOKEN_DECIMALS);

      // OPTIMIZATION: Fetch all Streamflow data in parallel
      const streamflowPromises = validVestings.map(async (vesting: any) => {
        const stream = vesting.vesting_streams;
        if (stream.streamflow_stream_id) {
          const cacheKey = `streamflow:${stream.streamflow_stream_id}`;
          let streamflowVested = cache.get<number>(cacheKey);

          if (streamflowVested === null) {
            try {
              streamflowVested = await this.streamflowService.getVestedAmount(stream.streamflow_stream_id);
              cache.set(cacheKey, streamflowVested, 30);
            } catch (err) {
              streamflowVested = null; // Will fall back to time-based calculation
            }
          }
          return { vestingId: vesting.id, streamflowVested };
        }
        return { vestingId: vesting.id, streamflowVested: null };
      });

      const streamflowResults = await Promise.all(streamflowPromises);
      const streamflowMap = new Map(streamflowResults.map(r => [r.vestingId, r.streamflowVested]));

      const poolsWithAvailable = [];
      let totalAvailable = 0;

      for (const vesting of validVestings) {
        const stream = vesting.vesting_streams;
        const totalAllocation = vesting.token_amount;
        const startTime = stream.start_time ? Math.floor(new Date(stream.start_time).getTime() / 1000) : now;
        const vestingDurationSeconds = stream.vesting_duration_seconds || (stream.vesting_duration_days * 86400);
        const cliffDurationSeconds = stream.cliff_duration_seconds || (stream.cliff_duration_days * 86400);
        const endTime = stream.end_time ? Math.floor(new Date(stream.end_time).getTime() / 1000) : now + vestingDurationSeconds;
        const cliffTime = startTime + cliffDurationSeconds;

        // Calculate vested amount using pre-fetched Streamflow data
        let vestedAmount = 0;
        const streamflowVested = streamflowMap.get(vesting.id);

        if (streamflowVested !== null && streamflowVested !== undefined) {
          const poolTotal = stream.total_pool_amount;
          const vestedPercentage = streamflowVested / poolTotal;
          vestedAmount = totalAllocation * vestedPercentage;
        } else {
          const vestedPercentage = this.calculateVestedPercentage(now, startTime, endTime, cliffTime);
          vestedAmount = totalAllocation * vestedPercentage;
        }

        // Get claims for this vesting
        const vestingClaims = claimHistory.filter(claim => claim.vesting_id === vesting.id);
        const vestingTotalClaimed = vestingClaims.reduce((sum, claim) => sum + Number(claim.amount_claimed), 0) / TOKEN_DIVISOR;

        const available = Math.max(0, vestedAmount - vestingTotalClaimed);
        totalAvailable += available;

        if (available > 0) {
          poolsWithAvailable.push({
            vesting,
            stream,
            available,
            vestedAmount,
            totalAllocation,
            vestingTotalClaimed,
          });
        }
      }

      // Round down totalAvailable to 2 decimal places
      const roundedTotalAvailable = Math.floor(totalAvailable * 100) / 100;

      if (roundedTotalAvailable <= 0) {
        return res.status(400).json({ error: 'No tokens available to claim' });
      }

      // Determine actual claim amount
      const actualClaimAmount = amountToClaim
        ? Math.min(amountToClaim, roundedTotalAvailable)
        : roundedTotalAvailable;

      if (actualClaimAmount <= 0) {
        return res.status(400).json({ error: 'Invalid claim amount' });
      }

      // Distribute claim amount across pools (FIFO)
      let remainingToClaim = actualClaimAmount;
      const poolBreakdown = [];

      for (const poolData of poolsWithAvailable) {
        if (remainingToClaim <= 0) break;

        const amountFromThisPool = Math.min(remainingToClaim, poolData.available);
        remainingToClaim -= amountFromThisPool;

        poolBreakdown.push({
          poolId: poolData.vesting.vesting_stream_id,
          poolName: poolData.stream.name,
          amountToClaim: amountFromThisPool,
          availableFromPool: poolData.available,
          vestingId: poolData.vesting.id,
        });
      }

      console.log(`[CLAIM] Total available: ${roundedTotalAvailable}, claiming: ${actualClaimAmount}`);
      console.log(`[CLAIM] Pool breakdown:`, poolBreakdown);

      // Get claim fee from config or project context
      let feeInLamports: number;
      let feeWalletPubkey: PublicKey;
      let claimFeeUsd = 0;
      let feeInSol = 0;
      let project = req.project;

      // If project context is missing, try to derive it from the vestings
      if (!project && validVestings.length > 0) {
        console.log('[CLAIM] No project context in request, attempting to derive from vestings...');
        console.log('[CLAIM] First vesting data:', {
          id: validVestings[0].id,
          project_id: validVestings[0].project_id,
          stream_id: validVestings[0].vesting_stream_id,
          stream_project_id: validVestings[0].vesting_streams?.project_id
        });

        const projectId = validVestings[0].project_id || validVestings[0].vesting_streams?.project_id;
        
        if (projectId) {
          console.log(`[CLAIM] Found project ID: ${projectId}, fetching project details...`);
          const { data: derivedProject, error: projectError } = await this.dbService.supabase
            .from('projects')
            .select('*')
            .eq('id', projectId)
            .single();

          if (projectError) {
            console.error('[CLAIM] Error fetching project:', projectError);
          } else if (derivedProject) {
            console.log(`[CLAIM] Derived project context: ${derivedProject.name} (${derivedProject.id})`);
            project = derivedProject;
          }
        } else {
          // Last resort: get the first active project
          console.log('[CLAIM] No project_id in vestings, trying to get first active project...');
          const { data: projects, error: projectsError } = await this.dbService.supabase
            .from('projects')
            .select('*')
            .eq('is_active', true)
            .limit(1);

          if (projectsError) {
            console.error('[CLAIM] Error fetching projects:', projectsError);
          } else if (projects && projects.length > 0) {
            project = projects[0];
            console.log(`[CLAIM] Using first active project: ${project.name} (${project.id})`);
          }
        }
      }

      if (project) {
        console.log(`[CLAIM] Using project: ${project.name} (${project.id})`);
        
        // Multi-project mode: Fee is defined in Lamports in the project config
        feeInLamports = Number(project.claim_fee_lamports || 1000000); // Default 0.001 SOL
        feeInSol = feeInLamports / LAMPORTS_PER_SOL;

        // Use project fee recipient or fallback to vault
        if (project.fee_recipient_address) {
          feeWalletPubkey = new PublicKey(project.fee_recipient_address);
          console.log(`[CLAIM] Using project fee recipient: ${project.fee_recipient_address}`);
        } else if (project.vault_public_key) {
          feeWalletPubkey = new PublicKey(project.vault_public_key);
          console.log(`[CLAIM] Using project vault as fee recipient: ${project.vault_public_key}`);
        } else {
          // Fallback: use the globally configured fee wallet
          feeWalletPubkey = config.feeWallet || new PublicKey('11111111111111111111111111111111');
          console.warn(`[CLAIM] No fee recipient or vault configured, using fallback: ${feeWalletPubkey.toBase58()}`);
        }
      } else {
        // No project context found - this should not happen in normal operation
        console.error('[CLAIM] ❌ FAILED: No project context available after all attempts');
        console.error('[CLAIM] Vestings data:', validVestings.map((v: any) => ({
          id: v.id,
          project_id: v.project_id,
          stream_project_id: v.vesting_streams?.project_id,
          stream_id: v.vesting_stream_id,
          pool_name: v.vesting_streams?.name
        })));

        return res.status(500).json({
          error: 'Unable to determine project context for claim. Please contact support.',
          details: 'The system could not identify which project vault to use for this claim.',
          debug: {
            vestingsCount: validVestings.length,
            hasProjectId: !!validVestings[0]?.project_id,
            hasStreamProjectId: !!validVestings[0]?.vesting_streams?.project_id
          }
        });
      }

      const userPublicKey = new PublicKey(userWallet);

      // Skip balance check - user will get error from Solana if insufficient SOL
      // This saves 1 RPC call per claim request

      console.log(`[CLAIM] Creating fee transaction: ${feeInSol} SOL from ${userWallet} to ${feeWalletPubkey.toBase58()}`);

      // Create fee payment transaction (user pays fee to treasury)
      // Use cached blockhash if available (5 second TTL)
      let blockhash: string;
      const now_ms = Date.now();

      if (this.lastBlockhash && (now_ms - this.lastBlockhash.timestamp) < 5000) {
        blockhash = this.lastBlockhash.hash;
      } else {
        const result = await this.connection.getLatestBlockhash('finalized');
        blockhash = result.blockhash;
        this.lastBlockhash = { hash: blockhash, timestamp: now_ms };
      }

      const message = new TransactionMessage({
        payerKey: userPublicKey,
        recentBlockhash: blockhash,
        instructions: [
          SystemProgram.transfer({
            fromPubkey: userPublicKey,
            toPubkey: feeWalletPubkey,
            lamports: feeInLamports,
          }),
        ],
      }).compileToV0Message();

      // Create a VersionedTransaction with empty signatures for the frontend to sign
      const versionedTx = new VersionedTransaction(message);
      const serializedFeeTx = Buffer.from(versionedTx.serialize()).toString('base64');

      // Clear blockhash cache after use to ensure fresh blockhash for transaction
      this.lastBlockhash = null;

      // Return fee transaction for user to sign
      res.json({
        success: true,
        step: 'fee_payment_required',
        feeTransaction: serializedFeeTx,
        feeDetails: {
          amountUsd: claimFeeUsd,
          amountSol: feeInSol,
          amountLamports: feeInLamports,
          feeWallet: feeWalletPubkey.toBase58(),
        },
        claimDetails: {
          amountToClaim: actualClaimAmount,
          totalAvailable: roundedTotalAvailable,
          poolBreakdown,
        },
        instructions: 'Sign and send the feeTransaction, then call /api/user/vesting/complete-claim with the fee signature',
      });
    } catch (error) {
      console.error('Failed to process claim:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/user/vesting/complete-claim
   * Complete claim after fee payment - transfers tokens from treasury to user
   * Body: { userWallet: string, feeSignature: string, poolBreakdown: Array }
   */
  async completeClaimWithFee(req: Request, res: Response) {
    try {
      const { userWallet, feeSignature, poolBreakdown } = req.body;

      console.log('[COMPLETE-CLAIM] Request body:', { userWallet, feeSignature, poolBreakdown });

      if (!userWallet || !feeSignature) {
        return res.status(400).json({ error: 'userWallet and feeSignature are required' });
      }

      if (!poolBreakdown || !Array.isArray(poolBreakdown) || poolBreakdown.length === 0) {
        return res.status(400).json({ error: 'poolBreakdown array is required' });
      }

      // Verify fee payment transaction
      const feeTransaction = await this.connection.getTransaction(feeSignature, {
        maxSupportedTransactionVersion: 0,
      });

      if (!feeTransaction || feeTransaction.meta?.err) {
        return res.status(400).json({ error: 'Fee payment transaction not found or failed' });
      }

      console.log('[COMPLETE-CLAIM] Fee transaction verified');

      // Note: Duplicate claim prevention is now handled by:
      // 1. Database UNIQUE constraint on (user_wallet, transaction_signature)
      // 2. Rate limiter (max 1 claim per wallet per 10 seconds)
      // 3. Deduplication middleware (catches duplicate requests)
      // We no longer check feeSignature since we use tokenSignature for the actual transfer

      // Calculate total claim amount from breakdown
      const totalClaimAmount = poolBreakdown.reduce((sum: number, p: any) => sum + p.amountToClaim, 0);

      console.log(`[COMPLETE-CLAIM] Total claim amount: ${totalClaimAmount} tokens`);
      console.log(`[COMPLETE-CLAIM] Pool breakdown:`, poolBreakdown);

      if (totalClaimAmount <= 0) {
        return res.status(400).json({ error: 'Invalid claim amount' });
      }

      // Determine Vault Signer and Token Mint
      let vaultKeypair: Keypair;
      let tokenMint: PublicKey;
      let project = req.project;

      // If project context is missing, try to derive it from the pool breakdown
      if (!project && poolBreakdown.length > 0) {
        console.log('[COMPLETE-CLAIM] No project context in request, attempting to derive...');
        
        // Get the first vesting ID from breakdown
        const firstVestingId = poolBreakdown[0].vestingId;
        if (firstVestingId) {
          const { data: vesting, error: vestingError } = await this.dbService.supabase
            .from('vestings')
            .select('project_id, vesting_streams(project_id)')
            .eq('id', firstVestingId)
            .single();

          if (vestingError) {
            console.error('[COMPLETE-CLAIM] Error fetching vesting:', vestingError);
          }

          const projectId = vesting?.project_id || vesting?.vesting_streams?.project_id;

          if (projectId) {
            console.log(`[COMPLETE-CLAIM] Found project ID: ${projectId}, fetching project...`);
            const { data: derivedProject, error: projectError } = await this.dbService.supabase
              .from('projects')
              .select('*')
              .eq('id', projectId)
              .single();

            if (projectError) {
              console.error('[COMPLETE-CLAIM] Error fetching project:', projectError);
            } else if (derivedProject) {
              console.log(`[COMPLETE-CLAIM] Derived project context: ${derivedProject.name} (${derivedProject.id})`);
              project = derivedProject;
            }
          } else {
            // Last resort: get first active project
            console.log('[COMPLETE-CLAIM] No project_id found, trying first active project...');
            const { data: projects, error: projectsError } = await this.dbService.supabase
              .from('projects')
              .select('*')
              .eq('is_active', true)
              .limit(1);

            if (projectsError) {
              console.error('[COMPLETE-CLAIM] Error fetching projects:', projectsError);
            } else if (projects && projects.length > 0) {
              project = projects[0];
              console.log(`[COMPLETE-CLAIM] Using first active project: ${project.name} (${project.id})`);
            }
          }
        }
      }

      if (project) {
        try {
          vaultKeypair = await getVaultKeypairForProject(project.id);
          tokenMint = new PublicKey(project.mint_address);
        } catch (err) {
          console.error('Failed to get project vault:', err);
          return res.status(500).json({ error: 'Failed to access project vault' });
        }
      } else {
        // No project context found - this should not happen in normal operation
        console.error('[COMPLETE-CLAIM] No project context available. Pool breakdown:', poolBreakdown);

        return res.status(500).json({
          error: 'Unable to determine project context for claim completion. Please contact support.',
          details: 'The system could not identify which project vault to use for this claim.'
        });
      }

      // Transfer tokens from vault/treasury to user
      console.log('[COMPLETE-CLAIM] Transferring tokens from vault to user...');

      const TOKEN_DECIMALS = 9;
      const userPublicKey = new PublicKey(userWallet);

      const vaultTokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        vaultKeypair.publicKey
      );

      const userTokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        userPublicKey
      );

      // Check if user's token account exists, create if not
      let userTokenAccountExists = false;
      try {
        await getAccount(this.connection, userTokenAccount);
        userTokenAccountExists = true;
        console.log('[COMPLETE-CLAIM] User token account exists');
      } catch (err) {
        console.log('[COMPLETE-CLAIM] User token account does not exist, will create it');
      }

      // Convert total claim amount to base units using Decimal.js for precision
      const amountInBaseUnits = this.toBaseUnits(totalClaimAmount, TOKEN_DECIMALS);

      console.log(`[COMPLETE-CLAIM] Transferring ${totalClaimAmount} tokens (${amountInBaseUnits} base units)`);

      const tokenTransferTx = new Transaction();

      // Add create account instruction if needed
      if (!userTokenAccountExists) {
        console.log('[COMPLETE-CLAIM] Adding create token account instruction');
        tokenTransferTx.add(
          createAssociatedTokenAccountInstruction(
            vaultKeypair.publicKey,
            userTokenAccount,
            userPublicKey,
            tokenMint
          )
        );
      }

      // Add transfer instruction
      tokenTransferTx.add(
        createTransferInstruction(
          vaultTokenAccount,
          userTokenAccount,
          vaultKeypair.publicKey,
          amountInBaseUnits
        )
      );

      // Send transaction - use Solana's built-in retry instead of manual retry
      // This prevents duplicate transactions
      let tokenSignature: string | null = null;

      try {
        console.log(`[COMPLETE-CLAIM] Sending transaction...`);

        // Get blockhash
        const { blockhash } = await this.connection.getLatestBlockhash();
        tokenTransferTx.recentBlockhash = blockhash;

        // Send with Solana's built-in retry (maxRetries: 3)
        // This retries the SAME transaction, not creating new ones
        tokenSignature = await this.connection.sendTransaction(tokenTransferTx, [vaultKeypair], {
          skipPreflight: true,
          maxRetries: 3, // Let Solana handle retries
        });

        console.log(`[COMPLETE-CLAIM] Transaction sent: ${tokenSignature}, confirming...`);

        // Wait for confirmation with 30 second timeout
        try {
          await Promise.race([
            this.connection.confirmTransaction(tokenSignature, 'confirmed'),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Transaction confirmation timeout')), 30000)
            )
          ]);

          console.log('[COMPLETE-CLAIM] Transfer confirmed! Signature:', tokenSignature);
        } catch (confirmError) {
          // Timeout occurred - check transaction status
          console.warn(`[COMPLETE-CLAIM] Confirmation timeout, checking transaction status: ${tokenSignature}`);

          try {
            const status = await this.connection.getSignatureStatus(tokenSignature);
            if (status && status.value && !status.value.err) {
              console.log('[COMPLETE-CLAIM] Transaction confirmed despite timeout! Signature:', tokenSignature);
            } else if (status && status.value && status.value.err) {
              throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.value.err)}`);
            } else {
              // Still unknown - wait a bit more and check again
              console.log('[COMPLETE-CLAIM] Transaction status still unknown, checking again in 5s...');
              await new Promise(resolve => setTimeout(resolve, 5000));
              const retryStatus = await this.connection.getSignatureStatus(tokenSignature);
              if (retryStatus && retryStatus.value && !retryStatus.value.err) {
                console.log('[COMPLETE-CLAIM] Transaction confirmed on second check! Signature:', tokenSignature);
              } else {
                throw new Error('Transaction confirmation failed');
              }
            }
          } catch (statusError) {
            console.error('[COMPLETE-CLAIM] Error checking transaction status:', statusError);
            throw statusError;
          }
        }

      } catch (err) {
        const lastError = err instanceof Error ? err : new Error('Unknown transaction error');
        console.error(`[COMPLETE-CLAIM] Transaction failed:`, lastError.message);
        throw new Error(`Transaction failed: ${lastError.message}`);
      }

      if (!tokenSignature) {
        throw new Error('Failed to send transaction');
      }

      // Get fee amount
      let feeInSol = 0;

      if (req.project) {
        feeInSol = Number(req.project.claim_fee_lamports || 1000000) / LAMPORTS_PER_SOL;
      } else {
        const dbConfig = await this.dbService.getConfig();
        const claimFeeUsd = dbConfig?.claim_fee_usd || 10.0;

        const { PriceService } = await import('../services/priceService');
        const priceService = new PriceService(this.connection, 'mainnet-beta');
        const { solAmount } = await priceService.calculateSolFee(claimFeeUsd);
        feeInSol = solAmount;
      }

      // Record claims in database for each pool
      const TOKEN_DIVISOR = Math.pow(10, TOKEN_DECIMALS);

      for (const poolItem of poolBreakdown) {
        if (poolItem.amountToClaim > 0) {
          // Use Decimal.js for precise conversion
          const amountInBaseUnits = Number(this.toBaseUnits(poolItem.amountToClaim, TOKEN_DECIMALS));

          // Skip if amount rounds to 0 (too small to record)
          if (amountInBaseUnits === 0) {
            console.log(`[COMPLETE-CLAIM] Skipping pool ${poolItem.poolName}: amount too small (${poolItem.amountToClaim} tokens)`);
            continue;
          }

          const proportionalFee = (poolItem.amountToClaim / totalClaimAmount) * feeInSol;

          await this.dbService.createClaim({
            user_wallet: userWallet,
            vesting_id: poolItem.vestingId,
            amount_claimed: amountInBaseUnits,
            fee_paid: proportionalFee,
            transaction_signature: tokenSignature,
          });

          console.log(`[COMPLETE-CLAIM] Recorded claim for pool ${poolItem.poolName}: ${poolItem.amountToClaim} tokens (${amountInBaseUnits} base units)`);
        }
      }

      res.json({
        success: true,
        data: {
          totalAmountClaimed: totalClaimAmount,
          poolBreakdown,
          feePaid: feeInSol,
          feeTransactionSignature: feeSignature,
          tokenTransactionSignature: tokenSignature,
        },
      });
    } catch (error) {
      console.error('Failed to complete claim:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/user/vesting/summary-all?wallet=xxx
   * Get aggregated summary across ALL vesting pools for a wallet
   */
  async getVestingSummaryAll(req: Request, res: Response) {
    try {
      const { wallet } = req.query;

      if (!wallet || typeof wallet !== 'string') {
        return res.status(400).json({ error: 'wallet parameter is required' });
      }

      // Get ALL active vesting records for this wallet
      const { data: vestings, error: vestingError } = await this.dbService.supabase
        .from('vestings')
        .select('*, vesting_streams(*)')
        .eq('user_wallet', wallet)
        .eq('is_active', true)
        .order('created_at', { ascending: false });

      if (vestingError) {
        throw vestingError;
      }

      if (!vestings || vestings.length === 0) {
        return res.json({
          success: true,
          data: {
            totalClaimable: 0,
            totalLocked: 0,
            totalClaimed: 0,
            totalVested: 0,
            vestedPercentage: 0,
            nextUnlockTime: 0,
            pools: [],
          },
        });
      }

      // Filter out invalid vestings (cancelled and paused pools should not contribute to claimable amount)
      const validVestings = vestings.filter((v: any) => {
        if (!v.vesting_streams) return false;
        if (v.vesting_streams.state === 'cancelled' || v.vesting_streams.state === 'paused') return false;
        const startTime = new Date(v.vesting_streams.start_time);
        return startTime <= new Date();
      });

      if (validVestings.length === 0) {
        return res.json({
          success: true,
          data: {
            totalClaimable: 0,
            totalLocked: 0,
            totalClaimed: 0,
            totalVested: 0,
            vestedPercentage: 0,
            nextUnlockTime: 0,
            pools: [],
          },
        });
      }

      // Get claim history for this wallet
      const claimHistory = await this.dbService.getClaimHistory(wallet);
      const TOKEN_DECIMALS = 9;
      const TOKEN_DIVISOR = Math.pow(10, TOKEN_DECIMALS);

      // Calculate aggregated totals (only from active pools)
      let totalClaimable = 0;
      let totalLocked = 0;
      let totalClaimed = 0;
      let totalVested = 0;
      let nextUnlockTime = 0;
      const now = Math.floor(Date.now() / 1000);

      const poolsData = [];

      // Process only active pools for totals
      for (const vesting of validVestings) {
        const stream = vesting.vesting_streams;
        const totalAllocation = vesting.token_amount;
        const startTime = stream.start_time ? Math.floor(new Date(stream.start_time).getTime() / 1000) : now;
        const vestingDurationSeconds = stream.vesting_duration_seconds || (stream.vesting_duration_days * 86400);
        const cliffDurationSeconds = stream.cliff_duration_seconds || (stream.cliff_duration_days * 86400);
        const endTime = stream.end_time ? Math.floor(new Date(stream.end_time).getTime() / 1000) : now + vestingDurationSeconds;
        const cliffTime = startTime + cliffDurationSeconds;

        // Calculate vested amount (with Streamflow caching)
        let vestedAmount = 0;
        if (stream.streamflow_stream_id) {
          try {
            // Check cache first (30 second TTL)
            const cacheKey = `streamflow:${stream.streamflow_stream_id}`;
            let streamflowVested = cache.get<number>(cacheKey);

            if (streamflowVested === null) {
              streamflowVested = await this.streamflowService.getVestedAmount(stream.streamflow_stream_id);
              cache.set(cacheKey, streamflowVested, 30);
            }

            const poolTotal = stream.total_pool_amount;
            const vestedPercentage = streamflowVested / poolTotal;
            vestedAmount = totalAllocation * vestedPercentage;
          } catch (err) {
            const vestedPercentage = this.calculateVestedPercentage(now, startTime, endTime, cliffTime);
            vestedAmount = totalAllocation * vestedPercentage;
          }
        } else {
          const vestedPercentage = this.calculateVestedPercentage(now, startTime, endTime, cliffTime);
          vestedAmount = totalAllocation * vestedPercentage;
        }

        // Get claims for this specific vesting
        const vestingClaims = claimHistory.filter(claim => claim.vesting_id === vesting.id);
        const vestingTotalClaimed = vestingClaims.reduce((sum, claim) => sum + Number(claim.amount_claimed), 0) / TOKEN_DIVISOR;

        const unlockedBalance = Math.max(0, vestedAmount - vestingTotalClaimed);
        const lockedBalance = totalAllocation - vestedAmount;

        // Only add to totals if pool is active
        totalClaimable += unlockedBalance;
        totalLocked += lockedBalance;
        totalClaimed += vestingTotalClaimed;
        totalVested += vestedAmount;

        // Track next unlock time
        if (endTime > now && endTime > nextUnlockTime) {
          nextUnlockTime = endTime;
        }

        // Add to pools data
        const poolTotal = stream.total_pool_amount;
        const sharePercentage = vesting.share_percentage || ((totalAllocation / poolTotal) * 100);

        poolsData.push({
          poolId: vesting.vesting_stream_id,
          poolName: stream.name,
          claimable: unlockedBalance,
          locked: lockedBalance,
          claimed: vestingTotalClaimed,
          share: sharePercentage,
          nftCount: vesting.nft_count,
          status: stream.state || 'active',
        });
      }

      // Also add paused/cancelled pools to display (but not to totals)
      const pausedCancelledVestings = vestings.filter((v: any) => {
        if (!v.vesting_streams) return false;
        return v.vesting_streams.state === 'cancelled' || v.vesting_streams.state === 'paused';
      });

      for (const vesting of pausedCancelledVestings) {
        const stream = vesting.vesting_streams;
        const totalAllocation = vesting.token_amount;
        const startTime = stream.start_time ? Math.floor(new Date(stream.start_time).getTime() / 1000) : now;
        const vestingDurationSeconds = stream.vesting_duration_seconds || (stream.vesting_duration_days * 86400);
        const cliffDurationSeconds = stream.cliff_duration_seconds || (stream.cliff_duration_days * 86400);
        const endTime = stream.end_time ? Math.floor(new Date(stream.end_time).getTime() / 1000) : now + vestingDurationSeconds;
        const cliffTime = startTime + cliffDurationSeconds;

        // Calculate vested amount (with Streamflow caching)
        let vestedAmount = 0;
        if (stream.streamflow_stream_id) {
          try {
            // Check cache first (30 second TTL)
            const cacheKey = `streamflow:${stream.streamflow_stream_id}`;
            let streamflowVested = cache.get<number>(cacheKey);

            if (streamflowVested === null) {
              streamflowVested = await this.streamflowService.getVestedAmount(stream.streamflow_stream_id);
              cache.set(cacheKey, streamflowVested, 30);
            }

            const poolTotal = stream.total_pool_amount;
            const vestedPercentage = streamflowVested / poolTotal;
            vestedAmount = totalAllocation * vestedPercentage;
          } catch (err) {
            const vestedPercentage = this.calculateVestedPercentage(now, startTime, endTime, cliffTime);
            vestedAmount = totalAllocation * vestedPercentage;
          }
        } else {
          const vestedPercentage = this.calculateVestedPercentage(now, startTime, endTime, cliffTime);
          vestedAmount = totalAllocation * vestedPercentage;
        }

        // Get claims for this specific vesting
        const vestingClaims = claimHistory.filter(claim => claim.vesting_id === vesting.id);
        const vestingTotalClaimed = vestingClaims.reduce((sum, claim) => sum + Number(claim.amount_claimed), 0) / TOKEN_DIVISOR;

        const unlockedBalance = Math.max(0, vestedAmount - vestingTotalClaimed);
        const lockedBalance = totalAllocation - vestedAmount;

        // Add to pools data for display only (NOT to totals)
        const poolTotal = stream.total_pool_amount;
        const sharePercentage = vesting.share_percentage || ((totalAllocation / poolTotal) * 100);

        poolsData.push({
          poolId: vesting.vesting_stream_id,
          poolName: stream.name,
          claimable: unlockedBalance,
          locked: lockedBalance,
          claimed: vestingTotalClaimed,
          share: sharePercentage,
          nftCount: vesting.nft_count,
          status: stream.state || 'paused',
        });
      }

      const totalAllocation = validVestings.reduce((sum: number, v: any) => sum + v.token_amount, 0);
      const vestedPercentage = totalAllocation > 0 ? (totalVested / totalAllocation) * 100 : 0;

      // Round down totalClaimable to 2 decimal places to match frontend display
      // This ensures users can claim exactly what they see
      const roundedTotalClaimable = Math.floor(totalClaimable * 100) / 100;

      // Filter out pools with no claimable balance (fully vested + fully claimed)
      const activePoolsData = poolsData.filter(pool => pool.claimable > 0);

      res.json({
        success: true,
        data: {
          totalClaimable: roundedTotalClaimable,
          totalLocked,
          totalClaimed,
          totalVested,
          vestedPercentage,
          nextUnlockTime,
          pools: activePoolsData,
        },
      });
    } catch (error) {
      console.error('Failed to get vesting summary all:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/user/vesting/claim-all
   * Claim custom amount from all vesting pools at once
   */
  async claimAllVestings(req: Request, res: Response) {
    try {
      const { userWallet, amountToClaim } = req.body;

      if (!userWallet) {
        return res.status(400).json({ error: 'userWallet is required' });
      }

      if (!amountToClaim || amountToClaim <= 0) {
        return res.status(400).json({ error: 'amountToClaim must be greater than 0' });
      }

      // Minimum claim amount: 0.001 tokens (1,000,000 base units)
      const MIN_CLAIM_AMOUNT = 0.001;
      if (amountToClaim < MIN_CLAIM_AMOUNT) {
        return res.status(400).json({
          error: `Minimum claim amount is ${MIN_CLAIM_AMOUNT} tokens. You requested ${amountToClaim} tokens.`,
          minimumAmount: MIN_CLAIM_AMOUNT,
          requestedAmount: amountToClaim
        });
      }

      // Get all active vesting pools for user
      const { data: vestings, error: vestingError } = await this.dbService.supabase
        .from('vestings')
        .select('*, vesting_streams(*)')
        .eq('user_wallet', userWallet)
        .eq('is_active', true)
        .order('created_at', { ascending: false });

      if (vestingError) {
        throw vestingError;
      }

      if (!vestings || vestings.length === 0) {
        return res.status(404).json({ error: 'No active vesting found for this wallet' });
      }

      // Filter valid vestings
      const now = Math.floor(Date.now() / 1000);
      const validVestings = vestings.filter((v: any) => {
        if (!v.vesting_streams) return false;
        if (v.vesting_streams.state === 'cancelled' || v.vesting_streams.state === 'paused') return false;
        const startTime = new Date(v.vesting_streams.start_time);
        return startTime <= new Date();
      });

      if (validVestings.length === 0) {
        return res.status(400).json({ error: 'No valid vesting pools available' });
      }

      // Get claim history and config
      const claimHistory = await this.dbService.getClaimHistory(userWallet);
      const dbConfig = await this.dbService.getConfig();
      const claimFeeUSD = dbConfig?.claim_fee_usd || 0;
      const TOKEN_DECIMALS = 9;
      const TOKEN_DIVISOR = Math.pow(10, TOKEN_DECIMALS);

      // Calculate available amount per pool
      const poolsWithAvailable = [];
      let totalAvailable = 0;

      for (const vesting of validVestings) {
        const stream = vesting.vesting_streams;
        const totalAllocation = vesting.token_amount;
        const startTime = stream.start_time ? Math.floor(new Date(stream.start_time).getTime() / 1000) : now;
        const vestingDurationSeconds = stream.vesting_duration_seconds || (stream.vesting_duration_days * 86400);
        const cliffDurationSeconds = stream.cliff_duration_seconds || (stream.cliff_duration_days * 86400);
        const endTime = stream.end_time ? Math.floor(new Date(stream.end_time).getTime() / 1000) : now + vestingDurationSeconds;
        const cliffTime = startTime + cliffDurationSeconds;

        // Calculate vested amount (with Streamflow caching)
        let vestedAmount = 0;
        if (stream.streamflow_stream_id) {
          try {
            // Check cache first (30 second TTL)
            const cacheKey = `streamflow:${stream.streamflow_stream_id}`;
            let streamflowVested = cache.get<number>(cacheKey);

            if (streamflowVested === null) {
              streamflowVested = await this.streamflowService.getVestedAmount(stream.streamflow_stream_id);
              cache.set(cacheKey, streamflowVested, 30);
            }

            const poolTotal = stream.total_pool_amount;
            const vestedPercentage = streamflowVested / poolTotal;
            vestedAmount = totalAllocation * vestedPercentage;
          } catch (err) {
            const vestedPercentage = this.calculateVestedPercentage(now, startTime, endTime, cliffTime);
            vestedAmount = totalAllocation * vestedPercentage;
          }
        } else {
          const vestedPercentage = this.calculateVestedPercentage(now, startTime, endTime, cliffTime);
          vestedAmount = totalAllocation * vestedPercentage;
        }

        // Get claims for this vesting
        const vestingClaims = claimHistory.filter(claim => claim.vesting_id === vesting.id);
        const vestingTotalClaimed = vestingClaims.reduce((sum, claim) => sum + Number(claim.amount_claimed), 0) / TOKEN_DIVISOR;

        const available = Math.max(0, vestedAmount - vestingTotalClaimed);
        totalAvailable += available;

        poolsWithAvailable.push({
          vesting,
          stream,
          available,
          vestedAmount,
          totalAllocation,
          vestingTotalClaimed,
        });
      }

      // Round down totalAvailable to 2 decimal places to match what frontend shows
      const roundedTotalAvailable = Math.floor(totalAvailable * 100) / 100;

      // Validate requested amount
      if (amountToClaim > roundedTotalAvailable) {
        return res.status(400).json({
          error: `Requested amount ${amountToClaim.toFixed(2)} exceeds available balance ${roundedTotalAvailable.toFixed(2)}`,
          available: roundedTotalAvailable,
          requested: amountToClaim,
        });
      }

      // Distribute amount across pools using FIFO
      const poolBreakdown = [];
      let remainingToClaim = amountToClaim;

      for (const poolData of poolsWithAvailable) {
        if (remainingToClaim <= 0) break;

        const claimFromThisPool = Math.min(poolData.available, remainingToClaim);
        if (claimFromThisPool > 0) {
          poolBreakdown.push({
            poolId: poolData.vesting.vesting_stream_id,
            poolName: poolData.stream.name,
            amountToClaim: claimFromThisPool,
            availableFromPool: poolData.available,
          });
          remainingToClaim -= claimFromThisPool;
        }
      }

      // Determine Vault Signer, Token Mint, and Fee
      let vaultKeypair: Keypair;
      let tokenMint: PublicKey;
      let feeInSOL = 0;
      let feeWallet: PublicKey | null = null;

      if (req.project) {
        try {
          vaultKeypair = await getVaultKeypairForProject(req.project.id);
          tokenMint = new PublicKey(req.project.mint_address);

          const feeInLamports = Number(req.project.claim_fee_lamports || 1000000);
          feeInSOL = feeInLamports / LAMPORTS_PER_SOL;

          if (req.project.fee_recipient_address) {
            feeWallet = new PublicKey(req.project.fee_recipient_address);
          } else {
            // Fallback to vault public key if no fee recipient specified
            feeWallet = vaultKeypair.publicKey;
          }
        } catch (err) {
          console.error('Failed to get project vault:', err);
          return res.status(500).json({ error: 'Failed to access project vault' });
        }
      } else {
        // Legacy: Parse treasury keypair
        try {
          if (!config.treasuryPrivateKey) {
            throw new Error('Treasury private key not configured');
          }
          if (config.treasuryPrivateKey.startsWith('[')) {
            const secretKey = Uint8Array.from(JSON.parse(config.treasuryPrivateKey));
            vaultKeypair = Keypair.fromSecretKey(secretKey);
          } else {
            try {
              const bs58 = await import('bs58');
              const decoded = bs58.default.decode(config.treasuryPrivateKey);
              vaultKeypair = Keypair.fromSecretKey(decoded);
            } catch {
              const decoded = Buffer.from(config.treasuryPrivateKey, 'base64');
              vaultKeypair = Keypair.fromSecretKey(decoded);
            }
          }
          tokenMint = new PublicKey(config.customTokenMint!);

          // Calculate legacy fee
          if (claimFeeUSD > 0 && dbConfig?.fee_wallet) {
            try {
              const { solAmount } = await this.priceService.calculateSolFee(claimFeeUSD);
              feeInSOL = solAmount;
              feeWallet = new PublicKey(dbConfig.fee_wallet);
            } catch (err) {
              console.warn('Failed to calculate legacy fee:', err);
            }
          }
        } catch (err) {
          console.error('Treasury key parse error:', err);
          return res.status(500).json({ error: 'Invalid treasury key configuration' });
        }
      }

      // Create token transfer transaction
      const userPublicKey = new PublicKey(userWallet);

      const vaultTokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        vaultKeypair.publicKey
      );

      const userTokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        userPublicKey
      );

      // Check if user's token account exists
      let userTokenAccountExists = false;
      try {
        await getAccount(this.connection, userTokenAccount);
        userTokenAccountExists = true;
      } catch (err) {
        // Account doesn't exist, will create it
      }

      // Build transaction with all transfers
      const tokenTransferTx = new Transaction();

      if (!userTokenAccountExists) {
        tokenTransferTx.add(
          createAssociatedTokenAccountInstruction(
            vaultKeypair.publicKey,
            userTokenAccount,
            userPublicKey,
            tokenMint
          )
        );
      }

      // Add transfer instructions for each pool
      // Use precise conversion to avoid floating point errors
      const amountInBaseUnitsFloat = amountToClaim * 1e9;
      const amountInBaseUnits = BigInt(Math.round(amountInBaseUnitsFloat));

      tokenTransferTx.add(
        createTransferInstruction(
          vaultTokenAccount,
          userTokenAccount,
          vaultKeypair.publicKey,
          amountInBaseUnits
        )
      );

      // Add SOL fee transfer if fee is set and fee wallet is configured
      if (feeInSOL > 0 && feeWallet) {
        const feeInLamports = Math.floor(feeInSOL * LAMPORTS_PER_SOL);
        if (feeInLamports > 0) {
          tokenTransferTx.add(
            SystemProgram.transfer({
              fromPubkey: userPublicKey,
              toPubkey: feeWallet,
              lamports: feeInLamports,
            })
          );
          console.log(`[CLAIM-ALL] Added SOL fee transfer: ${feeInSOL} SOL from user to fee wallet`);
        }
      }

      // Get recent blockhash and send transaction
      const { blockhash } = await this.connection.getLatestBlockhash();
      tokenTransferTx.recentBlockhash = blockhash;
      // User pays network fees (tiny ~0.00001 SOL) + claim fee
      tokenTransferTx.feePayer = new PublicKey(userWallet);

      let tokenSignature: string | null = null;

      try {
        console.log(`[CLAIM-ALL] Sending transaction...`);

        // Get blockhash
        const { blockhash } = await this.connection.getLatestBlockhash();
        tokenTransferTx.recentBlockhash = blockhash;

        // Send with Solana's built-in retry (maxRetries: 3)
        // This retries the SAME transaction, not creating new ones
        tokenSignature = await this.connection.sendTransaction(tokenTransferTx, [vaultKeypair], {
          skipPreflight: true,
          maxRetries: 3, // Let Solana handle retries
        });

        console.log(`[CLAIM-ALL] Transaction sent: ${tokenSignature}, confirming...`);

        try {
          // Use 30 second timeout for confirmation
          const latestBlockhash = await this.connection.getLatestBlockhash();
          await Promise.race([
            this.connection.confirmTransaction(
              {
                signature: tokenSignature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
              },
              'confirmed'
            ),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Transaction confirmation timeout')), 30000)
            ),
          ]);

          console.log('[CLAIM-ALL] Transfer confirmed successfully! Signature:', tokenSignature);
        } catch (confirmError) {
          console.warn(`[CLAIM-ALL] Confirmation timed out, checking transaction status: ${tokenSignature}`);

          // Check if transaction was actually successful despite timeout
          try {
            const status = await this.connection.getSignatureStatus(tokenSignature);
            if (status && status.value && !status.value.err) {
              console.log('[CLAIM-ALL] Transaction successful despite confirmation timeout! Signature:', tokenSignature);
            } else if (status && status.value && status.value.err) {
              throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.value.err)}`);
            } else {
              // Still unknown - wait and check again
              console.log('[CLAIM-ALL] Transaction status still unknown, checking again in 5s...');
              await new Promise(resolve => setTimeout(resolve, 5000));
              const retryStatus = await this.connection.getSignatureStatus(tokenSignature);
              if (retryStatus && retryStatus.value && !retryStatus.value.err) {
                console.log('[CLAIM-ALL] Transaction confirmed on second check! Signature:', tokenSignature);
              } else {
                throw new Error('Transaction confirmation failed');
              }
            }
          } catch (statusError) {
            console.error('[CLAIM-ALL] Error checking transaction status:', statusError);
            throw statusError;
          }
        }
      } catch (err) {
        console.error(`[CLAIM-ALL] Transaction failed:`, err);
        throw new Error(`Transaction failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }

      if (!tokenSignature) {
        throw new Error('Failed to send transaction');
      }

      // Record claims in database for each pool that had an amount claimed
      // Distribute fee proportionally across pools based on claim amount
      const totalClaimAmount = poolBreakdown.reduce((sum, p) => sum + p.amountToClaim, 0);

      for (const poolBreakdownItem of poolBreakdown) {
        const poolData = poolsWithAvailable.find(p => p.vesting.vesting_stream_id === poolBreakdownItem.poolId);
        if (poolData && poolBreakdownItem.amountToClaim > 0) {
          // Use Decimal.js for precise conversion
          const amountInBaseUnits = Number(this.toBaseUnits(poolBreakdownItem.amountToClaim, TOKEN_DECIMALS));

          // Skip if amount rounds to 0 (too small to record)
          if (amountInBaseUnits === 0) {
            console.log(`[CLAIM-ALL] Skipping pool ${poolBreakdownItem.poolId}: amount too small (${poolBreakdownItem.amountToClaim} tokens)`);
            continue;
          }

          // Calculate proportional fee for this pool
          const proportionalFee = (poolBreakdownItem.amountToClaim / totalClaimAmount) * claimFeeUSD;

          await this.dbService.createClaim({
            user_wallet: userWallet,
            vesting_id: poolData.vesting.id,
            amount_claimed: amountInBaseUnits,
            fee_paid: proportionalFee,
            transaction_signature: tokenSignature,
          });

          console.log(`[CLAIM-ALL] Recorded claim for pool ${poolBreakdownItem.poolId}: ${poolBreakdownItem.amountToClaim} tokens (${amountInBaseUnits} base units)`);
        }
      }

      res.json({
        success: true,
        data: {
          totalAmountClaimed: amountToClaim,
          poolBreakdown,
          transactionSignature: tokenSignature,
          status: 'success',
        },
      });
    } catch (error) {
      console.error('Failed to claim all vestings:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/user/vesting/prepare-claim
   * Prepare unsigned transaction for user to sign
   * Returns the unsigned transaction and fee details
   */
  async prepareClaimTransaction(req: Request, res: Response) {
    try {
      const { userWallet, amountToClaim } = req.body;

      if (!userWallet) {
        return res.status(400).json({ error: 'userWallet is required' });
      }

      if (!amountToClaim || amountToClaim <= 0) {
        return res.status(400).json({ error: 'amountToClaim must be greater than 0' });
      }

      // Minimum claim amount: 0.001 tokens (1,000,000 base units)
      const MIN_CLAIM_AMOUNT = 0.001;
      if (amountToClaim < MIN_CLAIM_AMOUNT) {
        return res.status(400).json({
          error: `Minimum claim amount is ${MIN_CLAIM_AMOUNT} tokens. You requested ${amountToClaim} tokens.`,
          minimumAmount: MIN_CLAIM_AMOUNT,
          requestedAmount: amountToClaim
        });
      }

      // Get all active vesting pools for user
      const { data: vestings, error: vestingError } = await this.dbService.supabase
        .from('vestings')
        .select('*, vesting_streams(*)')
        .eq('user_wallet', userWallet)
        .eq('is_active', true)
        .order('created_at', { ascending: false });

      if (vestingError) {
        throw vestingError;
      }

      if (!vestings || vestings.length === 0) {
        return res.status(404).json({ error: 'No active vesting found for this wallet' });
      }

      // Filter valid vestings
      const now = Math.floor(Date.now() / 1000);
      const validVestings = vestings.filter((v: any) => {
        if (!v.vesting_streams) return false;
        if (v.vesting_streams.state === 'cancelled' || v.vesting_streams.state === 'paused') return false;
        const startTime = new Date(v.vesting_streams.start_time);
        return startTime <= new Date();
      });

      if (validVestings.length === 0) {
        return res.status(400).json({ error: 'No valid vesting pools available' });
      }

      // Get claim history and config
      const claimHistory = await this.dbService.getClaimHistory(userWallet);
      const dbConfig = await this.dbService.getConfig();
      const claimFeeUSD = dbConfig?.claim_fee_usd || 0;
      const TOKEN_DECIMALS = 9;
      const TOKEN_DIVISOR = Math.pow(10, TOKEN_DECIMALS);

      // Calculate available amount per pool
      const poolsWithAvailable = [];
      let totalAvailable = 0;

      for (const vesting of validVestings) {
        const stream = vesting.vesting_streams;
        const totalAllocation = vesting.token_amount;
        const startTime = stream.start_time ? Math.floor(new Date(stream.start_time).getTime() / 1000) : now;
        const vestingDurationSeconds = stream.vesting_duration_seconds || (stream.vesting_duration_days * 86400);
        const cliffDurationSeconds = stream.cliff_duration_seconds || (stream.cliff_duration_days * 86400);
        const endTime = stream.end_time ? Math.floor(new Date(stream.end_time).getTime() / 1000) : now + vestingDurationSeconds;
        const cliffTime = startTime + cliffDurationSeconds;

        // Calculate vested amount (with Streamflow caching)
        let vestedAmount = 0;
        if (stream.streamflow_stream_id) {
          try {
            // Check cache first (30 second TTL)
            const cacheKey = `streamflow:${stream.streamflow_stream_id}`;
            let streamflowVested = cache.get<number>(cacheKey);

            if (streamflowVested === null) {
              streamflowVested = await this.streamflowService.getVestedAmount(stream.streamflow_stream_id);
              cache.set(cacheKey, streamflowVested, 30);
            }

            const poolTotal = stream.total_pool_amount;
            const vestedPercentage = streamflowVested / poolTotal;
            vestedAmount = totalAllocation * vestedPercentage;
          } catch (err) {
            const vestedPercentage = this.calculateVestedPercentage(now, startTime, endTime, cliffTime);
            vestedAmount = totalAllocation * vestedPercentage;
          }
        } else {
          const vestedPercentage = this.calculateVestedPercentage(now, startTime, endTime, cliffTime);
          vestedAmount = totalAllocation * vestedPercentage;
        }

        // Get claims for this vesting
        const vestingClaims = claimHistory.filter(claim => claim.vesting_id === vesting.id);
        const vestingTotalClaimed = vestingClaims.reduce((sum, claim) => sum + Number(claim.amount_claimed), 0) / TOKEN_DIVISOR;

        const available = Math.max(0, vestedAmount - vestingTotalClaimed);
        totalAvailable += available;

        poolsWithAvailable.push({
          vesting,
          stream,
          available,
          vestedAmount,
          totalAllocation,
          vestingTotalClaimed,
        });
      }

      // Round down totalAvailable to 2 decimal places to match what frontend shows
      const roundedTotalAvailable = Math.floor(totalAvailable * 100) / 100;

      // Validate requested amount
      if (amountToClaim > roundedTotalAvailable) {
        return res.status(400).json({
          error: `Requested amount ${amountToClaim.toFixed(2)} exceeds available balance ${roundedTotalAvailable.toFixed(2)}`,
          available: roundedTotalAvailable,
          requested: amountToClaim,
        });
      }

      // Distribute amount across pools using FIFO
      const poolBreakdown = [];
      let remainingToClaim = amountToClaim;

      for (const poolData of poolsWithAvailable) {
        if (remainingToClaim <= 0) break;

        const claimFromThisPool = Math.min(poolData.available, remainingToClaim);
        if (claimFromThisPool > 0) {
          poolBreakdown.push({
            poolId: poolData.vesting.vesting_stream_id,
            poolName: poolData.stream.name,
            amountToClaim: claimFromThisPool,
            availableFromPool: poolData.available,
          });
          remainingToClaim -= claimFromThisPool;
        }
      }

      // Determine Vault Signer, Token Mint, and Fee
      let vaultKeypair: Keypair;
      let tokenMint: PublicKey;
      let feeInSOL = 0;
      let feeWallet: PublicKey | null = null;

      if (req.project) {
        try {
          vaultKeypair = await getVaultKeypairForProject(req.project.id);
          tokenMint = new PublicKey(req.project.mint_address);

          const feeInLamports = Number(req.project.claim_fee_lamports || 1000000);
          feeInSOL = feeInLamports / LAMPORTS_PER_SOL;

          if (req.project.fee_recipient_address) {
            feeWallet = new PublicKey(req.project.fee_recipient_address);
          } else {
            feeWallet = vaultKeypair.publicKey;
          }
        } catch (err) {
          console.error('Failed to get project vault:', err);
          return res.status(500).json({ error: 'Failed to access project vault' });
        }
      } else {
        // Legacy: Parse treasury keypair
        try {
          if (!config.treasuryPrivateKey) {
            throw new Error('Treasury private key not configured');
          }
          if (config.treasuryPrivateKey.startsWith('[')) {
            const secretKey = Uint8Array.from(JSON.parse(config.treasuryPrivateKey));
            vaultKeypair = Keypair.fromSecretKey(secretKey);
          } else {
            try {
              const bs58 = await import('bs58');
              const decoded = bs58.default.decode(config.treasuryPrivateKey);
              vaultKeypair = Keypair.fromSecretKey(decoded);
            } catch {
              const decoded = Buffer.from(config.treasuryPrivateKey, 'base64');
              vaultKeypair = Keypair.fromSecretKey(decoded);
            }
          }
          tokenMint = new PublicKey(config.customTokenMint!);

          // Calculate legacy fee
          if (claimFeeUSD > 0 && dbConfig?.fee_wallet) {
            try {
              const { solAmount } = await this.priceService.calculateSolFee(claimFeeUSD);
              feeInSOL = solAmount;
              feeWallet = new PublicKey(dbConfig.fee_wallet);
            } catch (err) {
              console.warn('Failed to calculate legacy fee:', err);
            }
          }
        } catch (err) {
          console.error('Treasury key parse error:', err);
          return res.status(500).json({ error: 'Invalid treasury key configuration' });
        }
      }

      // Create token transfer transaction
      const userPublicKey = new PublicKey(userWallet);

      const vaultTokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        vaultKeypair.publicKey
      );

      const userTokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        userPublicKey
      );

      // Check if user's token account exists
      let userTokenAccountExists = false;
      try {
        await getAccount(this.connection, userTokenAccount);
        userTokenAccountExists = true;
      } catch (err) {
        // Account doesn't exist, will create it
      }

      // Build transaction with all transfers
      const tokenTransferTx = new Transaction();

      if (!userTokenAccountExists) {
        tokenTransferTx.add(
          createAssociatedTokenAccountInstruction(
            vaultKeypair.publicKey,
            userTokenAccount,
            userPublicKey,
            tokenMint
          )
        );
      }

      // Add transfer instructions for each pool
      // Use precise conversion to avoid floating point errors
      const amountInBaseUnitsFloat = amountToClaim * 1e9;
      const amountInBaseUnits = BigInt(Math.round(amountInBaseUnitsFloat));

      tokenTransferTx.add(
        createTransferInstruction(
          vaultTokenAccount,
          userTokenAccount,
          vaultKeypair.publicKey,
          amountInBaseUnits
        )
      );

      // Add SOL fee transfer if fee is set and fee wallet is configured
      if (feeInSOL > 0 && feeWallet) {
        try {
          const feeInLamports = Math.floor(feeInSOL * LAMPORTS_PER_SOL);

          if (feeInLamports > 0) {
            // Add SOL transfer from user to fee wallet
            tokenTransferTx.add(
              SystemProgram.transfer({
                fromPubkey: userPublicKey,
                toPubkey: feeWallet,
                lamports: feeInLamports,
              })
            );
            console.log(`[PREPARE-CLAIM] Added SOL fee transfer: ${feeInSOL} SOL from user to fee wallet`);
          }
        } catch (feeErr) {
          console.warn('[PREPARE-CLAIM] Could not add SOL fee transfer:', feeErr);
        }
      }

      // Get recent blockhash and prepare transaction
      const { blockhash } = await this.connection.getLatestBlockhash();
      tokenTransferTx.recentBlockhash = blockhash;
      // User pays network fees (tiny ~0.00001 SOL) + claim fee
      tokenTransferTx.feePayer = userPublicKey;

      // Partially sign with vault (for token transfer authority)
      tokenTransferTx.partialSign(vaultKeypair);

      // Convert transaction to base64 for transmission
      const transactionBuffer = tokenTransferTx.serialize({
        requireAllSignatures: false,
      });
      const transactionBase64 = transactionBuffer.toString('base64');

      res.json({
        success: true,
        data: {
          transaction: transactionBase64,
          amountToClaim,
          poolBreakdown,
          feeInSOL,
          claimFeeUSD,
          userWallet,
        },
      });
    } catch (error) {
      console.error('Failed to prepare claim transaction:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/user/vesting/submit-claim
   * Submit signed transaction to complete the claim
   */
  async submitSignedClaim(req: Request, res: Response) {
    try {
      const { userWallet, transactionBase64, poolBreakdown, amountToClaim, claimFeeUSD, feeInSOL } = req.body;

      if (!userWallet || !transactionBase64) {
        return res.status(400).json({ error: 'userWallet and transactionBase64 are required' });
      }

      if (!poolBreakdown || !Array.isArray(poolBreakdown)) {
        return res.status(400).json({ error: 'poolBreakdown array is required' });
      }

      // Deserialize the signed transaction
      const transactionBuffer = Buffer.from(transactionBase64, 'base64');
      const transaction = Transaction.from(transactionBuffer);

      // Send the signed transaction
      console.log('[SUBMIT-CLAIM] Sending signed transaction...');

      let tokenSignature: string | null = null;
      const maxRetries = 3;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          console.log(`[SUBMIT-CLAIM] Sending transaction (attempt ${attempt}/${maxRetries})...`);

          tokenSignature = await this.connection.sendRawTransaction(transaction.serialize());

          console.log(`[SUBMIT-CLAIM] Transaction sent: ${tokenSignature}, confirming...`);

          try {
            // Use 30 second timeout for confirmation
            const latestBlockhash = await this.connection.getLatestBlockhash();
            await Promise.race([
              this.connection.confirmTransaction(
                {
                  signature: tokenSignature,
                  blockhash: latestBlockhash.blockhash,
                  lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
                },
                'confirmed'
              ),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Transaction confirmation timeout')), 30000)
              ),
            ]);

            console.log('[SUBMIT-CLAIM] Transfer confirmed successfully! Signature:', tokenSignature);
            break;
          } catch (confirmError) {
            console.warn(`[SUBMIT-CLAIM] Confirmation timed out, checking transaction status: ${tokenSignature}`);

            // Check if transaction was actually successful despite timeout
            try {
              const status = await this.connection.getSignatureStatus(tokenSignature);
              if (status && status.value && !status.value.err) {
                console.log('[SUBMIT-CLAIM] Transaction successful despite confirmation timeout! Signature:', tokenSignature);
                break;
              } else if (status && status.value && status.value.err) {
                throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.value.err)}`);
              }
              throw confirmError;
            } catch (statusError) {
              console.error('[SUBMIT-CLAIM] Error checking transaction status:', statusError);
              throw confirmError;
            }
          }
        } catch (err) {
          console.error(`[SUBMIT-CLAIM] Transaction attempt ${attempt} failed:`, err);

          if (attempt === maxRetries) {
            throw new Error(`Transaction failed after ${maxRetries} attempts`);
          }

          const waitTime = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }

      if (!tokenSignature) {
        throw new Error('Failed to send transaction');
      }

      // Record claims in database for each pool that had an amount claimed
      const TOKEN_DECIMALS = 9;
      const totalClaimAmount = poolBreakdown.reduce((sum: number, p: any) => sum + p.amountToClaim, 0);

      try {
        for (const poolBreakdownItem of poolBreakdown) {
          if (poolBreakdownItem.amountToClaim > 0) {
            // Use Decimal.js for precise conversion
            const amountInBaseUnits = Number(this.toBaseUnits(poolBreakdownItem.amountToClaim, TOKEN_DECIMALS));
            // Calculate proportional fee for this pool
            // Prefer feeInSOL (native) over claimFeeUSD (legacy/display)
            const totalFee = feeInSOL !== undefined ? feeInSOL : (claimFeeUSD || 0);
            const proportionalFee = (poolBreakdownItem.amountToClaim / totalClaimAmount) * totalFee;

            // Ensure amount is positive before recording
            if (amountInBaseUnits > 0) {
              // Get vesting ID from poolBreakdownItem (need to fetch from DB)
              const { data: vestingData, error: vestingError } = await this.dbService.supabase
                .from('vestings')
                .select('id')
                .eq('vesting_stream_id', poolBreakdownItem.poolId)
                .eq('user_wallet', userWallet)
                .eq('is_active', true)
                .single();

              if (vestingError || !vestingData) {
                console.warn(`[SUBMIT-CLAIM] Could not find vesting for pool ${poolBreakdownItem.poolId}:`, vestingError);
                continue;
              }

              await this.dbService.createClaim({
                user_wallet: userWallet,
                vesting_id: vestingData.id,
                amount_claimed: amountInBaseUnits,
                fee_paid: proportionalFee,
                transaction_signature: tokenSignature,
              });

              console.log(`[SUBMIT-CLAIM] Recorded claim for pool ${poolBreakdownItem.poolName}: ${poolBreakdownItem.amountToClaim} tokens, fee: ${proportionalFee} USD`);
            }
          }
        }
      } catch (dbError) {
        console.error('[SUBMIT-CLAIM] Error recording claims in database:', dbError);
        // Don't fail the entire response if database recording fails
        // The transaction is already on-chain, so we should still return success
      }

      res.json({
        success: true,
        data: {
          transactionSignature: tokenSignature,
          status: 'success',
          claimsRecorded: poolBreakdown.length,
        },
      });
    } catch (error) {
      console.error('Failed to submit signed claim:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/user/vesting/claim-status/:signature
   * Check the status of a claim transaction
   */
  async getClaimStatus(req: Request, res: Response) {
    try {
      const { signature } = req.params;

      if (!signature) {
        return res.status(400).json({ error: 'Transaction signature is required' });
      }

      console.log(`[CLAIM-STATUS] Checking status for signature: ${signature}`);

      // Check transaction status on Solana
      const status = await this.connection.getSignatureStatus(signature);

      if (!status || !status.value) {
        return res.json({
          success: true,
          status: 'pending',
          message: 'Transaction not yet confirmed',
          signature,
        });
      }

      if (status.value.err) {
        return res.json({
          success: true,
          status: 'failed',
          message: 'Transaction failed on-chain',
          error: JSON.stringify(status.value.err),
          signature,
        });
      }

      // Transaction succeeded - check if it's recorded in database
      const { data: claims, error: dbError } = await this.dbService.supabase
        .from('claim_history')
        .select('*')
        .eq('transaction_signature', signature)
        .limit(1);

      const isRecorded = claims && claims.length > 0;

      return res.json({
        success: true,
        status: 'confirmed',
        message: 'Transaction confirmed on-chain',
        signature,
        confirmations: status.value.confirmations || 0,
        slot: status.value.slot,
        recordedInDatabase: isRecorded,
      });
    } catch (error) {
      console.error('[CLAIM-STATUS] Error checking transaction status:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Helper: Convert token amount to base units with precision
   * Uses Decimal.js to avoid floating point errors
   */
  private toBaseUnits(amount: number, decimals: number = 9): bigint {
    const decimal = new Decimal(amount);
    const multiplier = new Decimal(10).pow(decimals);
    const baseUnits = decimal.times(multiplier).toFixed(0);
    return BigInt(baseUnits);
  }

  /**
   * Helper: Convert base units to token amount with precision
   */
  private fromBaseUnits(baseUnits: number | bigint, decimals: number = 9): number {
    const decimal = new Decimal(baseUnits.toString());
    const divisor = new Decimal(10).pow(decimals);
    return decimal.dividedBy(divisor).toNumber();
  }

  /**
   * Helper: Calculate vested percentage based on time
   */
  private calculateVestedPercentage(now: number, startTime: number, endTime: number, cliffTime: number): number {
    if (now < cliffTime) {
      return 0;
    } else if (now >= endTime) {
      return 1;
    } else {
      const timeElapsed = now - cliffTime;
      const totalVestingTime = endTime - cliffTime;
      return timeElapsed / totalVestingTime;
    }
  }
}
