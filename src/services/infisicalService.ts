/**
 * Infisical Cloud Service
 * 
 * Manages treasury vault private keys using Infisical Cloud Secrets Management
 * 
 * Security Benefits:
 * - Private keys never stored in application database
 * - Centralized secret management with audit logging
 * - Machine Identity authentication (no hardcoded credentials)
 * - Automatic encryption at rest and in transit
 * - Granular access controls and key rotation
 * 
 * @see https://infisical.com/docs
 */

import { InfisicalSDK } from '@infisical/sdk';

// Singleton client instance
let infisicalClient: InfisicalSDK | null = null;

/**
 * Configuration for Infisical connection
 */
interface InfisicalConfig {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string; // 'dev', 'staging', 'prod'
  secretPath: string;  // '/treasury-keys' - where to store keys
}

/**
 * Get Infisical configuration from environment variables
 */
function getInfisicalConfig(): InfisicalConfig {
  const config = {
    clientId: process.env.INFISICAL_CLIENT_ID || '',
    clientSecret: process.env.INFISICAL_CLIENT_SECRET || '',
    projectId: process.env.INFISICAL_PROJECT_ID || '',
    environment: process.env.INFISICAL_ENVIRONMENT || 'dev',
    secretPath: process.env.INFISICAL_SECRET_PATH || '/treasury-keys',
  };

  // Validation
  if (!config.clientId || !config.clientSecret || !config.projectId) {
    throw new Error(
      'Missing Infisical configuration. Required: INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET, INFISICAL_PROJECT_ID'
    );
  }

  return config;
}

/**
 * Initialize Infisical client (singleton pattern)
 */
async function getInfisicalClient(): Promise<InfisicalSDK> {
  if (infisicalClient) {
    return infisicalClient;
  }

  const config = getInfisicalConfig();

  try {
    // Create client with latest SDK pattern
    infisicalClient = new InfisicalSDK({
      siteUrl: process.env.INFISICAL_SITE_URL || 'https://app.infisical.com',
    });

    // Authenticate with Universal Auth
    await infisicalClient.auth().universalAuth.login({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });

    console.log('✅ Infisical client initialized and authenticated successfully');
    return infisicalClient;
  } catch (error) {
    console.error('❌ Failed to initialize Infisical client:', error);
    throw new Error(`Infisical initialization failed: ${error}`);
  }
}

/**
 * Generate secret key name for a project
 * Format: TREASURY_KEY_<PROJECT_ID>
 */
function getSecretKeyName(projectId: string): string {
  return `TREASURY_KEY_${projectId.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * Store treasury private key in Infisical
 * 
 * @param projectId - Unique project identifier
 * @param privateKeyBase64 - Base64-encoded Solana private key (64 bytes)
 * @returns Promise<void>
 * 
 * @example
 * const keypair = Keypair.generate();
 * const privateKey = Buffer.from(keypair.secretKey).toString('base64');
 * await storeTreasuryKey('proj-123', privateKey);
 */
export async function storeTreasuryKey(
  projectId: string,
  privateKeyBase64: string
): Promise<void> {
  const client = await getInfisicalClient();
  const config = getInfisicalConfig();
  const secretName = getSecretKeyName(projectId);

  try {
    // Create or update secret in Infisical using latest SDK
    await client.secrets().createSecret(secretName, {
      projectId: config.projectId,
      environment: config.environment,
      secretValue: privateKeyBase64,
      secretPath: config.secretPath,
      secretComment: `Treasury key for project ${projectId}`,
      type: 'shared' as any,
    });

    console.log(`✅ Stored treasury key for project ${projectId} in Infisical`);
  } catch (error: any) {
    // If secret already exists, update it
    if (error?.message?.includes('already exists')) {
      await client.secrets().updateSecret(secretName, {
        projectId: config.projectId,
        environment: config.environment,
        secretValue: privateKeyBase64,
        secretPath: config.secretPath,
      });
      console.log(`✅ Updated existing treasury key for project ${projectId}`);
    } else {
      console.error(`❌ Failed to store treasury key for project ${projectId}:`, error);
      throw new Error(`Failed to store treasury key: ${error.message}`);
    }
  }
}

/**
 * Retrieve treasury private key from Infisical
 * 
 * @param projectId - Unique project identifier
 * @returns Base64-encoded private key
 * 
 * @example
 * const privateKeyBase64 = await getTreasuryKey('proj-123');
 * const secretKey = Uint8Array.from(Buffer.from(privateKeyBase64, 'base64'));
 * const keypair = Keypair.fromSecretKey(secretKey);
 */
export async function getTreasuryKey(projectId: string): Promise<string> {
  const config = getInfisicalConfig();
  const secretName = getSecretKeyName(projectId);

  try {
    // ✅ FIX: Reset client and re-authenticate on 401 errors
    let client = await getInfisicalClient();
    
    try {
      const secret = await client.secrets().getSecret({
        projectId: config.projectId,
        environment: config.environment,
        secretPath: config.secretPath,
        secretName: secretName,
      });

      if (!secret || !secret.secretValue) {
        throw new Error(`Treasury key not found for project ${projectId}`);
      }

      console.log(`✅ Retrieved treasury key for project ${projectId} from Infisical`);
      return secret.secretValue;
    } catch (authError: any) {
      // If 401 error, reset client and retry once
      if (authError.message?.includes('401') || authError.message?.includes('Token missing')) {
        console.warn('⚠️ Infisical token expired, re-authenticating...');
        infisicalClient = null; // Reset singleton
        client = await getInfisicalClient(); // Re-authenticate
        
        const secret = await client.secrets().getSecret({
          projectId: config.projectId,
          environment: config.environment,
          secretPath: config.secretPath,
          secretName: secretName,
        });

        if (!secret || !secret.secretValue) {
          throw new Error(`Treasury key not found for project ${projectId}`);
        }

        console.log(`✅ Retrieved treasury key for project ${projectId} after re-auth`);
        return secret.secretValue;
      }
      throw authError;
    }
  } catch (error: any) {
    console.error(`❌ Failed to retrieve treasury key for project ${projectId}:`, error);
    throw new Error(`Failed to retrieve treasury key: ${error.message}`);
  }
}

/**
 * Delete treasury private key from Infisical
 * 
 * @param projectId - Unique project identifier
 * @returns Promise<void>
 * 
 * @example
 * await deleteTreasuryKey('proj-123');
 */
export async function deleteTreasuryKey(projectId: string): Promise<void> {
  const client = await getInfisicalClient();
  const config = getInfisicalConfig();
  const secretName = getSecretKeyName(projectId);

  try {
    await client.secrets().deleteSecret(secretName, {
      projectId: config.projectId,
      environment: config.environment,
      secretPath: config.secretPath,
    });

    console.log(`✅ Deleted treasury key for project ${projectId} from Infisical`);
  } catch (error: any) {
    console.error(`❌ Failed to delete treasury key for project ${projectId}:`, error);
    throw new Error(`Failed to delete treasury key: ${error.message}`);
  }
}

/**
 * Rotate treasury key (generate new keypair and store in Infisical)
 * 
 * ⚠️ WARNING: This will make the old treasury wallet inaccessible!
 * Only use this if you've transferred all funds out of the old wallet.
 * 
 * @param projectId - Unique project identifier
 * @returns New public key (base58)
 * 
 * @example
 * // 1. Transfer all funds from old wallet to new wallet
 * // 2. Rotate key
 * const newPublicKey = await rotateTreasuryKey('proj-123');
 */
export async function rotateTreasuryKey(projectId: string): Promise<string> {
  const { Keypair } = await import('@solana/web3.js');

  // Generate new keypair
  const newKeypair = Keypair.generate();
  const privateKeyBase64 = Buffer.from(newKeypair.secretKey).toString('base64');

  // Store new key in Infisical (overwrites old key)
  await storeTreasuryKey(projectId, privateKeyBase64);

  console.log(`✅ Rotated treasury key for project ${projectId}. New public key: ${newKeypair.publicKey.toString()}`);

  return newKeypair.publicKey.toString();
}

/**
 * List all treasury keys in Infisical (for auditing)
 * 
 * @returns Array of project IDs with stored keys
 */
export async function listTreasuryKeys(): Promise<string[]> {
  const client = await getInfisicalClient();
  const config = getInfisicalConfig();

  try {
    const result = await client.secrets().listSecrets({
      projectId: config.projectId,
      environment: config.environment,
      secretPath: config.secretPath,
    });

    const projectIds = result.secrets
      .filter((s) => s.secretKey.startsWith('TREASURY_KEY_'))
      .map((s) => s.secretKey.replace('TREASURY_KEY_', '').replace(/_/g, '-').toLowerCase());

    console.log(`✅ Found ${projectIds.length} treasury keys in Infisical`);
    return projectIds;
  } catch (error: any) {
    console.error('❌ Failed to list treasury keys:', error);
    throw new Error(`Failed to list treasury keys: ${error.message}`);
  }
}

/**
 * Health check - verify Infisical connection
 * 
 * @returns true if connection is working
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const client = await getInfisicalClient();
    const config = getInfisicalConfig();

    // Try to list secrets (doesn't require any secrets to exist)
    try {
      await client.secrets().listSecrets({
        projectId: config.projectId,
        environment: config.environment,
        secretPath: config.secretPath,
      });
    } catch (error: any) {
      // If folder doesn't exist, that's okay - we'll create it when we add first secret
      if (error.message && error.message.includes('Folder with path')) {
        console.log(`ℹ️  Folder ${config.secretPath} doesn't exist yet (will be created automatically)`);
      } else {
        throw error;
      }
    }

    console.log('✅ Infisical health check passed');
    return true;
  } catch (error) {
    console.error('❌ Infisical health check failed:', error);
    return false;
  }
}

/**
 * Retry wrapper for Infisical operations
 * 
 * @param operation - Async function to retry
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @param delayMs - Delay between retries in milliseconds (default: 1000)
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      console.warn(`⚠️ Attempt ${attempt}/${maxRetries} failed:`, error.message);

      if (attempt < maxRetries) {
        // Exponential backoff
        const delay = delayMs * Math.pow(2, attempt - 1);
        console.log(`   Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(`Operation failed after ${maxRetries} attempts: ${lastError?.message}`);
}
