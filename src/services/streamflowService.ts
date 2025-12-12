import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { GenericStreamClient, ICluster, IChain, getBN, getNumberFromBN } from '@streamflow/stream';
import { config } from '../config';

/**
 * Streamflow Integration Service
 * Creates and manages vesting pools on-chain using Streamflow Protocol
 */
export class StreamflowService {
  private client: GenericStreamClient<IChain.Solana>;
  private connection: Connection;

  constructor() {
    this.connection = new Connection(config.rpcEndpoint, 'confirmed');
    this.client = new GenericStreamClient<IChain.Solana>({
      chain: IChain.Solana,
      clusterUrl: config.rpcEndpoint,
      cluster: ICluster.Mainnet,
      commitment: 'confirmed',
    });
  }

  /**
   * Create a vesting pool (stream) on Streamflow
   * Admin is the recipient, tokens vest over time, admin distributes to users
   */
  async createVestingPool(params: {
    adminKeypair: Keypair;
    tokenMint: PublicKey;
    totalAmount: number;
    startTime: number;
    endTime: number;
    cliffTime?: number;
    cliffPercentage?: number; // Optional: percentage to unlock at cliff (0-100)
    poolName: string;
    tokenDecimals?: number; // Optional: token decimals (default 9 for SPL tokens)
  }): Promise<{ streamId: string; signature: string }> {
    const {
      adminKeypair,
      tokenMint,
      totalAmount,
      startTime,
      endTime,
      cliffTime,
      cliffPercentage = 0,
      poolName,
      tokenDecimals = 9 // Default to 9 for Solana SPL tokens
    } = params;

    try {
      console.log('Creating Streamflow pool...');
      console.log('Admin:', adminKeypair.publicKey.toBase58());
      console.log('Token Mint:', tokenMint.toBase58());
      console.log('Amount:', totalAmount);
      console.log('Duration:', startTime, '->', endTime);
      console.log('Cliff:', cliffTime || 'None (starts at start time)');

      // Create stream where admin is BOTH sender and recipient
      // This allows admin to withdraw vested tokens and distribute them
      const duration = endTime - startTime;

      // Use 60-second periods for smoother vesting (fixes period=1 issue)
      // This means tokens vest every minute rather than every second
      const periodSeconds = 60;
      const numberOfPeriods = Math.max(1, Math.floor(duration / periodSeconds));

      // Calculate cliff amount if cliff percentage is set
      const effectiveCliff = cliffTime || startTime;
      const cliffAmount = cliffPercentage > 0
        ? Math.floor(totalAmount * (cliffPercentage / 100))
        : 0;

      // CRITICAL: Streamflow validation requires: amount = (amountPerPeriod * numberOfPeriods) + cliffAmount
      // We must calculate amountPerPeriod to satisfy this equation exactly
      const vestingAmount = totalAmount - cliffAmount; // Amount that vests over time (excluding cliff)
      const amountPerPeriod = Math.floor(vestingAmount / numberOfPeriods);
      
      // Recalculate total to match Streamflow's expectation (handles rounding)
      const adjustedTotal = (amountPerPeriod * numberOfPeriods) + cliffAmount;

      console.log('Duration:', duration, 'seconds');
      console.log('Period:', periodSeconds, 'seconds');
      console.log('Number of periods:', numberOfPeriods);
      console.log('Cliff amount:', cliffAmount, `(${cliffPercentage}%)`);
      console.log('Vesting amount:', vestingAmount, '(total - cliff)');
      console.log('Amount per period:', amountPerPeriod);
      console.log('Adjusted total:', adjustedTotal, '(to match Streamflow validation)');
      
      if (adjustedTotal !== totalAmount) {
        console.warn(`⚠️  Total adjusted from ${totalAmount} to ${adjustedTotal} due to rounding (diff: ${totalAmount - adjustedTotal})`);
      }

      const createStreamParams = {
        recipient: adminKeypair.publicKey.toBase58(), // Admin receives the vested tokens
        tokenId: tokenMint.toBase58(),
        start: startTime,
        amount: getBN(adjustedTotal, tokenDecimals), // Use adjusted total that satisfies Streamflow equation
        period: periodSeconds, // Vesting updates every 60 seconds (improved from 1)
        cliff: effectiveCliff, // Cliff time (defaults to start if none)
        cliffAmount: getBN(cliffAmount, tokenDecimals), // Unlock this amount at cliff
        amountPerPeriod: getBN(amountPerPeriod, tokenDecimals),
        name: poolName,
        canTopup: false,
        cancelableBySender: true,
        cancelableByRecipient: false,
        transferableBySender: false,
        transferableByRecipient: false,
        automaticWithdrawal: false,
        withdrawalFrequency: 0,
        partner: undefined,
      };

      const createResult = await this.client.create(
        createStreamParams,
        { sender: adminKeypair }
      );

      console.log('Stream created! Result:', createResult);

      return {
        streamId: createResult.metadataId,
        signature: createResult.txId,
      };
    } catch (error) {
      console.error('Failed to create Streamflow pool:', error);
      throw error;
    }
  }

  /**
   * Withdraw vested tokens from a Streamflow pool
   */
  async withdrawFromPool(streamId: string, adminKeypair: Keypair, amount?: number): Promise<{ signature: string }> {
    try {
      console.log('Withdrawing from Streamflow pool:', streamId);

      const withdrawResult = await this.client.withdraw(
        { id: streamId, amount: amount ? getBN(amount, 9) : undefined },
        { invoker: adminKeypair }
      );

      console.log('Withdrawal successful! Signature:', withdrawResult.txId);

      return {
        signature: withdrawResult.txId,
      };
    } catch (error) {
      console.error('Failed to withdraw from Streamflow pool:', error);
      throw error;
    }
  }

  /**
   * Cancel a Streamflow vesting pool and reclaim rent
   * For completed streams, withdraws all tokens first, then cancels
   */
  async cancelVestingPool(streamId: string, adminKeypair: Keypair): Promise<{ signature: string; withdrew?: boolean }> {
    try {
      console.log('Canceling Streamflow pool:', streamId);

      // Try to get stream info to check if it's completed
      let withdrew = false;
      try {
        const stream = await this.client.getOne({ id: streamId });
        if (stream) {
          const now = Math.floor(Date.now() / 1000);
          const end = Number(stream.end);
          const withdrawnAmount = getNumberFromBN(stream.withdrawnAmount, 9);
          const depositedAmount = getNumberFromBN(stream.depositedAmount, 9);
          const remainingAmount = depositedAmount - withdrawnAmount;

          // If stream is completed and has remaining tokens, withdraw first
          if (now >= end && remainingAmount > 0) {
            console.log(`Stream is completed with ${remainingAmount} tokens remaining, withdrawing first...`);
            try {
              await this.withdrawFromPool(streamId, adminKeypair);
              withdrew = true;
            } catch (withdrawErr: any) {
              // If withdrawal fails due to AccountNotInitialized, tokens are already withdrawn
              if (withdrawErr.message?.includes('AccountNotInitialized') || withdrawErr.message?.includes('3012')) {
                console.log('Tokens already withdrawn, proceeding with cancellation...');
              } else {
                throw withdrawErr;
              }
            }
          } else if (now >= end) {
            console.log('Stream is completed and all tokens already withdrawn');
          }
        }
      } catch (err: any) {
        console.log('Could not check stream status, proceeding with cancel:', err.message || err);
      }

      const cancelResult = await this.client.cancel(
        { id: streamId },
        { invoker: adminKeypair }
      );

      console.log('Stream canceled! Signature:', cancelResult.txId);
      console.log('Rent and unvested tokens returned to sender');

      return {
        signature: cancelResult.txId,
        withdrew,
      };
    } catch (error: any) {
      // If cancellation fails due to AccountNotInitialized, stream is already closed
      if (error.message?.includes('AccountNotInitialized') || error.message?.includes('3012')) {
        console.log('Stream is already closed - rent was already reclaimed');
        return {
          signature: 'already_closed',
          withdrew: false,
        };
      }
      console.error('Failed to cancel Streamflow pool:', error);
      throw error;
    }
  }

  /**
   * Get vested amount from pool at current time
   */
  async getVestedAmount(streamId: string): Promise<number> {
    try {
      const stream = await this.client.getOne({ id: streamId });

      if (!stream) {
        throw new Error('Stream not found');
      }

      // Calculate vested amount based on current time
      const now = Math.floor(Date.now() / 1000);
      const start = Number(stream.start);
      const end = Number(stream.end);
      const depositedAmount = getNumberFromBN(stream.depositedAmount, 9);

      if (now < start) {
        return 0; // Vesting hasn't started
      }

      if (now >= end) {
        return depositedAmount; // Fully vested
      }

      // Linear vesting calculation
      const elapsed = now - start;
      const duration = end - start;
      const vestedAmount = (depositedAmount * elapsed) / duration;

      return Math.floor(vestedAmount);
    } catch (error) {
      console.error('Failed to get vested amount:', error);
      throw error;
    }
  }


  /**
   * Get pool status
   */
  async getPoolStatus(streamId: string) {
    try {
      const stream = await this.client.getOne({ id: streamId });

      if (!stream) {
        throw new Error('Stream not found');
      }

      const depositedAmount = getNumberFromBN(stream.depositedAmount, 9);
      const withdrawnAmount = getNumberFromBN(stream.withdrawnAmount, 9);
      const remainingAmount = depositedAmount - withdrawnAmount;

      return {
        streamId: streamId,
        depositedAmount,
        withdrawnAmount,
        remainingAmount,
        start: Number(stream.start),
        end: Number(stream.end),
        cliff: Number(stream.cliff),
        recipient: stream.recipient,
        mint: stream.mint,
      };
    } catch (error) {
      console.error('Failed to get pool status:', error);
      throw error;
    }
  }

  /**
   * Cancel and close the pool (emergency only)
   */
  async cancelPool(streamId: string, adminKeypair: Keypair): Promise<string> {
    try {
      const cancelResult = await this.client.cancel(
        { id: streamId },
        { invoker: adminKeypair }
      );

      console.log('Pool cancelled! Signature:', cancelResult.txId);
      return cancelResult.txId;
    } catch (error) {
      console.error('Failed to cancel pool:', error);
      throw error;
    }
  }
}
