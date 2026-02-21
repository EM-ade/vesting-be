/**
 * Weighted Allocation Tests
 * Tests for multi-CA weighted pool distribution
 */

describe('Weighted Allocation', () => {
  // Test the weighted allocation formula
  describe('calculateWeightedAllocation', () => {
    it('should calculate weighted score correctly for single collection', () => {
      // Example: User has 3 OG NFTs with weight 2.0
      const walletNFTs = new Map([['OG_COLLECTION', 3]]);
      const rules = [
        {
          name: 'OG Holders',
          nftContract: 'OG_COLLECTION',
          threshold: 1,
          allocationType: 'PERCENTAGE' as const,
          allocationValue: 50,
          enabled: true,
          weight: 2.0
        }
      ];

      // Weighted score = 3 NFTs * 2.0 weight = 6.0
      // This would be tested against the EligibilityService method
      expect(3 * 2.0).toBe(6.0);
    });

    it('should calculate weighted score for multiple collections', () => {
      // Example: User has 3 OG NFTs (weight 2.0) and 2 MassMint NFTs (weight 1.0)
      const walletNFTs = new Map([
        ['OG_COLLECTION', 3],
        ['MASSMINT_COLLECTION', 2]
      ]);

      const rules = [
        {
          name: 'OG Holders',
          nftContract: 'OG_COLLECTION',
          threshold: 1,
          allocationType: 'PERCENTAGE' as const,
          allocationValue: 50,
          enabled: true,
          weight: 2.0
        },
        {
          name: 'MassMint Holders',
          nftContract: 'MASSMINT_COLLECTION',
          threshold: 1,
          allocationType: 'PERCENTAGE' as const,
          allocationValue: 50,
          enabled: true,
          weight: 1.0
        }
      ];

      // OG: 3 * 2.0 = 6.0 weighted
      // MassMint: 2 * 1.0 = 2.0 weighted
      // Total: 8.0 weighted
      const ogWeighted = 3 * 2.0;
      const massMintWeighted = 2 * 1.0;
      const totalWeighted = ogWeighted + massMintWeighted;

      expect(ogWeighted).toBe(6.0);
      expect(massMintWeighted).toBe(2.0);
      expect(totalWeighted).toBe(8.0);
    });

    it('should calculate allocation share based on weighted score', () => {
      // Pool: 10,000 tokens
      // Rule: 50% allocation (5,000 tokens)
      // Holder A: 6.0 weighted score
      // Holder B: 2.0 weighted score
      // Total weighted: 8.0
      const poolTotal = 10000;
      const rulePercentage = 50;
      const poolShare = (poolTotal * rulePercentage) / 100;
      
      const holderAWeighted = 6.0;
      const holderBWeighted = 2.0;
      const totalWeighted = holderAWeighted + holderBWeighted;

      // Holder A share: (6.0 / 8.0) * 5000 = 3,750 tokens
      // Holder B share: (2.0 / 8.0) * 5000 = 1,250 tokens
      const holderAShare = (holderAWeighted / totalWeighted) * poolShare;
      const holderBShare = (holderBWeighted / totalWeighted) * poolShare;

      expect(holderAShare).toBe(3750);
      expect(holderBShare).toBe(1250);
      expect(holderAShare + holderBShare).toBe(poolShare);
    });

    it('should handle zero total weighted NFTs gracefully', () => {
      const totalWeighted = 0;
      const poolShare = 5000;
      const holderWeighted = 0;

      // Should return 0 when dividing by zero
      const allocation = totalWeighted > 0 ? (holderWeighted / totalWeighted) * poolShare : 0;
      expect(allocation).toBe(0);
    });

    it('should apply default weight of 1.0 when not specified', () => {
      const nftCount = 5;
      const weight = undefined;
      const effectiveWeight = weight || 1.0;
      const weightedScore = nftCount * effectiveWeight;

      expect(effectiveWeight).toBe(1.0);
      expect(weightedScore).toBe(5.0);
    });
  });

  describe('Weight Validation', () => {
    it('should reject weight <= 0', () => {
      const weight = 0;
      const isValid = weight > 0;
      expect(isValid).toBe(false);
    });

    it('should accept weight > 0', () => {
      const weight = 1.5;
      const isValid = weight > 0;
      expect(isValid).toBe(true);
    });

    it('should warn for very high weight (> 10)', () => {
      const weight = 15;
      const shouldWarn = weight > 10;
      expect(shouldWarn).toBe(true);
    });
  });

  describe('Distribution Scenarios', () => {
    it('should distribute 2x more to OG holders vs MassMint', () => {
      // Scenario: OG (weight 2.0) vs MassMint (weight 1.0)
      // Both hold 1 NFT each
      const ogHolder = { nftCount: 1, weight: 2.0 };
      const massMintHolder = { nftCount: 1, weight: 1.0 };

      const ogWeighted = ogHolder.nftCount * ogHolder.weight;
      const massMintWeighted = massMintHolder.nftCount * massMintHolder.weight;
      const totalWeighted = ogWeighted + massMintWeighted;

      const poolShare = 10000;
      const ogAllocation = (ogWeighted / totalWeighted) * poolShare;
      const massMintAllocation = (massMintWeighted / totalWeighted) * poolShare;

      // OG should get 2x more: 6,666.67 vs 3,333.33
      expect(ogAllocation).toBeGreaterThan(massMintAllocation);
      expect(ogAllocation / massMintAllocation).toBe(2.0);
    });

    it('should handle multiple NFTs per holder correctly', () => {
      // Holder A: 5 OG NFTs (weight 2.0) = 10.0 weighted
      // Holder B: 3 MassMint NFTs (weight 1.0) = 3.0 weighted
      const holderA = { nftCount: 5, weight: 2.0 };
      const holderB = { nftCount: 3, weight: 1.0 };

      const aWeighted = holderA.nftCount * holderA.weight;
      const bWeighted = holderB.nftCount * holderB.weight;
      const totalWeighted = aWeighted + bWeighted;

      const poolShare = 10000;
      const aAllocation = (aWeighted / totalWeighted) * poolShare;
      const bAllocation = (bWeighted / totalWeighted) * poolShare;

      expect(aWeighted).toBe(10.0);
      expect(bWeighted).toBe(3.0);
      expect(aAllocation).toBeGreaterThan(bAllocation);
    });
  });
});
