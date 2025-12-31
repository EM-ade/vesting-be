import { Request, Response, NextFunction } from "express";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

/**
 * Admin Authentication Middleware with Cryptographic Signature Verification
 * SECURITY: Requires wallet signature to prove ownership
 * Prevents: Wallet address impersonation attacks
 * 
 * Required request body fields:
 * - adminWallet: Solana wallet address
 * - signature: Base58-encoded ed25519 signature
 * - message: Message that was signed
 * - timestamp: Unix timestamp (ms) of signature creation
 */
export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    // 1. EXTRACT AUTHENTICATION DATA
    const { adminWallet, signature, message, timestamp } = req.body;

    // Allow query params for GET requests (but still require signature in body for security)
    const walletAddress = adminWallet || req.query?.adminWallet;

    if (!walletAddress || !signature || !message || !timestamp) {
      return res.status(401).json({
        error: "Missing authentication: adminWallet, signature, message, and timestamp required",
        hint: "Frontend must sign message with wallet before making admin requests"
      });
    }

    // Check if admin wallet is provided
    if (typeof walletAddress !== "string") {
      return res.status(401).json({
        error: "Admin authentication required. Please provide adminWallet parameter.",
      });
    }

    // 2. VALIDATE TIMESTAMP (prevent replay attacks)
    const now = Date.now();
    const messageTime = parseInt(timestamp);
    const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes (reasonable session duration)

    if (isNaN(messageTime)) {
      return res.status(401).json({
        error: "Invalid timestamp format"
      });
    }

    if (Math.abs(now - messageTime) > MAX_AGE_MS) {
      return res.status(401).json({
        error: "Authentication expired. Please reconnect wallet.",
        hint: "Signatures are valid for 30 minutes to prevent replay attacks"
      });
    }

    // 3. VERIFY MESSAGE FORMAT
    const expectedMessage = `Authenticate as admin\nWallet: ${walletAddress}\nTimestamp: ${timestamp}`;
    if (message !== expectedMessage) {
      return res.status(401).json({
        error: "Invalid message format",
        expected: expectedMessage
      });
    }

    // 4. VERIFY SIGNATURE (cryptographic proof of wallet ownership)
    try {
      const publicKey = new PublicKey(walletAddress);
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = bs58.decode(signature);

      const isValid = nacl.sign.detached.verify(
        messageBytes,
        signatureBytes,
        publicKey.toBytes()
      );

      if (!isValid) {
        return res.status(401).json({
          error: "Invalid signature. Signature verification failed."
        });
      }
    } catch (err) {
      console.error("Signature verification error:", err);
      return res.status(401).json({
        error: "Signature verification failed",
        details: err instanceof Error ? err.message : "Unknown error"
      });
    }

    // 5. CHECK SUPER ADMIN (signature already verified)
    const adminWalletsEnv = process.env.ADMIN_WALLETS || "";

    // Parse comma-separated list of admin wallets
    const adminWallets = adminWalletsEnv
      .split(",")
      .map((w) => w.trim())
      .filter((w) => w.length > 0);

    if (adminWallets.includes(walletAddress)) {
      console.log(`✅ Super admin authenticated: ${walletAddress}`);
      return next();
    }

    // 6. CHECK PROJECT-LEVEL ACCESS (signature already verified)
    const projectId =
      (req.headers["x-project-id"] as string) ||
      req.body?.projectId ||
      req.query?.projectId;

    if (!projectId) {
      return res.status(403).json({
        error: "Project ID required for non-super-admin access",
        hint: "Provide projectId in query, body, or x-project-id header"
      });
    }

    const { getSupabaseClient } = require("../lib/supabaseClient");
    const supabase = getSupabaseClient();

    try {
      const { data: access } = await supabase
        .from("user_project_access")
        .select("role")
        .eq("project_id", projectId)
        .eq("wallet_address", walletAddress)
        .single();

      if (access && (access.role === "admin" || access.role === "owner")) {
        console.log(`✅ Project admin authenticated: ${walletAddress} for project ${projectId}`);
        return next();
      }

      return res.status(403).json({
        error: "Access denied. This wallet is not authorized as an admin for this project.",
      });
    } catch (err) {
      console.error("Database check failed in auth middleware:", err);
      return res
        .status(500)
        .json({ error: "Internal authentication error" });
    }

    if (!adminWalletsEnv) {
      console.error("⚠️  ADMIN_WALLETS environment variable not set!");
      return res.status(500).json({
        error:
          "Admin authentication not configured. Please set ADMIN_WALLETS environment variable.",
      });
    }

    return res.status(403).json({
      error: "Access denied. This wallet is not authorized as an admin.",
    });
  } catch (error) {
    console.error("Admin auth middleware error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Authentication error",
    });
  }
}
