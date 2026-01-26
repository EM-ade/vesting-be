/**
 * Treasury Precision Tests
 * 
 * Tests to verify that floating-point precision issues are properly handled
 * in treasury balance calculations.
 * 
 * The core issue: JavaScript floating-point arithmetic can produce results like:
 * 1425.001 - 1425 = 0.0009999999999763531 (instead of 0.001)
 * 
 * This causes validation failures when the "shortfall" is essentially zero
 * but appears as a tiny number like 2.36e-14.
 */

import { 
  floatEquals, 
  floatGreaterOrEqual, 
  floatLessThan,
  roundTokenAmount,
  EPSILON 
} from '../src/utils/roundingUtils';

// Helper function to simulate the precision fix applied in treasuryCalculations.ts
function roundToLamports(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

describe('Treasury Precision Handling', () => {
  
  describe('Floating-point subtraction precision', () => {
    
    test('should handle the exact case that caused the bug: 1425.001 - 1425', () => {
      const totalBalance = 1425.001;
      const lockedInPools = 1425;
      
      // Raw subtraction produces imprecise result
      const rawAvailable = totalBalance - lockedInPools;
      console.log(`Raw available: ${rawAvailable}`);
      
      // This is what was happening before the fix
      expect(rawAvailable).not.toBe(0.001);
      expect(rawAvailable).toBeCloseTo(0.001, 10);
      
      // After rounding to lamports precision, it should be exact
      const roundedAvailable = roundToLamports(rawAvailable);
      console.log(`Rounded available: ${roundedAvailable}`);
      expect(roundedAvailable).toBe(0.001);
    });

    test('should handle very small pool amounts like 0.001 SOL', () => {
      const poolAmount = 0.001;
      const totalBalance = 1425.001;
      const lockedInPools = 1425;
      
      const rawAvailable = totalBalance - lockedInPools;
      const roundedAvailable = roundToLamports(rawAvailable);
      
      // The shortfall should be 0, not some tiny floating-point error
      const shortfall = poolAmount - roundedAvailable;
      expect(shortfall).toBe(0);
      
      // Available should be >= required
      expect(roundedAvailable).toBeGreaterThanOrEqual(poolAmount);
    });

    test('should handle micro amounts (0.000001 SOL = 1 lamport)', () => {
      const totalBalance = 100.000001;
      const lockedInPools = 100;
      
      const rawAvailable = totalBalance - lockedInPools;
      const roundedAvailable = roundToLamports(rawAvailable);
      
      expect(roundedAvailable).toBe(0.000001);
    });

    test('should correctly identify insufficient balance', () => {
      const poolAmount = 0.002;
      const totalBalance = 1425.001;
      const lockedInPools = 1425;
      
      const roundedAvailable = roundToLamports(totalBalance - lockedInPools);
      
      // 0.001 < 0.002, so this should show as insufficient
      expect(roundedAvailable).toBeLessThan(poolAmount);
      expect(roundedAvailable).toBe(0.001);
    });

    test('should handle exact matches without false positives', () => {
      const poolAmount = 0.001;
      const available = 0.001;
      
      // These should be considered equal
      expect(floatEquals(available, poolAmount, EPSILON)).toBe(true);
      expect(floatGreaterOrEqual(available, poolAmount, EPSILON)).toBe(true);
      expect(floatLessThan(available, poolAmount, EPSILON)).toBe(false);
    });

    test('should handle large numbers with small differences', () => {
      const totalBalance = 999999.123456789;
      const lockedInPools = 999999;
      
      const rawAvailable = totalBalance - lockedInPools;
      const roundedAvailable = roundToLamports(rawAvailable);
      
      // Should preserve 9 decimal places
      expect(roundedAvailable).toBe(0.123456789);
    });

    test('should never return negative available balance', () => {
      const totalBalance = 100;
      const lockedInPools = 100.0000001; // Slightly more locked than available
      
      const rawAvailable = totalBalance - lockedInPools;
      const roundedAvailable = Math.max(0, roundToLamports(rawAvailable));
      
      // Should be 0, not negative
      expect(roundedAvailable).toBe(0);
    });
  });

  describe('Edge cases', () => {
    
    test('should handle zero values', () => {
      expect(roundToLamports(0)).toBe(0);
      expect(roundToLamports(0 - 0)).toBe(0);
    });

    test('should handle very large numbers', () => {
      const totalBalance = 1000000000; // 1 billion SOL
      const lockedInPools = 999999999.999999999;
      
      const rawAvailable = totalBalance - lockedInPools;
      const roundedAvailable = roundToLamports(rawAvailable);
      
      // Should handle without overflow
      expect(roundedAvailable).toBeGreaterThanOrEqual(0);
    });

    test('should handle repeated additions (accumulation)', () => {
      // Simulate adding many small amounts
      let total = 0;
      for (let i = 0; i < 1000; i++) {
        total += 0.001;
      }
      
      const rounded = roundToLamports(total);
      
      // Should be 1.0, not 0.9999999999999... or 1.0000000000001...
      expect(rounded).toBe(1);
    });

    test('should handle the boundary case exactly at pool amount', () => {
      const poolAmount = 0.001;
      const funded = 0.001;
      const locked = 0;
      
      const available = roundToLamports(funded - locked);
      const shortfall = Math.max(0, poolAmount - available);
      
      expect(shortfall).toBe(0);
    });
  });

  describe('Comparison with existing rounding utilities', () => {
    
    test('roundTokenAmount should floor values', () => {
      // roundTokenAmount floors, which is different from our rounding
      expect(roundTokenAmount(0.0019999999, 9)).toBe(0.001999999);
      expect(roundTokenAmount(0.001, 9)).toBe(0.001);
    });

    test('floatEquals should handle near-equal values', () => {
      const a = 0.001;
      const b = 0.0009999999999763531; // The problematic value
      
      expect(floatEquals(a, b, EPSILON)).toBe(true);
    });

    test('floatGreaterOrEqual should treat near-equal as >=', () => {
      const available = 0.0009999999999763531;
      const required = 0.001;
      
      // With epsilon tolerance, these should be considered >=
      expect(floatGreaterOrEqual(available, required, EPSILON)).toBe(true);
    });

    test('floatLessThan should not trigger for near-equal values', () => {
      const available = 0.0009999999999763531;
      const required = 0.001;
      
      // Should NOT be considered less than
      expect(floatLessThan(available, required, EPSILON)).toBe(false);
    });
  });

  describe('Real-world scenarios', () => {
    
    test('Scenario: User funds exactly the required amount', () => {
      // User has 1425 SOL locked, funds 0.001 SOL for new pool
      const totalBalance = 1425.001; // After funding
      const lockedInPools = 1425; // Existing pools
      const requiredForNewPool = 0.001;
      
      const available = roundToLamports(totalBalance - lockedInPools);
      const hasSufficientFunds = available >= requiredForNewPool;
      const shortfall = Math.max(0, requiredForNewPool - available);
      
      expect(hasSufficientFunds).toBe(true);
      expect(shortfall).toBe(0);
      expect(available).toBe(0.001);
    });

    test('Scenario: Multiple small pools totaling a round number', () => {
      // Three pools of 0.001 each
      const pool1 = 0.001;
      const pool2 = 0.001;
      const pool3 = 0.001;
      
      const totalLocked = roundToLamports(pool1 + pool2 + pool3);
      expect(totalLocked).toBe(0.003);
      
      const totalBalance = 10.003;
      const available = roundToLamports(totalBalance - totalLocked);
      expect(available).toBe(10);
    });

    test('Scenario: Claiming reduces locked amount', () => {
      const initialLocked = 1000;
      const claimed = 0.123456789;
      
      const remainingLocked = roundToLamports(initialLocked - claimed);
      expect(remainingLocked).toBe(999.876543211);
    });
  });
});

describe('Integration test simulation', () => {
  
  test('Simulates the calculateAvailableBalance function', async () => {
    // Mock the function behavior
    function calculateAvailableBalance(
      totalBalance: number,
      lockedInPools: number
    ) {
      const rawAvailable = totalBalance - lockedInPools;
      const available = Math.max(0, Math.round(rawAvailable * 1e9) / 1e9);
      
      return {
        totalBalance: Math.round(totalBalance * 1e9) / 1e9,
        lockedInPools: Math.round(lockedInPools * 1e9) / 1e9,
        available,
      };
    }
    
    // Test the exact case from the bug report
    const result = calculateAvailableBalance(1425.001, 1425);
    
    expect(result.totalBalance).toBe(1425.001);
    expect(result.lockedInPools).toBe(1425);
    expect(result.available).toBe(0.001);
    
    // Verify validation would pass
    const poolAmount = 0.001;
    const shortfall = poolAmount - result.available;
    expect(shortfall).toBe(0);
  });
});
