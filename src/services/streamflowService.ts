import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { GenericStreamClient, ICluster, IChain, getBN, getNumberFromBN } from '@streamflow/stream';
import { config } from '../config';
import { getRPCConfig } from '../config';

/**
 * Streamflow Integration Service
 * Creates and manages vesting pools on-chain using Streamflow Protocol
 */
export class StreamflowService {
  private client: GenericStreamClient<IChain.Solana>;
  private connection: Connection;

  constructor() {
    this.connection = new Connection(getRPCConfig().getRPCEndpoint(), 'confirmed');
    this.client = new GenericStreamClient<IChain.Solana>({
      chain: IChain.Solana,
      clusterUrl: getRPCConfig().getRPCEndpoint(),
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

      // CRITICAL FIX: Ensure Associated Token Account exists before Streamflow creates the pool
      // This prevents "insufficient rent" errors by ensuring all required accounts are initialized
      const { getOrCreateAssociatedTokenAccount } = await import('@solana/spl-token');
      
      // CRITICAL FIX: Handle Native SOL (wSOL) differently from SPL tokens
      const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';
      const isNativeSOL = tokenMint.toBase58() === NATIVE_SOL_MINT;

      console.log(`[STREAMFLOW] Token type: ${isNativeSOL ? 'Native SOL (wSOL)' : 'SPL Token'}`);

      if (isNativeSOL) {
        // For Native SOL: Check main wallet balance, not wSOL ATA
        const solBalance = await this.connection.getBalance(adminKeypair.publicKey);
        const solBalanceSOL = solBalance / 1e9;
        
        // Required: Pool amount + 0.5% Streamflow fee + wrapping/rent fees
        // Note: totalAmount is the RAW pool amount (not yet including Streamflow fee)
        const poolWithStreamflowFee = totalAmount * 1.005; // Add 0.5% for Streamflow
        const wrapAndRentFees = 0.02; // Wrapping tx + account rent + buffer
        const requiredSOL = poolWithStreamflowFee + wrapAndRentFees;
        
        console.log(`[STREAMFLOW] Native SOL balance: ${solBalanceSOL.toFixed(4)} SOL`);
        console.log(`[STREAMFLOW] Pool amount: ${totalAmount} SOL`);
        console.log(`[STREAMFLOW] Pool + Streamflow fee (0.5%): ${poolWithStreamflowFee.toFixed(4)} SOL`);
        console.log(`[STREAMFLOW] Wrap/rent fees: ${wrapAndRentFees.toFixed(4)} SOL`);
        console.log(`[STREAMFLOW] Total required: ${requiredSOL.toFixed(4)} SOL`);
        
        if (solBalanceSOL < requiredSOL) {
          throw new Error(
            `Treasury has insufficient SOL. Required: ${requiredSOL.toFixed(4)} SOL, ` +
            `Available: ${solBalanceSOL.toFixed(4)} SOL. ` +
            `Please fund the treasury before deploying.`
          );
        }

        // CRITICAL: Streamflow SDK expects wSOL tokens in the ATA, not native SOL balance
        // We must wrap SOL into wSOL ATA before calling Streamflow
        console.log('[STREAMFLOW] Native SOL detected - wrapping SOL into wSOL ATA...');
        
        const { 
          getAssociatedTokenAddress, 
          createAssociatedTokenAccountInstruction,
          createSyncNativeInstruction,
          TOKEN_PROGRAM_ID,
          NATIVE_MINT
        } = await import('@solana/spl-token');
        const { SystemProgram, Transaction, sendAndConfirmTransaction } = await import('@solana/web3.js');
        
        // Get wSOL ATA address
        const wsolATA = await getAssociatedTokenAddress(
          NATIVE_MINT,
          adminKeypair.publicKey
        );
        
        console.log(`[STREAMFLOW] wSOL ATA address: ${wsolATA.toBase58()}`);
        
        // Check if ATA exists
        const ataInfo = await this.connection.getAccountInfo(wsolATA);
        
        // Build transaction to wrap SOL
        const wrapTransaction = new Transaction();
        
        // Step 1: Create ATA if it doesn't exist
        if (!ataInfo) {
          console.log('[STREAMFLOW] Creating wSOL ATA...');
          wrapTransaction.add(
            createAssociatedTokenAccountInstruction(
              adminKeypair.publicKey,  // payer
              wsolATA,                 // associated token account
              adminKeypair.publicKey,  // owner
              NATIVE_MINT              // mint
            )
          );
        } else {
          console.log('[STREAMFLOW] wSOL ATA already exists');
        }
        
        // Step 2: Transfer SOL to wSOL ATA (this wraps it)
        // CRITICAL: Streamflow Create instruction deducts fees from the wrapped amount
        // So we need to wrap: poolAmount + Streamflow fees
        // Streamflow fee: ~0.0005 SOL (taken from wrapped amount)
        // We wrap the exact pool amount - Streamflow will handle the fee internally
        const lamportsToWrap = Math.floor(totalAmount * 1e9); // Wrap exact pool amount
        console.log(`[STREAMFLOW] Transferring ${lamportsToWrap} lamports (${totalAmount} SOL) to wSOL ATA...`);
        console.log(`[STREAMFLOW] Note: Streamflow will deduct its fee (~0.0005 SOL) from the wrapped amount`);
        
        wrapTransaction.add(
          SystemProgram.transfer({
            fromPubkey: adminKeypair.publicKey,
            toPubkey: wsolATA,
            lamports: lamportsToWrap,
          })
        );
        
        // Step 3: Sync native (updates wSOL balance)
        wrapTransaction.add(
          createSyncNativeInstruction(wsolATA)
        );
        
        // Send wrapping transaction
        console.log('[STREAMFLOW] Sending wrapping transaction...');
        const wrapSignature = await sendAndConfirmTransaction(
          this.connection,
          wrapTransaction,
          [adminKeypair],
          { commitment: 'confirmed' }
        );
        
        console.log(`[STREAMFLOW] ✅ SOL wrapped successfully. Signature: ${wrapSignature}`);
        
        // Verify wSOL balance
        const wrappedAta = await getOrCreateAssociatedTokenAccount(
          this.connection,
          adminKeypair,
          NATIVE_MINT,
          adminKeypair.publicKey
        );
        const wrappedBalance = Number(wrappedAta.amount) / 1e9;
        console.log(`[STREAMFLOW] wSOL ATA balance after wrapping: ${wrappedBalance.toFixed(4)} SOL`);
        
        if (wrappedBalance < totalAmount) {
          throw new Error(
            `Failed to wrap sufficient SOL. Expected: ${totalAmount} SOL, Got: ${wrappedBalance.toFixed(4)} SOL`
          );
        }
        
        console.log(`[STREAMFLOW] ✅ Wrapped ${wrappedBalance.toFixed(4)} SOL successfully`);
      } else {
        // For SPL Tokens: Check ATA balance
        console.log('[STREAMFLOW] Ensuring sender ATA exists...');
        const senderAta = await getOrCreateAssociatedTokenAccount(
          this.connection,
          adminKeypair,
          tokenMint,
          adminKeypair.publicKey
        );
        console.log(`[STREAMFLOW] Sender ATA: ${senderAta.address.toBase58()}`);

        const tokenBalance = Number(senderAta.amount) / Math.pow(10, tokenDecimals);
        const requiredAmount = totalAmount * 1.005; // Including 0.5% buffer for fees
        
        console.log(`[STREAMFLOW] Token balance: ${tokenBalance}, Required: ${requiredAmount}`);
        
        if (tokenBalance < requiredAmount) {
          throw new Error(
            `Insufficient token balance. Required: ${requiredAmount}, Available: ${tokenBalance}`
          );
        }

        // Check SOL balance for rent (separate from token balance)
        const solBalance = await this.connection.getBalance(adminKeypair.publicKey);
        const solBalanceSOL = solBalance / 1e9;
        console.log(`[STREAMFLOW] SOL balance for rent: ${solBalanceSOL.toFixed(4)} SOL`);
        
        if (solBalanceSOL < 0.15) {
          throw new Error(
            `Insufficient SOL for Streamflow deployment. Required: ~0.15 SOL (0.117 service fee + 0.015 network fees), Available: ${solBalanceSOL.toFixed(4)} SOL. See: https://docs.streamflow.finance/streamflow/fees`
          );
        }
      }

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

      // Convert to raw units (BN) first
      const totalAmountBN = getBN(totalAmount, tokenDecimals);
      const cliffAmountBN = getBN(cliffAmount, tokenDecimals);
      const vestingAmountBN = totalAmountBN.sub(cliffAmountBN);

      // Calculate amount per period in raw units
      const numberOfPeriodsBN = new BN(numberOfPeriods);
      const amountPerPeriodBN = vestingAmountBN.div(numberOfPeriodsBN);

      // Recalculate total to match Streamflow's expectation (handles rounding)
      const adjustedTotalBN = amountPerPeriodBN.mul(numberOfPeriodsBN).add(cliffAmountBN);

      // Convert back to number for logging (approximate)
      const adjustedTotal = getNumberFromBN(adjustedTotalBN, tokenDecimals);

      console.log('Duration:', duration, 'seconds');
      console.log('Period:', periodSeconds, 'seconds');
      console.log('Number of periods:', numberOfPeriods);
      console.log('Cliff amount:', cliffAmount, `(${cliffPercentage}%)`);
      console.log('Vesting amount:', getNumberFromBN(vestingAmountBN, tokenDecimals), '(total - cliff)');
      console.log('Amount per period (BN):', amountPerPeriodBN.toString());
      console.log('Adjusted total:', adjustedTotal, '(to match Streamflow validation)');

      if (adjustedTotal !== totalAmount) {
        console.warn(`⚠️  Total adjusted from ${totalAmount} to ${adjustedTotal} due to rounding (diff: ${totalAmount - adjustedTotal})`);
      }

      const createStreamParams = {
        recipient: adminKeypair.publicKey.toBase58(), // Admin receives the vested tokens
        tokenId: tokenMint.toBase58(),
        start: startTime,
        amount: adjustedTotalBN, // Use adjusted total that satisfies Streamflow equation
        period: periodSeconds, // Vesting updates every 60 seconds (improved from 1)
        cliff: effectiveCliff, // Cliff time (defaults to start if none)
        cliffAmount: cliffAmountBN, // Unlock this amount at cliff
        amountPerPeriod: amountPerPeriodBN,
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

      console.log('[STREAMFLOW] Creating stream with params:', {
        recipient: createStreamParams.recipient,
        tokenId: createStreamParams.tokenId,
        start: new Date(startTime * 1000).toISOString(),
        amount: adjustedTotal,
        period: periodSeconds,
        cliff: effectiveCliff ? new Date(effectiveCliff * 1000).toISOString() : 'None'
      });

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
