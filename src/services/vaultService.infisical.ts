/**
 * Vault Service (Infisical Version)
 * 
 * Manages project treasury vaults using Infisical for key storage
 * This replaces the database-encryption approach with cloud-based secrets management
 */

import { Keypair } from '@solana/web3.js';
import { getSupabaseClient } from '../lib/supabaseClient';
import { 
  storeTreasuryKey, 
  getTreasuryKey, 
  deleteTreasuryKey,
  withRetry 
} from './infisicalService';

/**
 * Create a new treasury vault for a project
 * 
 * - Generates a new Solana keypair
 * - Stores private key in Infisical Cloud (NOT in database)
 * - Stores only public key in database
 * 
 * @param projectId - Unique project identifier
 * @returns Public key of the created vault (base58)
 */
export const createProjectVault = async (projectId: string): Promise<string> => {
  const supabase = getSupabaseClient();
  
  // Generate new keypair
  const keypair = Keypair.generate();
  const privateKeyBase64 = Buffer.from(keypair.secretKey).toString('base64');
  const publicKey = keypair.publicKey.toString();

  try {
    // Store private key in Infisical with retry logic
    await withRetry(() => storeTreasuryKey(projectId, privateKeyBase64));

    // Store ONLY public key in database (no encrypted private key)
    const { error } = await supabase
      .from('projects')
      .update({
        vault_public_key: publicKey,
        // vault_private_key_encrypted is intentionally NOT set
      })
      .eq('id', projectId);

    if (error) {
      // Rollback: delete key from Infisical if database update fails
      try {
        await deleteTreasuryKey(projectId);
      } catch (rollbackError) {
        console.error('❌ Failed to rollback Infisical key after database error:', rollbackError);
      }
      throw new Error(`Failed to create vault: ${error.message}`);
    }

    console.log(`✅ Created vault for project ${projectId}. Public key: ${publicKey}`);
    return publicKey;
  } catch (error: any) {
    console.error(`❌ Failed to create vault for project ${projectId}:`, error);
    throw new Error(`Vault creation failed: ${error.message}`);
  }
};

/**
 * Get vault keypair for a project (fetches from Infisical)
 * 
 * - Retrieves public key from database
 * - Fetches private key from Infisical Cloud
 * - Reconstructs Keypair object
 * 
 * @param projectId - Unique project identifier
 * @returns Solana Keypair object
 */
export const getVaultKeypairForProject = async (projectId: string): Promise<Keypair> => {
  const supabase = getSupabaseClient();

  try {
    // Get public key from database (for validation)
    const { data: project, error } = await supabase
      .from('projects')
      .select('vault_public_key')
      .eq('id', projectId)
      .single();

    if (error || !project?.vault_public_key) {
      throw new Error(`Vault not found for project ${projectId}`);
    }

    // Fetch private key from Infisical with retry logic
    const privateKeyBase64 = await withRetry(() => getTreasuryKey(projectId));

    // Reconstruct keypair
    const secretKey = Uint8Array.from(Buffer.from(privateKeyBase64, 'base64'));
    const keypair = Keypair.fromSecretKey(secretKey);

    // Validation: Ensure public key matches database
    if (keypair.publicKey.toString() !== project.vault_public_key) {
      throw new Error(
        `Public key mismatch for project ${projectId}. Database: ${project.vault_public_key}, Keypair: ${keypair.publicKey.toString()}`
      );
    }

    console.log(`✅ Retrieved vault keypair for project ${projectId}`);
    return keypair;
  } catch (error: any) {
    console.error(`❌ Failed to get vault keypair for project ${projectId}:`, error);
    throw new Error(`Failed to retrieve vault keypair: ${error.message}`);
  }
};

/**
 * Delete vault for a project (removes from Infisical)
 * 
 * ⚠️ WARNING: This permanently deletes the private key!
 * Ensure all funds are withdrawn before calling this.
 * 
 * @param projectId - Unique project identifier
 */
export const deleteProjectVault = async (projectId: string): Promise<void> => {
  const supabase = getSupabaseClient();

  try {
    // Delete from Infisical
    await withRetry(() => deleteTreasuryKey(projectId));

    // Clear public key from database
    const { error } = await supabase
      .from('projects')
      .update({
        vault_public_key: null,
      })
      .eq('id', projectId);

    if (error) {
      console.error(`⚠️ Deleted key from Infisical but failed to update database:`, error);
      throw new Error(`Failed to update database: ${error.message}`);
    }

    console.log(`✅ Deleted vault for project ${projectId}`);
  } catch (error: any) {
    console.error(`❌ Failed to delete vault for project ${projectId}:`, error);
    throw new Error(`Vault deletion failed: ${error.message}`);
  }
};

/**
 * Update vault balances (same as before, no changes needed)
 */
export const updateVaultBalances = async (
  projectId: string,
  tokenDelta: number = 0,
  solDelta: number = 0
): Promise<void> => {
  const supabase = getSupabaseClient();

  const { error } = await supabase.rpc('update_vault_balances', {
    p_project_id: projectId,
    p_token_delta: tokenDelta,
    p_sol_delta: solDelta,
  });

  if (error) {
    // Fallback if RPC not exists or fails
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
          updated_at: new Date().toISOString(),
        })
        .eq('id', projectId);
    } else {
      throw new Error(`Failed to update vault balances: ${error.message}`);
    }
  }
};

/**
 * Verify vault integrity (check that Infisical key matches database public key)
 * 
 * @param projectId - Unique project identifier
 * @returns true if vault is valid
 */
export const verifyVaultIntegrity = async (projectId: string): Promise<boolean> => {
  try {
    const keypair = await getVaultKeypairForProject(projectId);
    console.log(`✅ Vault integrity verified for project ${projectId}`);
    return true;
  } catch (error) {
    console.error(`❌ Vault integrity check failed for project ${projectId}:`, error);
    return false;
  }
};
