/**
 * Vault Service - Hybrid Mode
 * Supports BOTH vault_keys table AND Infisical during migration
 */

import { Keypair } from '@solana/web3.js';
import { getSupabaseClient } from '../lib/supabaseClient';
import { getTreasuryKey, storeTreasuryKey, withRetry } from './infisicalService';

/**
 * Create project vault - NEW projects use Infisical
 */
export const createProjectVault = async (projectId: string): Promise<string> => {
  const supabase = getSupabaseClient();
  const keypair = Keypair.generate();
  const privateKeyBase64 = Buffer.from(keypair.secretKey).toString('base64');
  const publicKey = keypair.publicKey.toString();

  try {
    // Store in Infisical (NEW approach)
    await withRetry(() => storeTreasuryKey(projectId, privateKeyBase64));

    // Update database (only public key + flag)
    const { error } = await supabase
      .from('projects')
      .update({
        vault_public_key: publicKey,
        uses_infisical: true, // ✅ Mark as Infisical-backed
      })
      .eq('id', projectId);

    if (error) {
      throw new Error(`Failed to create vault: ${error.message}`);
    }

    console.log(`✅ Created Infisical vault for project ${projectId}`);
    return publicKey;
  } catch (error: any) {
    console.error(`❌ Failed to create vault: ${error.message}`);
    throw error;
  }
};

/**
 * Get vault keypair - automatically detects storage method
 */
export const getVaultKeypairForProject = async (projectId: string): Promise<Keypair> => {
  const supabase = getSupabaseClient();

  const { data: project, error } = await supabase
    .from('projects')
    .select('vault_public_key, uses_infisical')
    .eq('id', projectId)
    .single();

  if (error || !project?.vault_public_key) {
    throw new Error(`Vault not found for project ${projectId}`);
  }

  let privateKeyBase64: string;

  // Auto-detect storage method
  if (project.uses_infisical) {
    // NEW: Fetch from Infisical
    console.log(`📦 Fetching key from Infisical for project ${projectId}`);
    privateKeyBase64 = await withRetry(() => getTreasuryKey(projectId));
  } else {
    // OLD: Fetch from vault_keys table
    console.log(`🔓 Fetching key from vault_keys table for project ${projectId}`);
    const { data: vaultKey, error: vaultError } = await supabase
      .from('vault_keys')
      .select('private_key_encrypted')
      .eq('project_id', projectId)
      .single();

    if (vaultError || !vaultKey?.private_key_encrypted) {
      throw new Error(`Vault key not found in vault_keys table for project ${projectId}`);
    }

    // Decrypt from vault_keys table
    const { decryptString } = await import('./encryptionService');
    privateKeyBase64 = decryptString(vaultKey.private_key_encrypted);
  }

  // Reconstruct keypair
  const secretKey = Uint8Array.from(Buffer.from(privateKeyBase64, 'base64'));
  const keypair = Keypair.fromSecretKey(secretKey);

  // Validate public key matches
  if (keypair.publicKey.toString() !== project.vault_public_key) {
    throw new Error(`Public key mismatch for project ${projectId}`);
  }

  return keypair;
};

export const updateVaultBalances = async (
  projectId: string, 
  tokenDelta: number = 0, 
  solDelta: number = 0
): Promise<void> => {
  const supabase = getSupabaseClient();
  
  const { error } = await supabase.rpc('update_vault_balances', {
    p_project_id: projectId,
    p_token_delta: tokenDelta,
    p_sol_delta: solDelta
  });

  if (error) {
    // Fallback if RPC not exists or fails (e.g. permission)
    console.error(`Failed to update vault balances via RPC: ${error.message}. Trying direct update.`);
    
    const { data: current } = await supabase
        .from('projects')
        .select('vault_balance_token, vault_balance_sol')
        .eq('id', projectId)
        .single();
        
    if (current) {
        await supabase
            .from('projects')
            .update({
                vault_balance_token: (current.vault_balance_token || 0) + tokenDelta,
                vault_balance_sol: (current.vault_balance_sol || 0) + solDelta,
                updated_at: new Date().toISOString()
            })
            .eq('id', projectId);
    } else {
        throw new Error(`Failed to update vault balances: ${error.message}`);
    }
  }
};
