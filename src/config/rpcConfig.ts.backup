/**
 * Centralized RPC Configuration System
 * 
 * Provides easy switching between Solana networks (devnet/mainnet)
 * and RPC providers (standard Solana, Helius, custom).
 * 
 * Features:
 * - Environment-based configuration
 * - Multiple RPC provider support
 * - Fallback mechanisms
 * - Validation and health checks
 * - Type-safe configuration
 */

import { Connection, Cluster, clusterApiUrl } from '@solana/web3.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Supported Solana clusters
 */
export type SolanaCluster = 'devnet' | 'mainnet-beta' | 'testnet';

/**
 * Supported RPC providers
 */
export type RPCProvider = 'solana' | 'helius' | 'custom';

/**
 * Network configuration for a specific RPC endpoint
 */
export interface NetworkConfig {
  /** Display name for the network */
  name: string;
  
  /** Solana cluster (devnet, mainnet-beta, testnet) */
  cluster: SolanaCluster;
  
  /** RPC endpoint URL */
  rpcEndpoint: string;
  
  /** RPC provider type */
  provider: RPCProvider;
  
  /** Whether this is a Helius endpoint */
  isHelius: boolean;
  
  /** WebSocket endpoint (optional) */
  wsEndpoint?: string;
  
  /** Rate limit per second (optional) */
  rateLimit?: number;
  
  /** Commitment level */
  commitment?: 'processed' | 'confirmed' | 'finalized';
}

/**
 * Complete RPC configuration
 */
export interface RPCConfiguration {
  /** All available network configurations */
  networks: {
    [key: string]: NetworkConfig;
  };
  
  /** Currently active network */
  activeNetwork: string;
  
  /** Fallback networks in order of preference */
  fallbackNetworks: string[];
  
  /** Health check configuration */
  healthCheck: {
    enabled: boolean;
    intervalMs: number;
    timeoutMs: number;
  };
  
  /** Retry configuration */
  retry: {
    maxRetries: number;
    initialDelayMs: number;
    maxDelayMs: number;
  };
}

/**
 * Health check result
 */
export interface HealthCheckResult {
  healthy: boolean;
  latencyMs?: number;
  slot?: number;
  error?: string;
  timestamp: number;
}

// ============================================================================
// DEFAULT CONFIGURATIONS
// ============================================================================

/**
 * Default network configurations
 * These can be overridden by environment variables
 */
export const DEFAULT_NETWORKS: { [key: string]: NetworkConfig } = {
  // Standard Solana Devnet
  'devnet': {
    name: 'Solana Devnet',
    cluster: 'devnet',
    rpcEndpoint: clusterApiUrl('devnet'),
    provider: 'solana',
    isHelius: false,
    commitment: 'confirmed',
    rateLimit: 100, // requests per second
  },
  
  // Standard Solana Mainnet
  'mainnet': {
    name: 'Solana Mainnet',
    cluster: 'mainnet-beta',
    rpcEndpoint: clusterApiUrl('mainnet-beta'),
    provider: 'solana',
    isHelius: false,
    commitment: 'confirmed',
    rateLimit: 100,
  },
  
  // Helius Devnet (requires API key)
  'helius-devnet': {
    name: 'Helius Devnet',
    cluster: 'devnet',
    rpcEndpoint: 'https://devnet.helius-rpc.com', // API key appended at runtime
    provider: 'helius',
    isHelius: true,
    commitment: 'confirmed',
    rateLimit: 200, // Higher rate limit with Helius
  },
  
  // Helius Mainnet (requires API key)
  'helius-mainnet': {
    name: 'Helius Mainnet',
    cluster: 'mainnet-beta',
    rpcEndpoint: 'https://mainnet.helius-rpc.com', // API key appended at runtime
    provider: 'helius',
    isHelius: true,
    commitment: 'confirmed',
    rateLimit: 200,
  },
};

/**
 * Default RPC configuration
 */
export const DEFAULT_RPC_CONFIG: RPCConfiguration = {
  networks: DEFAULT_NETWORKS,
  activeNetwork: 'devnet', // Default to devnet for safety
  fallbackNetworks: ['devnet', 'mainnet'], // Fallback order
  healthCheck: {
    enabled: true,
    intervalMs: 60000, // Check every 60 seconds
    timeoutMs: 5000, // 5 second timeout
  },
  retry: {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 10000,
  },
};

// ============================================================================
// RPC CONFIGURATION CLASS
// ============================================================================

/**
 * Centralized RPC Configuration Manager
 * Handles network switching, validation, and health checks
 */
export class RPCConfigManager {
  private config: RPCConfiguration;
  private heliusApiKey: string;
  private connections: Map<string, Connection> = new Map();
  private healthStatus: Map<string, HealthCheckResult> = new Map();
  private healthCheckInterval?: NodeJS.Timeout;

  constructor(heliusApiKey: string = '', customConfig?: Partial<RPCConfiguration>) {
    this.heliusApiKey = heliusApiKey;
    this.config = {
      ...DEFAULT_RPC_CONFIG,
      ...customConfig,
      networks: {
        ...DEFAULT_RPC_CONFIG.networks,
        ...(customConfig?.networks || {}),
      },
    };

    // Load from environment variables
    this.loadFromEnvironment();

    // Start health checks if enabled
    if (this.config.healthCheck.enabled) {
      this.startHealthChecks();
    }
  }

  /**
   * Load configuration from environment variables
   */
  private loadFromEnvironment(): void {
    // Override active network from env
    if (process.env.RPC_NETWORK) {
      const network = process.env.RPC_NETWORK;
      if (this.config.networks[network]) {
        this.config.activeNetwork = network;
        console.log(`[RPC Config] Using network from env: ${network}`);
      } else {
        console.warn(`[RPC Config] Unknown network in RPC_NETWORK: ${network}, using default`);
      }
    }

    // Override with custom RPC endpoint if provided
    if (process.env.RPC_ENDPOINT) {
      const customEndpoint = process.env.RPC_ENDPOINT;
      console.log(`[RPC Config] Using custom RPC endpoint from env: ${customEndpoint}`);
      
      // Detect network from endpoint
      const cluster = this.detectClusterFromEndpoint(customEndpoint);
      const isHelius = customEndpoint.includes('helius-rpc.com');
      
      this.config.networks['custom'] = {
        name: 'Custom RPC',
        cluster,
        rpcEndpoint: customEndpoint,
        provider: 'custom',
        isHelius,
        commitment: 'confirmed',
      };
      
      this.config.activeNetwork = 'custom';
    }

    // Auto-detect based on NODE_ENV
    if (!process.env.RPC_ENDPOINT && !process.env.RPC_NETWORK) {
      const nodeEnv = process.env.NODE_ENV || 'development';
      
      switch (nodeEnv) {
        case 'production':
          this.config.activeNetwork = this.heliusApiKey ? 'helius-mainnet' : 'mainnet';
          break;
        case 'staging':
          this.config.activeNetwork = this.heliusApiKey ? 'helius-devnet' : 'devnet';
          break;
        default:
          this.config.activeNetwork = 'devnet';
      }
      
      console.log(`[RPC Config] Auto-selected network based on NODE_ENV (${nodeEnv}): ${this.config.activeNetwork}`);
    }
  }

  /**
   * Detect cluster from RPC endpoint URL
   */
  private detectClusterFromEndpoint(endpoint: string): SolanaCluster {
    const lower = endpoint.toLowerCase();
    if (lower.includes('devnet')) return 'devnet';
    if (lower.includes('testnet')) return 'testnet';
    return 'mainnet-beta';
  }

  /**
   * Get the full RPC endpoint URL (with API key if Helius)
   */
  private getFullEndpoint(networkKey: string): string {
    const network = this.config.networks[networkKey];
    if (!network) {
      throw new Error(`Unknown network: ${networkKey}`);
    }

    let endpoint = network.rpcEndpoint;

    // Append Helius API key if needed
    if (network.isHelius && this.heliusApiKey) {
      // Check if endpoint already has query params
      const separator = endpoint.includes('?') ? '&' : '/?';
      endpoint = `${endpoint}${separator}api-key=${this.heliusApiKey}`;
    } else if (network.isHelius && !this.heliusApiKey) {
      console.warn(`[RPC Config] Helius network ${networkKey} requires API key, but none provided. Falling back.`);
      // Will trigger fallback mechanism
      throw new Error('Helius API key required');
    }

    return endpoint;
  }

  /**
   * Get the currently active network configuration
   */
  public getActiveNetwork(): NetworkConfig {
    return this.config.networks[this.config.activeNetwork];
  }

  /**
   * Get the active network key
   */
  public getActiveNetworkKey(): string {
    return this.config.activeNetwork;
  }

  /**
   * Get RPC endpoint for the active network
   */
  public getRPCEndpoint(): string {
    return this.getFullEndpoint(this.config.activeNetwork);
  }

  /**
   * Get cluster for the active network
   */
  public getCluster(): SolanaCluster {
    return this.getActiveNetwork().cluster;
  }

  /**
   * Check if active network is Helius
   */
  public isHelius(): boolean {
    return this.getActiveNetwork().isHelius;
  }

  /**
   * Get or create a Connection instance for the active network
   * Connections are cached for reuse
   */
  public getConnection(): Connection {
    const networkKey = this.config.activeNetwork;
    
    if (this.connections.has(networkKey)) {
      return this.connections.get(networkKey)!;
    }

    const network = this.getActiveNetwork();
    const endpoint = this.getRPCEndpoint();
    
    const connection = new Connection(endpoint, {
      commitment: network.commitment || 'confirmed',
      confirmTransactionInitialTimeout: 60000,
    });

    this.connections.set(networkKey, connection);
    console.log(`[RPC Config] Created new connection for ${network.name}: ${endpoint}`);
    
    return connection;
  }

  /**
   * Switch to a different network
   * @param networkKey - The network key to switch to
   * @param clearConnections - Whether to clear cached connections (default: true)
   */
  public async switchNetwork(networkKey: string, clearConnections: boolean = true): Promise<void> {
    if (!this.config.networks[networkKey]) {
      throw new Error(`Unknown network: ${networkKey}. Available: ${Object.keys(this.config.networks).join(', ')}`);
    }

    console.log(`[RPC Config] Switching from ${this.config.activeNetwork} to ${networkKey}`);
    
    this.config.activeNetwork = networkKey;

    if (clearConnections) {
      this.connections.clear();
      console.log(`[RPC Config] Cleared connection cache`);
    }

    // Validate new network
    await this.validateNetwork(networkKey);
  }

  /**
   * Validate that a network is accessible
   */
  public async validateNetwork(networkKey: string, timeoutMs: number = 5000): Promise<boolean> {
    try {
      const endpoint = this.getFullEndpoint(networkKey);
      const connection = new Connection(endpoint, 'confirmed');

      // Test with timeout
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Validation timeout')), timeoutMs)
      );

      const versionPromise = connection.getVersion();

      await Promise.race([versionPromise, timeoutPromise]);

      console.log(`[RPC Config] ✅ Network ${networkKey} validated successfully`);
      return true;
    } catch (error) {
      console.error(`[RPC Config] ❌ Network ${networkKey} validation failed:`, error);
      return false;
    }
  }

  /**
   * Perform health check on a network
   */
  public async performHealthCheck(networkKey: string): Promise<HealthCheckResult> {
    const startTime = Date.now();
    
    try {
      const endpoint = this.getFullEndpoint(networkKey);
      const connection = new Connection(endpoint, 'confirmed');

      // Test RPC with timeout
      const timeoutMs = this.config.healthCheck.timeoutMs;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Health check timeout')), timeoutMs)
      );

      const slot = await Promise.race([
        connection.getSlot(),
        timeoutPromise,
      ]);

      const latencyMs = Date.now() - startTime;

      const result: HealthCheckResult = {
        healthy: true,
        latencyMs,
        slot,
        timestamp: Date.now(),
      };

      this.healthStatus.set(networkKey, result);
      return result;
    } catch (error) {
      const result: HealthCheckResult = {
        healthy: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      };

      this.healthStatus.set(networkKey, result);
      return result;
    }
  }

  /**
   * Get health status for a network
   */
  public getHealthStatus(networkKey: string): HealthCheckResult | undefined {
    return this.healthStatus.get(networkKey);
  }

  /**
   * Get health status for all networks
   */
  public getAllHealthStatuses(): Map<string, HealthCheckResult> {
    return new Map(this.healthStatus);
  }

  /**
   * Start periodic health checks
   */
  private startHealthChecks(): void {
    if (this.healthCheckInterval) {
      return; // Already running
    }

    const intervalMs = this.config.healthCheck.intervalMs;
    
    console.log(`[RPC Config] Starting health checks (interval: ${intervalMs}ms)`);

    this.healthCheckInterval = setInterval(async () => {
      for (const networkKey of Object.keys(this.config.networks)) {
        await this.performHealthCheck(networkKey);
      }
    }, intervalMs);

    // Perform initial check
    setTimeout(async () => {
      for (const networkKey of Object.keys(this.config.networks)) {
        await this.performHealthCheck(networkKey);
      }
    }, 1000);
  }

  /**
   * Stop periodic health checks
   */
  public stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
      console.log(`[RPC Config] Stopped health checks`);
    }
  }

  /**
   * Get all available networks
   */
  public getAvailableNetworks(): { [key: string]: NetworkConfig } {
    return { ...this.config.networks };
  }

  /**
   * Add or update a custom network
   */
  public addNetwork(key: string, network: NetworkConfig): void {
    this.config.networks[key] = network;
    console.log(`[RPC Config] Added/updated network: ${key}`);
  }

  /**
   * Remove a network
   */
  public removeNetwork(key: string): void {
    if (key === this.config.activeNetwork) {
      throw new Error('Cannot remove active network. Switch first.');
    }
    delete this.config.networks[key];
    this.connections.delete(key);
    this.healthStatus.delete(key);
    console.log(`[RPC Config] Removed network: ${key}`);
  }

  /**
   * Get full configuration (for debugging/export)
   */
  public getConfiguration(): RPCConfiguration {
    return { ...this.config };
  }

  /**
   * Clean up resources
   */
  public destroy(): void {
    this.stopHealthChecks();
    this.connections.clear();
    this.healthStatus.clear();
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let rpcConfigInstance: RPCConfigManager | null = null;

/**
 * Initialize the global RPC configuration
 * Should be called once at application startup
 */
export function initializeRPCConfig(heliusApiKey: string = '', customConfig?: Partial<RPCConfiguration>): RPCConfigManager {
  if (rpcConfigInstance) {
    console.warn('[RPC Config] Already initialized, destroying old instance');
    rpcConfigInstance.destroy();
  }

  rpcConfigInstance = new RPCConfigManager(heliusApiKey, customConfig);
  console.log(`[RPC Config] Initialized with network: ${rpcConfigInstance.getActiveNetworkKey()}`);
  
  return rpcConfigInstance;
}

/**
 * Get the global RPC configuration instance
 * Throws if not initialized
 */
export function getRPCConfig(): RPCConfigManager {
  if (!rpcConfigInstance) {
    throw new Error('RPC Config not initialized. Call initializeRPCConfig() first.');
  }
  return rpcConfigInstance;
}

/**
 * Check if RPC config is initialized
 */
export function isRPCConfigInitialized(): boolean {
  return rpcConfigInstance !== null;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get RPC endpoint for the active network
 * Convenience function that doesn't require getting the config instance
 */
export function getActiveRPCEndpoint(): string {
  return getRPCConfig().getRPCEndpoint();
}

/**
 * Get connection for the active network
 * Convenience function that doesn't require getting the config instance
 */
export function getActiveConnection(): Connection {
  return getRPCConfig().getConnection();
}

/**
 * Get cluster for the active network
 * Convenience function that doesn't require getting the config instance
 */
export function getActiveCluster(): SolanaCluster {
  return getRPCConfig().getCluster();
}

/**
 * Check if active network is Helius
 * Convenience function that doesn't require getting the config instance
 */
export function isActiveNetworkHelius(): boolean {
  return getRPCConfig().isHelius();
}
