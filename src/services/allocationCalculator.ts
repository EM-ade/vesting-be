/**
 * Allocation Calculator Service
 * Handles conversion between percentage and fixed allocations
 */

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
}

export class AllocationCalculator {
    /**
     * Calculate token amounts from allocations
     * @param allocations - Array of allocation inputs
     * @param totalPoolAmount - Total tokens in the pool
     * @returns Calculated allocations with token amounts and percentages
     */
    static calculateAllocations(
        allocations: AllocationInput[],
        totalPoolAmount: number
    ): CalculatedAllocation[] {
        return allocations.map((alloc) => {
            let tokenAmount: number;
            let percentage: number;

            if (alloc.type === 'percentage') {
                percentage = alloc.value;
                tokenAmount = (totalPoolAmount * alloc.value) / 100;
            } else {
                // fixed
                tokenAmount = alloc.value;
                percentage = (alloc.value / totalPoolAmount) * 100;
            }

            return {
                wallet: alloc.wallet,
                tokenAmount,
                percentage,
                originalType: alloc.type,
                originalValue: alloc.value,
                tier: alloc.tier || 1,
                note: alloc.note,
            };
        });
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
     * @returns Validation result
     */
    static validateAllocations(
        allocations: CalculatedAllocation[],
        totalPoolAmount: number
    ): { valid: boolean; totalAllocated: number; message?: string } {
        const totalAllocated = allocations.reduce((sum, alloc) => sum + alloc.tokenAmount, 0);
        const totalPercentage = allocations.reduce((sum, alloc) => sum + alloc.percentage, 0);

        if (totalAllocated > totalPoolAmount) {
            return {
                valid: false,
                totalAllocated,
                message: `Total allocated (${totalAllocated}) exceeds pool amount (${totalPoolAmount})`,
            };
        }

        if (totalPercentage > 100) {
            return {
                valid: false,
                totalAllocated,
                message: `Total percentage (${totalPercentage.toFixed(2)}%) exceeds 100%`,
            };
        }

        return {
            valid: true,
            totalAllocated,
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
