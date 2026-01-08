/**
 * Allocation Calculator Service
 * Handles conversion between percentage and fixed allocations
 * Uses integer-based math in smallest units to avoid floating-point errors
 */

import BN from 'bn.js';
import { config } from '../config';
import { toSmallestUnits, fromSmallestUnits } from '../utils/roundingUtils';

export interface AllocationInput {
    wallet: string;
    type: 'percentage' | 'fixed';
    value: number;
    tier?: number;
    note?: string;
}

export interface CalculatedAllocation {
    wallet: string;
    tokenAmount: number;
    percentage: number;
    originalType: 'percentage' | 'fixed';
    originalValue: number;
    tier: number;
    note?: string;
    isBelowMinimum?: boolean; // Flag for allocations zeroed due to minimum threshold
}

export interface AllocationResult {
    allocations: CalculatedAllocation[];
    unallocatedRemainder: number; // Amount in smallest units that couldn't be allocated
    totalAllocated: number;
    belowMinimumCount: number; // How many recipients got 0 due to minimum threshold
}

export class AllocationCalculator {
    /**
     * Calculate token amounts from allocations using integer math in smallest units
     * @param allocations - Array of allocation inputs
     * @param totalPoolAmount - Total tokens in the pool (in human-readable units, e.g., SOL)
     * @param tokenDecimals - Number of decimals for the token (9 for SOL, varies for SPL tokens)
     * @param minPayoutSmallestUnits - Minimum payout threshold in smallest units (default from config)
     * @returns Allocation result with precise integer allocations and unallocated remainder
     */
    static calculateAllocationsWithMinimum(
        allocations: AllocationInput[],
        totalPoolAmount: number,
        tokenDecimals: number = 9,
        minPayoutSmallestUnits?: number
    ): AllocationResult {
        // Use configured minimum or provided override
        const minPayout = minPayoutSmallestUnits ?? config.minPayoutLamports;
        
        // Convert total pool amount to smallest units (integer math)
        // Use consistent rounding utility
        const totalPoolSmallestUnits = toSmallestUnits(totalPoolAmount, tokenDecimals);
        
        // Calculate total weight for weighted distribution
        const totalWeight = allocations.reduce((sum, alloc) => {
            if (alloc.type === 'percentage') {
                return sum + alloc.value;
            }
            // For fixed allocations, convert to weight
            return sum + (alloc.value / totalPoolAmount) * 100;
        }, 0);

        let remainingPool = totalPoolSmallestUnits.clone();
        let unallocatedRemainder = new BN(0);
        let belowMinimumCount = 0;

        const calculatedAllocations: CalculatedAllocation[] = allocations.map((alloc, index) => {
            let tokenAmountSmallestUnits: BN;
            let percentage: number;

            // Calculate theoretical allocation in smallest units
            if (alloc.type === 'percentage') {
                percentage = alloc.value;
                // Use integer math: (totalPool * percentage) / 100
                // Round percentage to avoid precision issues
                const percentageBN = new BN(Math.floor(alloc.value * 1000)); // Multiply by 1000 for 3 decimal precision
                tokenAmountSmallestUnits = totalPoolSmallestUnits
                    .mul(percentageBN)
                    .div(new BN(100000)); // Divide by 100,000 (100 * 1000)
            } else {
                // Fixed allocation - use consistent rounding
                tokenAmountSmallestUnits = toSmallestUnits(alloc.value, tokenDecimals);
                percentage = (alloc.value / totalPoolAmount) * 100;
            }

            // Apply minimum payout threshold
            let finalAmountSmallestUnits: BN;
            let isBelowMinimum = false;

            if (tokenAmountSmallestUnits.lt(new BN(minPayout))) {
                // Below threshold - set to 0 and add to unallocated remainder
                finalAmountSmallestUnits = new BN(0);
                unallocatedRemainder = unallocatedRemainder.add(tokenAmountSmallestUnits);
                isBelowMinimum = true;
                belowMinimumCount++;
            } else {
                finalAmountSmallestUnits = tokenAmountSmallestUnits;
            }

            // Deduct from remaining pool
            remainingPool = remainingPool.sub(finalAmountSmallestUnits);

            // Convert back to human-readable units for display
            const tokenAmount = fromSmallestUnits(finalAmountSmallestUnits, tokenDecimals);

            return {
                wallet: alloc.wallet,
                tokenAmount,
                percentage: isBelowMinimum ? 0 : percentage,
                originalType: alloc.type,
                originalValue: alloc.value,
                tier: alloc.tier || 1,
                note: alloc.note,
                isBelowMinimum,
            };
        });

        const totalAllocated = calculatedAllocations.reduce((sum, alloc) => sum + alloc.tokenAmount, 0);
        const unallocatedRemainderHuman = fromSmallestUnits(unallocatedRemainder, tokenDecimals);

        return {
            allocations: calculatedAllocations,
            unallocatedRemainder: unallocatedRemainderHuman,
            totalAllocated,
            belowMinimumCount,
        };
    }

    /**
     * Legacy method - kept for backwards compatibility
     * @deprecated Use calculateAllocationsWithMinimum for more precise allocations
     */
    static calculateAllocations(
        allocations: AllocationInput[],
        totalPoolAmount: number
    ): CalculatedAllocation[] {
        const result = this.calculateAllocationsWithMinimum(allocations, totalPoolAmount, 9);
        return result.allocations;
    }

    /**
     * Recalculate allocations when pool total changes
     * Maintains original allocation type (percentage stays percentage, fixed stays fixed)
     * @param existingAllocations - Current allocations
     * @param newTotalPoolAmount - New total pool amount
     * @returns Recalculated allocations
     */
    static recalculateAllocations(
        existingAllocations: CalculatedAllocation[],
        newTotalPoolAmount: number
    ): CalculatedAllocation[] {
        return existingAllocations.map((alloc) => {
            let tokenAmount: number;
            let percentage: number;

            if (alloc.originalType === 'percentage') {
                // Percentage allocations: recalculate token amount based on new total
                percentage = alloc.originalValue;
                tokenAmount = (newTotalPoolAmount * alloc.originalValue) / 100;
            } else {
                // Fixed allocations: keep same token amount, recalculate percentage
                tokenAmount = alloc.originalValue;
                percentage = (alloc.originalValue / newTotalPoolAmount) * 100;
            }

            return {
                ...alloc,
                tokenAmount,
                percentage,
            };
        });
    }

    /**
     * Validate allocations don't exceed pool total
     * @param allocations - Calculated allocations
     * @param totalPoolAmount - Total pool amount
     * @returns Validation result with warnings for dust allocations
     */
    static validateAllocations(
        allocations: CalculatedAllocation[],
        totalPoolAmount: number
    ): { 
        valid: boolean; 
        totalAllocated: number; 
        message?: string;
        warnings?: string[];
    } {
        const totalAllocated = allocations.reduce((sum, alloc) => sum + alloc.tokenAmount, 0);
        const totalPercentage = allocations.reduce((sum, alloc) => sum + alloc.percentage, 0);
        const warnings: string[] = [];

        // Count allocations below minimum
        const belowMinimumCount = allocations.filter(a => a.isBelowMinimum).length;
        if (belowMinimumCount > 0) {
            const minPayoutHuman = config.minPayoutLamports / 1e9; // Convert to SOL
            warnings.push(
                `${belowMinimumCount} recipient(s) receive 0 tokens because their allocation is below the minimum payout threshold (${minPayoutHuman} SOL). ` +
                `This happens when the pool is very small relative to the number of recipients.`
            );
        }

        // Warn if many recipients have very small allocations
        const verySmallCount = allocations.filter(a => 
            !a.isBelowMinimum && a.tokenAmount < 0.001 // Less than 0.001 SOL
        ).length;
        if (verySmallCount > 0) {
            warnings.push(
                `${verySmallCount} recipient(s) receive very small amounts (<0.001 tokens). ` +
                `Consider increasing the pool size or reducing the number of recipients.`
            );
        }

        if (totalAllocated > totalPoolAmount) {
            return {
                valid: false,
                totalAllocated,
                message: `Total allocated (${totalAllocated.toFixed(9)}) exceeds pool amount (${totalPoolAmount})`,
                warnings,
            };
        }

        if (totalPercentage > 100) {
            return {
                valid: false,
                totalAllocated,
                message: `Total percentage (${totalPercentage.toFixed(2)}%) exceeds 100%`,
                warnings,
            };
        }

        return {
            valid: true,
            totalAllocated,
            warnings: warnings.length > 0 ? warnings : undefined,
        };
    }

    /**
     * Convert all allocations to a specific type
     * @param allocations - Current allocations
     * @param targetType - Type to convert to
     * @param totalPoolAmount - Total pool amount
     * @returns Converted allocations
     */
    static convertAllocationType(
        allocations: CalculatedAllocation[],
        targetType: 'percentage' | 'fixed',
        totalPoolAmount: number
    ): AllocationInput[] {
        return allocations.map((alloc) => ({
            wallet: alloc.wallet,
            type: targetType,
            value: targetType === 'percentage' ? alloc.percentage : alloc.tokenAmount,
            tier: alloc.tier,
            note: alloc.note,
        }));
    }
}
