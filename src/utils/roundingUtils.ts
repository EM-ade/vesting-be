/**
 * Rounding Utilities
 * Provides consistent rounding behavior across the application
 * 
 * STRATEGY: Always round DOWN (floor) for financial calculations
 * Rationale:
 * - Prevents over-allocation of tokens
 * - Conservative approach ensures we never promise more than we have
 * - Remainder stays in treasury (better than deficit)
 * - Matches blockchain integer arithmetic behavior
 */

import BN from 'bn.js';

/**
 * Standard epsilon for floating-point comparisons
 * Represents the smallest difference we consider significant
 */
export const EPSILON = 0.000001; // 1 millionth of a token

/**
 * Streamflow fee buffer (0.5% = 0.005)
 * Streamflow charges ~0.5% fee on pool creation
 */
export const STREAMFLOW_FEE_MULTIPLIER = 1.005;

/**
 * Round a token amount DOWN to avoid over-allocation
 * Uses floor to ensure conservative allocation
 * 
 * @param amount - Token amount to round
 * @param decimals - Number of decimal places (default 9 for Solana)
 * @returns Rounded amount (floored)
 */
export function roundTokenAmount(amount: number, decimals: number = 9): number {
  const multiplier = Math.pow(10, decimals);
  return Math.floor(amount * multiplier) / multiplier;
}

/**
 * Round a token amount UP for requirement calculations
 * Used when calculating how much is NEEDED (e.g., for validation)
 * 
 * @param amount - Token amount to round
 * @param decimals - Number of decimal places (default 9 for Solana)
 * @returns Rounded amount (ceiling)
 */
export function roundTokenAmountUp(amount: number, decimals: number = 9): number {
  const multiplier = Math.pow(10, decimals);
  return Math.ceil(amount * multiplier) / multiplier;
}

/**
 * Convert token amount to smallest units (lamports for SOL)
 * Always rounds DOWN to prevent over-allocation
 * 
 * @param amount - Token amount in human-readable units
 * @param decimals - Token decimals (9 for SOL/SPL tokens)
 * @returns Amount in smallest units (BN)
 */
export function toSmallestUnits(amount: number, decimals: number = 9): BN {
  const multiplier = Math.pow(10, decimals);
  // Floor to prevent over-allocation
  return new BN(Math.floor(amount * multiplier));
}

/**
 * Convert smallest units back to human-readable amount
 * 
 * @param amount - Amount in smallest units (BN or number)
 * @param decimals - Token decimals (9 for SOL/SPL tokens)
 * @returns Amount in human-readable units
 */
export function fromSmallestUnits(amount: BN | number, decimals: number = 9): number {
  const divisor = Math.pow(10, decimals);
  const amountNum = typeof amount === 'number' ? amount : amount.toNumber();
  return amountNum / divisor;
}

/**
 * Compare two floating-point numbers with epsilon tolerance
 * Handles JavaScript floating-point precision issues
 * 
 * @param a - First number
 * @param b - Second number
 * @param epsilon - Tolerance (default: EPSILON)
 * @returns true if numbers are equal within tolerance
 */
export function floatEquals(a: number, b: number, epsilon: number = EPSILON): boolean {
  return Math.abs(a - b) < epsilon;
}

/**
 * Check if a >= b with epsilon tolerance
 * 
 * @param a - First number
 * @param b - Second number
 * @param epsilon - Tolerance (default: EPSILON)
 * @returns true if a >= b (within tolerance)
 */
export function floatGreaterOrEqual(a: number, b: number, epsilon: number = EPSILON): boolean {
  return a > b || floatEquals(a, b, epsilon);
}

/**
 * Check if a < b with epsilon tolerance
 * 
 * @param a - First number
 * @param b - Second number
 * @param epsilon - Tolerance (default: EPSILON)
 * @returns true if a < b (outside tolerance)
 */
export function floatLessThan(a: number, b: number, epsilon: number = EPSILON): boolean {
  return !floatGreaterOrEqual(a, b, epsilon);
}

/**
 * Calculate required tokens with Streamflow fee buffer
 * Rounds UP to ensure sufficient tokens
 * 
 * @param poolAmount - Pool amount in tokens
 * @param decimals - Token decimals
 * @returns Required amount including Streamflow fee (rounded up)
 */
export function calculateRequiredWithFee(poolAmount: number, decimals: number = 9): number {
  const withFee = poolAmount * STREAMFLOW_FEE_MULTIPLIER;
  return roundTokenAmountUp(withFee, decimals);
}

/**
 * Calculate total pool amount from individual allocations
 * Ensures consistent rounding across all allocations
 * 
 * @param allocations - Array of allocation amounts
 * @param decimals - Token decimals
 * @returns Total (sum of floored amounts)
 */
export function sumAllocations(allocations: number[], decimals: number = 9): number {
  return allocations.reduce((sum, amount) => {
    return sum + roundTokenAmount(amount, decimals);
  }, 0);
}

/**
 * Distribute amount across recipients with consistent rounding
 * Uses BN for precision, then converts back
 * 
 * @param totalAmount - Total amount to distribute
 * @param numRecipients - Number of recipients
 * @param decimals - Token decimals
 * @returns Array of amounts (may have remainder in last allocation)
 */
export function distributeEvenly(
  totalAmount: number,
  numRecipients: number,
  decimals: number = 9
): number[] {
  const totalSmallest = toSmallestUnits(totalAmount, decimals);
  const perRecipient = totalSmallest.div(new BN(numRecipients));
  const remainder = totalSmallest.mod(new BN(numRecipients));

  const amounts: number[] = [];
  
  for (let i = 0; i < numRecipients; i++) {
    let allocation = perRecipient;
    
    // Add 1 smallest unit to first N recipients to distribute remainder
    if (i < remainder.toNumber()) {
      allocation = allocation.add(new BN(1));
    }
    
    amounts.push(fromSmallestUnits(allocation, decimals));
  }
  
  return amounts;
}

/**
 * Format token amount for display with consistent precision
 * 
 * @param amount - Token amount
 * @param decimals - Display decimals (default 4)
 * @returns Formatted string
 */
export function formatTokenAmount(amount: number, decimals: number = 4): string {
  return amount.toFixed(decimals);
}
