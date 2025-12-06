import { Keypair } from '@solana/web3.js';
import { encryptString, decryptString } from './encryptionService';
import { getSupabaseClient } from '../lib/supabaseClient';

export const createProjectVault = async (projectId: string): Promise<string> => {
  const supabase = getSupabaseClient();
  const keypair = Keypair.generate();
  const encryptedPrivateKey = encryptString(
    Buffer.from(keypair.secretKey).toString('base64')
  );
  
  const { error } = await supabase
    .from('projects')
    .update({
      vault_public_key: keypair.publicKey.toString(),
      vault_private_key_encrypted: encryptedPrivateKey,
    })
    .eq('id', projectId);

  if (error) {
    throw new Error(`Failed to create vault: ${error.message}`);
  }

  return keypair.publicKey.toString();
};

export const getVaultKeypairForProject = async (projectId: string): Promise<Keypair> => {
  const supabase = getSupabaseClient();
  const { data: project, error } = await supabase
    .from('projects')
    .select('vault_private_key_encrypted')
    .eq('id', projectId)
    .single();

  if (error || !project?.vault_private_key_encrypted) {
    throw new Error(`Vault not found for project ${projectId}`);
  }

  const decryptedPrivateKey = decryptString(project.vault_private_key_encrypted);
  const secretKey = Uint8Array.from(Buffer.from(decryptedPrivateKey, 'base64'));
  
  return Keypair.fromSecretKey(secretKey);
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
