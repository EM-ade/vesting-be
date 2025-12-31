/**
 * Enhanced Encryption Service with Project-Specific Key Derivation
 * SECURITY IMPROVEMENT: Uses HKDF to derive unique keys per project
 * Benefit: One project key compromise ≠ all projects compromised
 * 
 * Migration Path:
 * 1. Deploy this file alongside existing encryptionService.ts
 * 2. Test with new projects
 * 3. Migrate existing projects (re-encrypt with new keys)
 * 4. Replace old encryptionService.ts
 */

import crypto from 'crypto';
import { config } from '../config';

const ALGORITHM = 'aes-256-gcm';

/**
 * Derive project-specific encryption key from master password + project ID
 * Uses HKDF (HMAC-based Key Derivation Function) - NIST SP 800-108
 * 
 * @param projectId - Unique project identifier
 * @returns 32-byte key for AES-256
 */
function deriveProjectKey(projectId: string): Buffer {
  // Master key from environment
  const masterKey = crypto.createHash('sha256').update(config.masterPassword).digest();
  
  // Application-specific salt (constant)
  const salt = Buffer.from('vesting-platform-v1-2025');
  
  // Project-specific context
  const info = Buffer.from(`project:${projectId}`);
  
  // HKDF key derivation
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, salt, info, 32));
}

/**
 * Encrypt data with project-specific key
 * 
 * @param plaintext - Data to encrypt (typically base64-encoded private key)
 * @param projectId - Project ID for key derivation
 * @returns Encrypted string in format: iv:authTag:encryptedData
 */
export const encryptProjectSecret = (plaintext: string, projectId: string): string => {
  const key = deriveProjectKey(projectId);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  // Format: iv:authTag:encryptedData
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
};

/**
 * Decrypt data with project-specific key
 * 
 * @param ciphertext - Encrypted string from encryptProjectSecret
 * @param projectId - Project ID for key derivation
 * @returns Decrypted plaintext
 */
export const decryptProjectSecret = (ciphertext: string, projectId: string): string => {
  const key = deriveProjectKey(projectId);
  const parts = ciphertext.split(':');
  
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format. Expected format: iv:authTag:encryptedData');
  }
  
  const [ivHex, authTagHex, encryptedData] = parts;
  
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
};

/**
 * Re-encrypt existing data from old key to new project-specific key
 * Used for migrating existing projects
 * 
 * @param oldCiphertext - Data encrypted with old single-key method
 * @param projectId - Project ID for new key derivation
 * @returns Data re-encrypted with project-specific key
 */
export const migrateToProjectKey = async (
  oldCiphertext: string, 
  projectId: string
): Promise<string> => {
  // Import old decryption method
  const { decryptString } = await import('./encryptionService');
  
  // Decrypt with old key
  const plaintext = decryptString(oldCiphertext);
  
  // Re-encrypt with new project-specific key
  const newCiphertext = encryptProjectSecret(plaintext, projectId);
  
  console.log(`🔄 Migrated encryption for project ${projectId} to project-specific key`);
  
  return newCiphertext;
};

/**
 * Verify that encryption/decryption works correctly
 * Run this in tests or during deployment
 */
export const testProjectEncryption = (projectId: string): boolean => {
  try {
    const testData = 'test-private-key-data-12345';
    const encrypted = encryptProjectSecret(testData, projectId);
    const decrypted = decryptProjectSecret(encrypted, projectId);
    
    if (testData !== decrypted) {
      throw new Error('Decrypted data does not match original');
    }
    
    // Verify different projects get different ciphertexts
    const encrypted2 = encryptProjectSecret(testData, 'different-project-id');
    if (encrypted === encrypted2) {
      throw new Error('Same plaintext should produce different ciphertext for different projects');
    }
    
    console.log(`✅ Project-specific encryption test passed for ${projectId}`);
    return true;
  } catch (err) {
    console.error(`❌ Project encryption test failed:`, err);
    return false;
  }
};

// Export old methods for backwards compatibility during migration
export { encryptString, decryptString } from './encryptionService';
