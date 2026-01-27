/**
 * Token Program Detection Utility
 * 
 * Handles detection of Token Program vs Token-2022 Program
 * and provides helpers for working with both standards
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

/**
 * Detect which token program a mint uses
 * @param connection - Solana connection
 * @param mint - Token mint address
 * @returns The token program ID (Token or Token-2022)
 */
export async function detectTokenProgram(
  connection: Connection,
  mint: PublicKey
): Promise<PublicKey> {
  try {
    const mintInfo = await connection.getAccountInfo(mint);
    
    if (!mintInfo) {
      throw new Error(`Mint account not found: ${mint.toBase58()}`);
    }

    // The owner of the mint account is the token program
    const programId = mintInfo.owner;

    // Validate it's one of the known token programs
    if (programId.equals(TOKEN_PROGRAM_ID)) {
      console.log(`[TOKEN-PROGRAM] Mint ${mint.toBase58()} uses Token Program`);
      return TOKEN_PROGRAM_ID;
    } else if (programId.equals(TOKEN_2022_PROGRAM_ID)) {
      console.log(`[TOKEN-PROGRAM] Mint ${mint.toBase58()} uses Token-2022 Program`);
      return TOKEN_2022_PROGRAM_ID;
    } else {
      console.warn(`[TOKEN-PROGRAM] Unknown token program for mint ${mint.toBase58()}: ${programId.toBase58()}`);
      // Default to standard Token Program for backward compatibility
      return TOKEN_PROGRAM_ID;
    }
  } catch (err) {
    console.error(`[TOKEN-PROGRAM] Error detecting token program for ${mint.toBase58()}:`, err);
    // Default to standard Token Program
    return TOKEN_PROGRAM_ID;
  }
}

/**
 * Get token decimals from mint
 * @param connection - Solana connection
 * @param mint - Token mint address
 * @returns Number of decimals for the token
 */
export async function getTokenDecimals(
  connection: Connection,
  mint: PublicKey
): Promise<number> {
  try {
    const { getMint } = await import('@solana/spl-token');
    
    // First detect which program to use
    const tokenProgramId = await detectTokenProgram(connection, mint);
    
    // Get mint info with the correct program
    const mintInfo = await getMint(connection, mint, undefined, tokenProgramId);
    
    console.log(`[TOKEN-DECIMALS] Mint ${mint.toBase58()} has ${mintInfo.decimals} decimals`);
    return mintInfo.decimals;
  } catch (err) {
    console.warn(`[TOKEN-DECIMALS] Failed to fetch decimals for ${mint.toBase58()}, using default 9:`, err);
    return 9; // Default fallback
  }
}

/**
 * Check if a token account exists and get its info
 * Tries both Token and Token-2022 programs
 * @param connection - Solana connection
 * @param tokenAccount - Token account address
 * @param mint - Token mint address (for program detection)
 * @returns Token account info or null if doesn't exist
 */
export async function getTokenAccountSafe(
  connection: Connection,
  tokenAccount: PublicKey,
  mint: PublicKey
): Promise<any | null> {
  const { getAccount } = await import('@solana/spl-token');
  
  // First try with the detected program
  try {
    const tokenProgramId = await detectTokenProgram(connection, mint);
    const accountInfo = await getAccount(connection, tokenAccount, undefined, tokenProgramId);
    return accountInfo;
  } catch (err: any) {
    // If account not found, return null
    if (err?.name === 'TokenAccountNotFoundError' || 
        err?.message?.includes('could not find account')) {
      return null;
    }
    
    // For other errors, try the other program as fallback
    try {
      const tokenProgramId = await detectTokenProgram(connection, mint);
      const otherProgram = tokenProgramId.equals(TOKEN_PROGRAM_ID) 
        ? TOKEN_2022_PROGRAM_ID 
        : TOKEN_PROGRAM_ID;
      
      console.log(`[TOKEN-ACCOUNT] Retrying with alternate program: ${otherProgram.toBase58()}`);
      const accountInfo = await getAccount(connection, tokenAccount, undefined, otherProgram);
      return accountInfo;
    } catch (fallbackErr) {
      // Account truly doesn't exist
      return null;
    }
  }
}
