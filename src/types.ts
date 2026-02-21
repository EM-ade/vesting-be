import { PublicKey } from '@solana/web3.js';

export interface NFTTier {
  minNFTs: number;
  percentage: number; // Percentage of vested amount (0-100)
}

export interface VestingConfig {
  recipient: PublicKey;
  startTime: number; // Unix timestamp
  cliffTime: number; // Unix timestamp
  endTime: number; // Unix timestamp
  totalAmount: number; // Amount in smallest token units
  nftTiers: NFTTier[];
  tokenMint: PublicKey;
}

export interface VestingData {
  id: string;
  config: VestingConfig;
  streamflowId: string;
  createdAt: number;
}

export interface ClaimResult {
  success: boolean;
  signature?: string;
  amountClaimed?: number;
  feePaid?: number;
  error?: string;
}

export interface EligibilityResult {
  eligible: boolean;
  nftCount: number;
  tier?: NFTTier;
  percentage: number;
  weightedScore?: number; // NEW: Total weighted score for this wallet
}

// Multi-user vesting pool types
export interface UserAllocation {
  wallet: PublicKey;
  sharePercentage: number; // Percentage of total pool (0-100)
  claimed: number; // Amount already claimed
  feePaid: boolean; // Has user paid the one-time fee?
}

export interface VestingPool {
  id: string;
  streamflowId: string;
  totalAmount: number;
  users: UserAllocation[];
  nftTiers: NFTTier[];
  config: VestingConfig;
  createdAt: number;
}

// Eligibility sync types
export interface EligibilitySyncResult {
  success: boolean;
  walletsChecked: number;
  streamsCreated: number;
  streamsCancelled: number;
  errors: string[];
  details: {
    added: string[];
    removed: string[];
    unchanged: string[];
  };
}

export interface WalletEligibilityStatus {
  wallet: string;
  nftCount: number;
  eligible: boolean;
  hasActiveStream: boolean;
  streamId?: string;
}

// Vesting modes
export enum VestingMode {
  SNAPSHOT = 'snapshot',
  DYNAMIC = 'dynamic',
  MANUAL = 'manual'
}

// Claim verification types
export interface ClaimVerificationResult {
  canClaim: boolean;
  reason: string;
  currentNFTCount: number;
  requiredNFTCount: number;
  claimableAmount: number;
}

// Snapshot types
export interface SnapshotResult {
  totalWallets: number;
  eligible: number;
  vestingsCreated: number;
  errors: string[];
  tierBreakdown: Record<number, { users: number; tokensPerUser: number; totalTokens: number }>;
}

// Reclaim types
export interface ReclaimResult {
  checked: number;
  reclaimed: number;
  totalReclaimed: number;
  errors: string[];
}

// Snapshot configuration types
export interface SnapshotRule {
  id: string;
  name: string;
  nftContract: string;
  threshold: number;
  allocationType: 'FIXED' | 'PERCENTAGE';
  allocationValue: number;
  enabled: boolean;
  weight?: number; // NEW: Weight multiplier for distribution (default: 1.0)
  description?: string; // NEW: Optional description of the rule
}

export interface SnapshotConfig {
  rules: SnapshotRule[];
  poolSize: number;
  cycleStartTime: number;
  cycleDuration: number;
}

export interface HolderData {
  address: string;
  balance: number;
}

export interface AllocationResult {
  address: string;
  amount: number;
  sources: Array<{ ruleName: string; amount: number }>;
}

export interface SnapshotProcessResult {
  totalWallets: number;
  totalAllocated: number;
  breakdown: Array<{
    ruleName: string;
    eligibleWallets: number;
    totalNfts: number;
    allocation: number;
  }>;
  allocations: AllocationResult[];
  errors: string[];
}
