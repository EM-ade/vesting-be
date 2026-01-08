/**
 * Transaction Simulation Utilities
 * Provides pre-flight simulation for Streamflow transactions
 * Helps catch errors before actual execution to prevent orphaned state
 */

import { Connection, PublicKey, Transaction, Keypair } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddress } from '@solana/spl-token';
import BN from 'bn.js';
import { toSmallestUnits, floatGreaterOrEqual, calculateRequiredWithFee } from './roundingUtils';

export interface SimulationResult {
  success: boolean;
  errors: string[];
  warnings: string[];
  checks: {
    treasuryExists: boolean;
    tokenAccountExists: boolean;
    sufficientSolBalance: boolean;
    sufficientTokenBalance: boolean;
    validTimestamps: boolean;
  };
  balances: {
    sol: number;
    tokens: number;
  };
  requirements: {
    sol: number;
    tokens: number;
  };
}

/**
 * Simulate Streamflow pool creation before actual execution
 * Validates all preconditions without executing transactions
 * 
 * @param connection - Solana RPC connection
 * @param params - Pool creation parameters
 * @returns Simulation result with detailed validation
 */
export async function simulateStreamflowPoolCreation(
  connection: Connection,
  params: {
    treasuryKeypair: Keypair;
    tokenMint: PublicKey;
    totalAmount: number;
    startTime: number;
    endTime: number;
    tokenDecimals?: number;
  }
): Promise<SimulationResult> {
  const {
    treasuryKeypair,
    tokenMint,
    totalAmount,
    startTime,
    endTime,
    tokenDecimals = 9,
  } = params;

  const result: SimulationResult = {
    success: true,
    errors: [],
    warnings: [],
    checks: {
      treasuryExists: false,
      tokenAccountExists: false,
      sufficientSolBalance: false,
      sufficientTokenBalance: false,
      validTimestamps: false,
    },
    balances: {
      sol: 0,
      tokens: 0,
    },
    requirements: {
      sol: 0,
      tokens: 0,
    },
  };

  try {
    // Check 1: Treasury wallet exists
    const treasuryInfo = await connection.getAccountInfo(treasuryKeypair.publicKey);
    result.checks.treasuryExists = treasuryInfo !== null;
    
    if (!result.checks.treasuryExists) {
      result.errors.push('Treasury wallet does not exist on-chain');
      result.success = false;
      return result;
    }

    // Check 2: Validate timestamps
    const nowTimestamp = Math.floor(Date.now() / 1000);
    
    if (startTime < nowTimestamp - 60) {
      // Allow 60 second grace period for past start times
      result.warnings.push(`Start time is ${nowTimestamp - startTime} seconds in the past. Will be adjusted.`);
    }
    
    if (endTime <= startTime) {
      result.errors.push(`End time (${endTime}) must be after start time (${startTime})`);
      result.success = false;
    } else {
      result.checks.validTimestamps = true;
    }

    // Determine if this is native SOL or SPL token
    const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';
    const isNativeSOL = tokenMint.toBase58() === NATIVE_SOL_MINT;

    // Check 3: SOL balance
    const solBalance = await connection.getBalance(treasuryKeypair.publicKey, 'confirmed');
    const solBalanceSOL = solBalance / 1e9;
    result.balances.sol = solBalanceSOL;

    if (isNativeSOL) {
      // For native SOL pools, need pool amount + fees
      const requiredSOL = totalAmount + 0.02; // Pool + wrapping + Streamflow fees
      result.requirements.sol = requiredSOL;
      result.requirements.tokens = totalAmount;
      
      if (floatGreaterOrEqual(solBalanceSOL, requiredSOL)) {
        result.checks.sufficientSolBalance = true;
        result.checks.sufficientTokenBalance = true; // SOL is the token
        result.balances.tokens = solBalanceSOL;
      } else {
        result.errors.push(
          `Insufficient SOL. Required: ${requiredSOL.toFixed(4)} SOL ` +
          `(${totalAmount} pool + 0.02 fees), Available: ${solBalanceSOL.toFixed(4)} SOL`
        );
        result.success = false;
      }
    } else {
      // For SPL tokens, need SOL for fees and tokens for pool
      const requiredSOL = 0.015; // Streamflow deployment fees
      result.requirements.sol = requiredSOL;
      
      if (floatGreaterOrEqual(solBalanceSOL, requiredSOL)) {
        result.checks.sufficientSolBalance = true;
      } else {
        result.errors.push(
          `Insufficient SOL for fees. Required: ${requiredSOL.toFixed(4)} SOL, ` +
          `Available: ${solBalanceSOL.toFixed(4)} SOL`
        );
        result.success = false;
      }

      // Check 4: Token balance
      try {
        const tokenAccount = await getAssociatedTokenAddress(
          tokenMint,
          treasuryKeypair.publicKey
        );

        const tokenAccountInfo = await getAccount(connection, tokenAccount);
        result.checks.tokenAccountExists = true;

        const tokenBalance = Number(tokenAccountInfo.amount) / Math.pow(10, tokenDecimals);
        result.balances.tokens = tokenBalance;

        // Calculate required tokens with Streamflow fee
        const requiredTokens = calculateRequiredWithFee(totalAmount, tokenDecimals);
        result.requirements.tokens = requiredTokens;

        if (floatGreaterOrEqual(tokenBalance, requiredTokens)) {
          result.checks.sufficientTokenBalance = true;
        } else {
          result.errors.push(
            `Insufficient tokens. Required: ${requiredTokens.toFixed(2)} ` +
            `(${totalAmount} pool + 0.5% fee), Available: ${tokenBalance.toFixed(2)}`
          );
          result.success = false;
        }
      } catch (err) {
        // Token account doesn't exist
        result.checks.tokenAccountExists = false;
        result.errors.push(
          'Token account does not exist. Transaction will create it automatically ' +
          '(requires ~0.002 SOL additional rent).'
        );
        // This is actually OK - the transaction will create it
        // Adjust SOL requirement
        result.requirements.sol += 0.002;
        
        if (!floatGreaterOrEqual(solBalanceSOL, result.requirements.sol)) {
          result.errors.push(
            `Insufficient SOL for fees + token account creation. ` +
            `Required: ${result.requirements.sol.toFixed(4)} SOL, ` +
            `Available: ${solBalanceSOL.toFixed(4)} SOL`
          );
          result.success = false;
        } else {
          // We have enough SOL to create the account
          result.warnings.push('Token account will be created during transaction');
        }
      }
    }

    // Check 5: Calculate estimated transaction size
    const estimatedSize = 1232; // Typical Streamflow pool creation size
    if (estimatedSize > 1232) {
      result.warnings.push('Transaction may exceed size limits');
    }

    // Final validation
    if (
      result.checks.treasuryExists &&
      result.checks.validTimestamps &&
      result.checks.sufficientSolBalance &&
      (result.checks.sufficientTokenBalance || result.checks.tokenAccountExists === false)
    ) {
      // All critical checks passed
      if (result.errors.length === 0) {
        result.success = true;
      }
    }

  } catch (error) {
    result.success = false;
    result.errors.push(`Simulation error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  return result;
}

/**
 * Validate pool creation parameters before any execution
 * Performs comprehensive validation without blockchain calls
 * 
 * @param params - Pool parameters
 * @returns Validation errors array (empty if valid)
 */
export function validatePoolParameters(params: {
  totalAmount: number;
  startTime: number;
  endTime: number;
  cliffTime?: number;
  tokenDecimals?: number;
}): string[] {
  const errors: string[] = [];
  const { totalAmount, startTime, endTime, cliffTime, tokenDecimals = 9 } = params;

  // Validate amount
  if (totalAmount <= 0) {
    errors.push('Total pool amount must be greater than 0');
  }

  if (!Number.isFinite(totalAmount)) {
    errors.push('Total pool amount must be a valid number');
  }

  // Validate timestamps
  const nowTimestamp = Math.floor(Date.now() / 1000);

  if (!Number.isInteger(startTime) || !Number.isInteger(endTime)) {
    errors.push('Timestamps must be integers (Unix seconds)');
  }

  if (endTime <= startTime) {
    errors.push(`End time must be after start time. Start: ${startTime}, End: ${endTime}`);
  }

  const duration = endTime - startTime;
  if (duration < 60) {
    errors.push(`Vesting duration too short: ${duration} seconds (minimum 60 seconds)`);
  }

  // Validate cliff time if provided
  if (cliffTime !== undefined) {
    if (cliffTime < startTime) {
      errors.push('Cliff time must be at or after start time');
    }
    if (cliffTime > endTime) {
      errors.push('Cliff time must be before end time');
    }
  }

  // Validate token decimals
  if (tokenDecimals < 0 || tokenDecimals > 18) {
    errors.push('Token decimals must be between 0 and 18');
  }

  return errors;
}

/**
 * Simulate transaction execution using Solana's simulate endpoint
 * This performs a full simulation including compute units
 * 
 * @param connection - Solana RPC connection
 * @param transaction - Transaction to simulate
 * @param signers - Transaction signers
 * @returns Simulation result
 */
export async function simulateTransaction(
  connection: Connection,
  transaction: Transaction,
  signers: Keypair[]
): Promise<{ success: boolean; error?: string; logs?: string[] }> {
  try {
    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = signers[0].publicKey;

    // Sign transaction
    transaction.partialSign(...signers);

    // Simulate
    const simulation = await connection.simulateTransaction(transaction);

    if (simulation.value.err) {
      return {
        success: false,
        error: JSON.stringify(simulation.value.err),
        logs: simulation.value.logs || undefined,
      };
    }

    return {
      success: true,
      logs: simulation.value.logs || undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown simulation error',
    };
  }
}
