import * as dotenv from "dotenv";
import { Connection, PublicKey } from "@solana/web3.js";

dotenv.config();

export const config = {
  rpcEndpoint:
    process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com",
  treasuryPrivateKey: process.env.TREASURY_PRIVATE_KEY || "",
  adminPrivateKey:
    process.env.ADMIN_PRIVATE_KEY || process.env.TREASURY_PRIVATE_KEY || "",
  feeWallet: process.env.FEE_WALLET
    ? new PublicKey(process.env.FEE_WALLET)
    : undefined,
  customTokenMint: process.env.CUSTOM_TOKEN_MINT
    ? new PublicKey(process.env.CUSTOM_TOKEN_MINT)
    : undefined,
  nftCollectionAddress: process.env.NFT_COLLECTION_ADDRESS
    ? new PublicKey(process.env.NFT_COLLECTION_ADDRESS)
    : undefined,
  claimFeeSOL: 0.01,
  claimFeeUSD: 2.0,
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  nftThreshold: parseInt(process.env.NFT_THRESHOLD || "20"),
  syncIntervalHours: parseInt(process.env.SYNC_INTERVAL_HOURS || "24"),
  vestingDurationDays: parseInt(process.env.VESTING_DURATION_DAYS || "365"),
  vestingCliffDays: parseInt(process.env.VESTING_CLIFF_DAYS || "30"),
  baseAllocationAmount: parseInt(
    process.env.BASE_ALLOCATION_AMOUNT || "1000000000000"
  ),
  heliusApiKey: process.env.HELIUS_API_KEY || "",
  gracePeriodDays: parseInt(process.env.GRACE_PERIOD_DAYS || "30"),
  masterPassword:
    process.env.MASTER_PASSWORD || "default_dev_password_do_not_use_prod",
  // Minimum payout threshold in lamports (10,000 lamports = 0.00001 SOL)
  // Allocations below this amount will be set to 0 and tracked as unallocated remainder
  minPayoutLamports: parseInt(
    process.env.MIN_PAYOUT_LAMPORTS || "10000"
  ),
}; // 1M tokens with 9 decimals

export const getConnection = () =>
  new Connection(config.rpcEndpoint, "confirmed");
