/**
 * RPC Validation and Error Handling
 * 
 * Provides validation, health checks, and error handling for RPC endpoints
 */

import { Connection } from '@solana/web3.js';
import { getRPCConfig, type NetworkConfig } from './rpcConfig';

// ============================================================================
// TYPES
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  endpoint: string;
  errors: string[];
  warnings: string[];
  metadata?: {
    version?: string;
    slot?: number;
    blockHeight?: number;
    latencyMs?: number;
  };
}

export interface RPCError {
  code: string;
  message: string;
  endpoint: string;
  timestamp: number;
  retryable: boolean;
}

// ============================================================================
// ERROR CODES
// ============================================================================

export enum RPCErrorCode {
  CONNECTION_FAILED = 'CONNECTION_FAILED',
  TIMEOUT = 'TIMEOUT',
  INVALID_RESPONSE = 'INVALID_RESPONSE',
  RATE_LIMITED = 'RATE_LIMITED',
  UNAUTHORIZED = 'UNAUTHORIZED',
  NETWORK_MISMATCH = 'NETWORK_MISMATCH',
  UNKNOWN = 'UNKNOWN',
}

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

/**
 * Validate an RPC endpoint
 * Performs comprehensive checks to ensure endpoint is accessible and functional
 */
export async function validateRPCEndpoint(
  endpoint: string,
  timeoutMs: number = 10000
): Promise<ValidationResult> {
  const result: ValidationResult = {
    valid: true,
    endpoint,
    errors: [],
    warnings: [],
    metadata: {},
  };

  const startTime = Date.now();

  try {
    // Basic URL validation
    try {
      new URL(endpoint);
    } catch (error) {
      result.valid = false;
      result.errors.push('Invalid URL format');
      return result;
    }

    // Create connection
    const connection = new Connection(endpoint, 'confirmed');

    // Test 1: Get version (most basic check)
    const versionPromise = connection.getVersion();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), timeoutMs)
    );

    try {
      const version = await Promise.race([versionPromise, timeoutPromise]);
      result.metadata!.version = version['solana-core'];
    } catch (error) {
      result.valid = false;
      if (error instanceof Error && error.message === 'Timeout') {
        result.errors.push(`Connection timeout after ${timeoutMs}ms`);
      } else {
        result.errors.push(`Failed to get version: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
      return result;
    }

    // Test 2: Get current slot
    try {
      const slot = await connection.getSlot();
      result.metadata!.slot = slot;

      if (slot === 0) {
        result.warnings.push('Slot is 0, network might not be producing blocks');
      }
    } catch (error) {
      result.warnings.push('Failed to get slot information');
    }

    // Test 3: Get block height
    try {
      const blockHeight = await connection.getBlockHeight();
      result.metadata!.blockHeight = blockHeight;

      if (blockHeight === 0) {
        result.warnings.push('Block height is 0, network might not be producing blocks');
      }
    } catch (error) {
      result.warnings.push('Failed to get block height');
    }

    // Calculate latency
    result.metadata!.latencyMs = Date.now() - startTime;

    if (result.metadata!.latencyMs > 5000) {
      result.warnings.push(`High latency: ${result.metadata!.latencyMs}ms`);
    }

  } catch (error) {
    result.valid = false;
    result.errors.push(
      `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  return result;
}

/**
 * Validate the currently active RPC endpoint
 */
export async function validateActiveEndpoint(): Promise<ValidationResult> {
  const rpcConfig = getRPCConfig();
  const endpoint = rpcConfig.getRPCEndpoint();
  return validateRPCEndpoint(endpoint);
}

/**
 * Validate all configured networks
 */
export async function validateAllNetworks(): Promise<Map<string, ValidationResult>> {
  const rpcConfig = getRPCConfig();
  const networks = rpcConfig.getAvailableNetworks();
  const results = new Map<string, ValidationResult>();

  for (const [key, network] of Object.entries(networks)) {
    try {
      // Get full endpoint (with API key if Helius)
      const tempConfig = getRPCConfig();
      const originalNetwork = tempConfig.getActiveNetworkKey();
      
      // Temporarily switch to test endpoint
      await tempConfig.switchNetwork(key, false);
      const endpoint = tempConfig.getRPCEndpoint();
      
      // Validate
      const result = await validateRPCEndpoint(endpoint);
      results.set(key, result);
      
      // Switch back
      await tempConfig.switchNetwork(originalNetwork, false);
    } catch (error) {
      results.set(key, {
        valid: false,
        endpoint: network.rpcEndpoint,
        errors: [`Validation error: ${error instanceof Error ? error.message : 'Unknown'}`],
        warnings: [],
      });
    }
  }

  return results;
}

// ============================================================================
// ERROR HANDLING
// ============================================================================

/**
 * Create a standardized RPC error
 */
export function createRPCError(
  code: RPCErrorCode,
  message: string,
  endpoint: string,
  retryable: boolean = true
): RPCError {
  return {
    code,
    message,
    endpoint,
    timestamp: Date.now(),
    retryable,
  };
}

/**
 * Parse Solana RPC error and determine if retryable
 */
export function parseRPCError(error: any, endpoint: string): RPCError {
  const errorMessage = error?.message || String(error);

  // Check for specific error patterns
  if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
    return createRPCError(RPCErrorCode.TIMEOUT, errorMessage, endpoint, true);
  }

  if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
    return createRPCError(RPCErrorCode.RATE_LIMITED, errorMessage, endpoint, true);
  }

  if (errorMessage.includes('401') || errorMessage.includes('403') || errorMessage.includes('unauthorized')) {
    return createRPCError(RPCErrorCode.UNAUTHORIZED, errorMessage, endpoint, false);
  }

  if (errorMessage.includes('ECONNREFUSED') || errorMessage.includes('ENOTFOUND')) {
    return createRPCError(RPCErrorCode.CONNECTION_FAILED, errorMessage, endpoint, true);
  }

  if (errorMessage.includes('invalid') || errorMessage.includes('parse')) {
    return createRPCError(RPCErrorCode.INVALID_RESPONSE, errorMessage, endpoint, false);
  }

  // Default to unknown error, mark as retryable to be safe
  return createRPCError(RPCErrorCode.UNKNOWN, errorMessage, endpoint, true);
}

/**
 * Retry an RPC operation with exponential backoff
 */
export async function retryRPCOperation<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  initialDelayMs: number = 1000,
  endpoint: string = 'unknown'
): Promise<T> {
  let lastError: RPCError | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = parseRPCError(error, endpoint);

      // Don't retry if not retryable
      if (!lastError.retryable) {
        throw error;
      }

      // Don't retry on last attempt
      if (attempt === maxRetries - 1) {
        throw error;
      }

      // Calculate delay with exponential backoff
      const delay = initialDelayMs * Math.pow(2, attempt);
      const jitter = Math.random() * 0.3 * delay; // Add 0-30% jitter
      const totalDelay = delay + jitter;

      console.warn(
        `[RPC Retry] Attempt ${attempt + 1}/${maxRetries} failed: ${lastError.message}. ` +
        `Retrying in ${Math.round(totalDelay)}ms...`
      );

      await new Promise(resolve => setTimeout(resolve, totalDelay));
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError || new Error('All retries failed');
}

/**
 * Execute RPC operation with automatic fallback to backup networks
 */
export async function executeWithFallback<T>(
  operation: (connection: Connection) => Promise<T>,
  fallbackNetworks?: string[]
): Promise<T> {
  const rpcConfig = getRPCConfig();
  const originalNetwork = rpcConfig.getActiveNetworkKey();
  const networks = fallbackNetworks || rpcConfig.getConfiguration().fallbackNetworks;

  let lastError: Error | null = null;

  // Try original network first
  try {
    const connection = rpcConfig.getConnection();
    return await operation(connection);
  } catch (error) {
    lastError = error as Error;
    console.warn(`[RPC Fallback] Primary network failed: ${lastError.message}`);
  }

  // Try fallback networks
  for (const networkKey of networks) {
    if (networkKey === originalNetwork) {
      continue; // Already tried
    }

    try {
      console.log(`[RPC Fallback] Trying fallback network: ${networkKey}`);
      await rpcConfig.switchNetwork(networkKey, false);
      const connection = rpcConfig.getConnection();
      const result = await operation(connection);
      
      console.log(`[RPC Fallback] ✅ Succeeded with fallback network: ${networkKey}`);
      return result;
    } catch (error) {
      lastError = error as Error;
      console.warn(`[RPC Fallback] Fallback network ${networkKey} failed: ${lastError.message}`);
    }
  }

  // Restore original network
  try {
    await rpcConfig.switchNetwork(originalNetwork, false);
  } catch (error) {
    console.error('[RPC Fallback] Failed to restore original network');
  }

  // All attempts failed
  throw new Error(
    `All RPC endpoints failed. Last error: ${lastError?.message || 'Unknown'}. ` +
    `Tried networks: ${[originalNetwork, ...networks].join(', ')}`
  );
}

// ============================================================================
// MONITORING
// ============================================================================

/**
 * RPC metrics tracker
 */
export class RPCMetricsTracker {
  private metrics = new Map<string, {
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    totalLatencyMs: number;
    errors: RPCError[];
  }>();

  /**
   * Record a successful RPC call
   */
  public recordSuccess(endpoint: string, latencyMs: number): void {
    const metric = this.getOrCreateMetric(endpoint);
    metric.totalCalls++;
    metric.successfulCalls++;
    metric.totalLatencyMs += latencyMs;
  }

  /**
   * Record a failed RPC call
   */
  public recordFailure(endpoint: string, error: RPCError): void {
    const metric = this.getOrCreateMetric(endpoint);
    metric.totalCalls++;
    metric.failedCalls++;
    metric.errors.push(error);

    // Keep only last 10 errors
    if (metric.errors.length > 10) {
      metric.errors.shift();
    }
  }

  /**
   * Get metrics for an endpoint
   */
  public getMetrics(endpoint: string) {
    const metric = this.metrics.get(endpoint);
    if (!metric) {
      return null;
    }

    return {
      ...metric,
      averageLatencyMs: metric.totalLatencyMs / Math.max(metric.successfulCalls, 1),
      successRate: metric.successfulCalls / Math.max(metric.totalCalls, 1),
    };
  }

  /**
   * Get all metrics
   */
  public getAllMetrics() {
    const result = new Map();
    for (const [endpoint, metric] of this.metrics.entries()) {
      result.set(endpoint, {
        ...metric,
        averageLatencyMs: metric.totalLatencyMs / Math.max(metric.successfulCalls, 1),
        successRate: metric.successfulCalls / Math.max(metric.totalCalls, 1),
      });
    }
    return result;
  }

  /**
   * Reset metrics
   */
  public reset(): void {
    this.metrics.clear();
  }

  private getOrCreateMetric(endpoint: string) {
    if (!this.metrics.has(endpoint)) {
      this.metrics.set(endpoint, {
        totalCalls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        totalLatencyMs: 0,
        errors: [],
      });
    }
    return this.metrics.get(endpoint)!;
  }
}

// Singleton instance
let metricsTracker: RPCMetricsTracker | null = null;

/**
 * Get the global metrics tracker
 */
export function getRPCMetricsTracker(): RPCMetricsTracker {
  if (!metricsTracker) {
    metricsTracker = new RPCMetricsTracker();
  }
  return metricsTracker;
}
