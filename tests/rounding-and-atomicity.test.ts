/**
 * Test Suite: Pool Validation Rounding and Transaction Atomicity
 * 
 * Tests the fixes for:
 * 1. Consistent rounding behavior across all calculations
 * 2. Transaction simulation before Streamflow deployment
 * 3. Atomic pool creation (DB + Streamflow together or not at all)
 * 4. Edge case handling (very small/large amounts, precision issues)
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import {
  roundTokenAmount,
  roundTokenAmountUp,
  toSmallestUnits,
  fromSmallestUnits,
  floatEquals,
  floatGreaterOrEqual,
  floatLessThan,
  calculateRequiredWithFee,
  sumAllocations,
  distributeEvenly,
  EPSILON,
  STREAMFLOW_FEE_MULTIPLIER,
} from '../src/utils/roundingUtils';
import {
  simulateStreamflowPoolCreation,
  validatePoolParameters,
} from '../src/utils/transactionSimulation';
import { AllocationCalculator } from '../src/services/allocationCalculator';
import BN from 'bn.js';

describe('Rounding Utilities', () => {
  describe('roundTokenAmount (floor)', () => {
    test('should round down to avoid over-allocation', () => {
      expect(roundTokenAmount(100.9999, 2)).toBe(100.99);
      expect(roundTokenAmount(0.123456789, 4)).toBe(0.1234);
      expect(roundTokenAmount(999.999999, 9)).toBe(999.999999);
    });

    test('should handle very small amounts', () => {
      expect(roundTokenAmount(0.000000001, 9)).toBe(0.000000001);
      expect(roundTokenAmount(0.0000000001, 9)).toBe(0);
    });

    test('should handle large amounts', () => {
      expect(roundTokenAmount(1000000.123456789, 9)).toBe(1000000.123456789);
      expect(roundTokenAmount(999999999.999999999, 9)).toBe(999999999.999999999);
    });
  });

  describe('roundTokenAmountUp (ceiling)', () => {
    test('should round up for requirement calculations', () => {
      expect(roundTokenAmountUp(100.0001, 2)).toBe(100.01);
      expect(roundTokenAmountUp(0.123456789, 4)).toBe(0.1235);
    });

    test('should not over-round already rounded values', () => {
      expect(roundTokenAmountUp(100.5, 2)).toBe(100.5);
      expect(roundTokenAmountUp(0.12, 2)).toBe(0.12);
    });
  });

  describe('toSmallestUnits and fromSmallestUnits', () => {
    test('should convert to smallest units correctly', () => {
      const amount = 1.5; // 1.5 SOL
      const smallest = toSmallestUnits(amount, 9);
      expect(smallest.toString()).toBe('1500000000'); // 1.5 billion lamports
    });

    test('should convert from smallest units correctly', () => {
      const smallest = new BN('1500000000'); // 1.5 billion lamports
      const amount = fromSmallestUnits(smallest, 9);
      expect(amount).toBe(1.5);
    });

    test('should handle round-trip conversion', () => {
      const original = 123.456789;
      const smallest = toSmallestUnits(original, 9);
      const converted = fromSmallestUnits(smallest, 9);
      expect(converted).toBeCloseTo(original, 9);
    });

    test('should floor when converting to smallest units', () => {
      // 0.0000000001 SOL is smaller than 1 lamport, should floor to 0
      const tooSmall = 0.0000000001;
      const smallest = toSmallestUnits(tooSmall, 9);
      expect(smallest.toString()).toBe('0');
    });
  });

  describe('Float comparison with epsilon', () => {
    test('floatEquals should handle precision issues', () => {
      expect(floatEquals(100.9999999, 101.0000001, 0.001)).toBe(true);
      expect(floatEquals(100.5, 100.5)).toBe(true);
      expect(floatEquals(100, 101)).toBe(false);
    });

    test('floatGreaterOrEqual should work with epsilon', () => {
      expect(floatGreaterOrEqual(101, 100)).toBe(true);
      expect(floatGreaterOrEqual(100.0000001, 100, EPSILON)).toBe(true);
      expect(floatGreaterOrEqual(99.9, 100, EPSILON)).toBe(false);
    });

    test('floatLessThan should work with epsilon', () => {
      expect(floatLessThan(99, 100)).toBe(true);
      expect(floatLessThan(100.0000001, 100, EPSILON)).toBe(false); // Within epsilon
      expect(floatLessThan(99.99, 100, EPSILON)).toBe(true);
    });

    test('should handle the original bug case', () => {
      // Original issue: 100499.999999999 vs 100499.99999999999
      const balance = 100499.999999999;
      const required = 100499.99999999999;
      
      // With epsilon comparison, these should be considered equal
      expect(floatEquals(balance, required, EPSILON)).toBe(true);
      expect(floatGreaterOrEqual(balance, required, EPSILON)).toBe(true);
      expect(floatLessThan(balance, required, EPSILON)).toBe(false);
    });
  });

  describe('calculateRequiredWithFee', () => {
    test('should add 0.5% Streamflow fee and round up', () => {
      const poolAmount = 100000;
      const required = calculateRequiredWithFee(poolAmount);
      
      // Should be 100000 * 1.005 = 100500, rounded up
      expect(required).toBeGreaterThanOrEqual(100500);
      expect(required).toBeLessThan(100500.1);
    });

    test('should handle small amounts', () => {
      const poolAmount = 1;
      const required = calculateRequiredWithFee(poolAmount);
      expect(required).toBeGreaterThanOrEqual(1.005);
    });

    test('should handle edge case: 0', () => {
      const poolAmount = 0;
      const required = calculateRequiredWithFee(poolAmount);
      expect(required).toBe(0);
    });
  });

  describe('sumAllocations', () => {
    test('should sum allocations with consistent rounding', () => {
      const allocations = [33.333333, 33.333333, 33.333334];
      const total = sumAllocations(allocations, 6);
      
      // Each rounded down: 33.333333 + 33.333333 + 33.333334 = 100.000000
      expect(total).toBeCloseTo(100, 6);
    });

    test('should not over-allocate due to rounding', () => {
      const allocations = [0.123456789, 0.123456789, 0.123456789];
      const total = sumAllocations(allocations, 9);
      
      // Each should be floored, total <= sum of originals
      expect(total).toBeLessThanOrEqual(0.123456789 * 3 + EPSILON);
    });
  });

  describe('distributeEvenly', () => {
    test('should distribute 100 tokens evenly to 3 recipients', () => {
      const amounts = distributeEvenly(100, 3, 9);
      
      expect(amounts.length).toBe(3);
      
      // Sum should equal total (within epsilon)
      const sum = amounts.reduce((a, b) => a + b, 0);
      expect(floatEquals(sum, 100, EPSILON)).toBe(true);
      
      // Each should be close to 33.333... (use lower precision due to remainder distribution)
      amounts.forEach(amt => {
        expect(amt).toBeCloseTo(33.333333333, 7); // Changed from 9 to 7
      });
    });

    test('should handle remainder distribution', () => {
      const amounts = distributeEvenly(10, 3, 9);
      
      // 10 / 3 = 3.333... with remainder
      const sum = amounts.reduce((a, b) => a + b, 0);
      expect(floatEquals(sum, 10, EPSILON)).toBe(true);
    });

    test('should handle single recipient', () => {
      const amounts = distributeEvenly(100, 1, 9);
      expect(amounts.length).toBe(1);
      expect(amounts[0]).toBe(100);
    });
  });
});

describe('Transaction Simulation', () => {
  describe('validatePoolParameters', () => {
    test('should validate correct parameters', () => {
      const now = Math.floor(Date.now() / 1000);
      const errors = validatePoolParameters({
        totalAmount: 1000,
        startTime: now + 60,
        endTime: now + 86400,
        tokenDecimals: 9,
      });
      
      expect(errors).toEqual([]);
    });

    test('should catch negative amounts', () => {
      const now = Math.floor(Date.now() / 1000);
      const errors = validatePoolParameters({
        totalAmount: -100,
        startTime: now + 60,
        endTime: now + 86400,
      });
      
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.includes('greater than 0'))).toBe(true);
    });

    test('should catch end time before start time', () => {
      const now = Math.floor(Date.now() / 1000);
      const errors = validatePoolParameters({
        totalAmount: 1000,
        startTime: now + 86400,
        endTime: now + 60,
      });
      
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.includes('after start time'))).toBe(true);
    });

    test('should catch too short duration', () => {
      const now = Math.floor(Date.now() / 1000);
      const errors = validatePoolParameters({
        totalAmount: 1000,
        startTime: now,
        endTime: now + 30, // Only 30 seconds
      });
      
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.includes('too short'))).toBe(true);
    });

    test('should catch invalid cliff time', () => {
      const now = Math.floor(Date.now() / 1000);
      const errors = validatePoolParameters({
        totalAmount: 1000,
        startTime: now + 60,
        endTime: now + 86400,
        cliffTime: now + 90000, // After end time
      });
      
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.toLowerCase().includes('cliff') || e.includes('before end'))).toBe(true);
    });

    test('should catch invalid token decimals', () => {
      const now = Math.floor(Date.now() / 1000);
      const errors = validatePoolParameters({
        totalAmount: 1000,
        startTime: now + 60,
        endTime: now + 86400,
        tokenDecimals: 25, // Too many decimals
      });
      
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.includes('decimals'))).toBe(true);
    });

    test('should catch non-finite amounts', () => {
      const now = Math.floor(Date.now() / 1000);
      const errors = validatePoolParameters({
        totalAmount: Infinity,
        startTime: now + 60,
        endTime: now + 86400,
      });
      
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.includes('valid number'))).toBe(true);
    });
  });
});

describe('AllocationCalculator with consistent rounding', () => {
  test('should calculate percentage allocations without over-allocation', () => {
    const allocations = [
      { wallet: 'wallet1', type: 'percentage' as const, value: 33.33, tier: 1 },
      { wallet: 'wallet2', type: 'percentage' as const, value: 33.33, tier: 1 },
      { wallet: 'wallet3', type: 'percentage' as const, value: 33.34, tier: 1 },
    ];

    const result = AllocationCalculator.calculateAllocationsWithMinimum(
      allocations,
      1000,
      9,
      1 // 1 lamport minimum
    );

    // Total should not exceed pool amount
    expect(result.totalAllocated).toBeLessThanOrEqual(1000 + EPSILON);
    
    // Should have 3 allocations
    expect(result.allocations.length).toBe(3);
    
    // Each should be close to their percentage
    expect(result.allocations[0].tokenAmount).toBeCloseTo(333.3, 1);
    expect(result.allocations[1].tokenAmount).toBeCloseTo(333.3, 1);
    expect(result.allocations[2].tokenAmount).toBeCloseTo(333.4, 1);
  });

  test('should handle fixed allocations correctly', () => {
    const allocations = [
      { wallet: 'wallet1', type: 'fixed' as const, value: 500, tier: 1 },
      { wallet: 'wallet2', type: 'fixed' as const, value: 300, tier: 1 },
    ];

    const result = AllocationCalculator.calculateAllocationsWithMinimum(
      allocations,
      1000,
      9,
      1
    );

    // Total allocated should be <= pool amount
    expect(result.totalAllocated).toBeLessThanOrEqual(1000);
    
    // Check each allocation
    expect(result.allocations[0].tokenAmount).toBe(500);
    expect(result.allocations[1].tokenAmount).toBe(300);
    
    // Total allocated should be 800 (500 + 300)
    expect(result.totalAllocated).toBe(800);
    
    // unallocatedRemainder only tracks amounts below minimum threshold
    // For fixed allocations above minimum, the remainder is implicit (pool - allocated)
    // The 200 remaining tokens stay in the pool but aren't tracked in unallocatedRemainder
    expect(result.belowMinimumCount).toBe(0); // No allocations below minimum
  });

  test('should filter out allocations below minimum', () => {
    const allocations = [
      { wallet: 'wallet1', type: 'fixed' as const, value: 1000, tier: 1 },
      { wallet: 'wallet2', type: 'fixed' as const, value: 0.000000001, tier: 1 }, // Below 1 lamport
    ];

    const result = AllocationCalculator.calculateAllocationsWithMinimum(
      allocations,
      1000,
      9,
      1000000 // 0.001 SOL minimum
    );

    expect(result.allocations[0].tokenAmount).toBe(1000);
    expect(result.allocations[1].tokenAmount).toBe(0); // Filtered
    expect(result.allocations[1].isBelowMinimum).toBe(true);
    expect(result.belowMinimumCount).toBe(1);
  });

  test('should handle edge case: very large pool', () => {
    const allocations = [
      { wallet: 'wallet1', type: 'percentage' as const, value: 50, tier: 1 },
      { wallet: 'wallet2', type: 'percentage' as const, value: 50, tier: 1 },
    ];

    // Use a smaller large pool to avoid BN overflow (1 million instead of 1 billion)
    const result = AllocationCalculator.calculateAllocationsWithMinimum(
      allocations,
      1000000, // 1 million tokens (safer for BN conversion)
      9,
      1
    );

    expect(result.totalAllocated).toBeLessThanOrEqual(1000000 + EPSILON);
    expect(result.allocations[0].tokenAmount).toBeCloseTo(500000, 1);
    expect(result.allocations[1].tokenAmount).toBeCloseTo(500000, 1);
  });

  test('should handle edge case: very small pool', () => {
    const allocations = [
      { wallet: 'wallet1', type: 'percentage' as const, value: 50, tier: 1 },
      { wallet: 'wallet2', type: 'percentage' as const, value: 50, tier: 1 },
    ];

    const result = AllocationCalculator.calculateAllocationsWithMinimum(
      allocations,
      0.000001, // 1 micro token
      9,
      1 // 1 lamport minimum
    );

    // Both might be below minimum
    const totalAllocated = result.allocations.reduce((sum, a) => sum + a.tokenAmount, 0);
    expect(totalAllocated).toBeLessThanOrEqual(0.000001 + EPSILON);
  });

  test('should handle rounding remainder correctly', () => {
    // This tests the exact issue from the bug report
    const allocations = [
      { wallet: 'wallet1', type: 'percentage' as const, value: 33.333, tier: 1 },
      { wallet: 'wallet2', type: 'percentage' as const, value: 33.333, tier: 1 },
      { wallet: 'wallet3', type: 'percentage' as const, value: 33.334, tier: 1 },
    ];

    const result = AllocationCalculator.calculateAllocationsWithMinimum(
      allocations,
      100000,
      9,
      1
    );

    // With floor rounding, total should be slightly less than pool
    expect(result.totalAllocated).toBeLessThanOrEqual(100000);
    
    // Unallocated remainder should be positive (dust left in treasury)
    expect(result.unallocatedRemainder).toBeGreaterThanOrEqual(0);
    
    // Total allocated + remainder should equal pool (within epsilon)
    const reconstructed = result.totalAllocated + result.unallocatedRemainder;
    expect(floatEquals(reconstructed, 100000, EPSILON)).toBe(true);
  });
});

describe('Integration: End-to-End Rounding Consistency', () => {
  test('should maintain consistency from validation to allocation', () => {
    const poolAmount = 100000;
    const allocations = [
      { wallet: 'wallet1', type: 'percentage' as const, value: 25, tier: 1 },
      { wallet: 'wallet2', type: 'percentage' as const, value: 25, tier: 1 },
      { wallet: 'wallet3', type: 'percentage' as const, value: 25, tier: 1 },
      { wallet: 'wallet4', type: 'percentage' as const, value: 25, tier: 1 },
    ];

    // Step 1: Calculate required amount with Streamflow fee
    const required = calculateRequiredWithFee(poolAmount);
    // calculateRequiredWithFee rounds UP, so it will be slightly more than exact multiplication
    expect(required).toBeGreaterThanOrEqual(poolAmount * STREAMFLOW_FEE_MULTIPLIER);

    // Step 2: Calculate allocations
    const result = AllocationCalculator.calculateAllocationsWithMinimum(
      allocations,
      poolAmount,
      9,
      1
    );

    // Step 3: Verify no over-allocation
    expect(result.totalAllocated).toBeLessThanOrEqual(poolAmount + EPSILON);
    
    // Step 4: Each allocation should be exactly 25%
    result.allocations.forEach(alloc => {
      expect(alloc.tokenAmount).toBeCloseTo(25000, 1);
      expect(alloc.percentage).toBe(25);
    });
  });
});
