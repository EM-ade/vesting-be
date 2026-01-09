/**
 * Tests for RPC Configuration System
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
  RPCConfigManager,
  initializeRPCConfig,
  getRPCConfig,
  DEFAULT_NETWORKS,
  type NetworkConfig,
} from '../src/config/rpcConfig';
import {
  validateRPCEndpoint,
  retryRPCOperation,
  parseRPCError,
  RPCErrorCode,
  RPCMetricsTracker,
} from '../src/config/rpcValidation';

describe('RPC Configuration System', () => {
  let configManager: RPCConfigManager;

  beforeEach(() => {
    // Initialize with test config
    configManager = new RPCConfigManager('test-api-key', {
      activeNetwork: 'devnet',
      healthCheck: { enabled: false, intervalMs: 60000, timeoutMs: 5000 },
      fallbackNetworks: ['devnet', 'mainnet'],
      retry: { maxRetries: 3, initialDelayMs: 100, maxDelayMs: 1000 },
    });
  });

  afterEach(() => {
    configManager.destroy();
  });

  describe('RPCConfigManager', () => {
    test('should initialize with default network', () => {
      const activeNetwork = configManager.getActiveNetwork();
      expect(activeNetwork.cluster).toBe('devnet');
    });

    test('should get RPC endpoint', () => {
      const endpoint = configManager.getRPCEndpoint();
      expect(endpoint).toBeTruthy();
      expect(typeof endpoint).toBe('string');
    });

    test('should get cluster', () => {
      const cluster = configManager.getCluster();
      expect(cluster).toBe('devnet');
    });

    test('should detect Helius networks', () => {
      expect(configManager.isHelius()).toBe(false);
    });

    test('should switch networks', async () => {
      await configManager.switchNetwork('mainnet');
      expect(configManager.getCluster()).toBe('mainnet-beta');
      expect(configManager.getActiveNetworkKey()).toBe('mainnet');
    });

    test('should throw error for unknown network', async () => {
      await expect(
        configManager.switchNetwork('unknown-network')
      ).rejects.toThrow('Unknown network');
    });

    test('should get all available networks', () => {
      const networks = configManager.getAvailableNetworks();
      expect(Object.keys(networks).length).toBeGreaterThan(0);
      expect(networks['devnet']).toBeDefined();
      expect(networks['mainnet']).toBeDefined();
    });

    test('should add custom network', () => {
      const customNetwork: NetworkConfig = {
        name: 'Custom Test',
        cluster: 'devnet',
        rpcEndpoint: 'https://test.example.com',
        provider: 'custom',
        isHelius: false,
        commitment: 'confirmed',
      };

      configManager.addNetwork('custom-test', customNetwork);
      const networks = configManager.getAvailableNetworks();
      expect(networks['custom-test']).toBeDefined();
      expect(networks['custom-test'].name).toBe('Custom Test');
    });

    test('should remove network', () => {
      const customNetwork: NetworkConfig = {
        name: 'Custom Test',
        cluster: 'devnet',
        rpcEndpoint: 'https://test.example.com',
        provider: 'custom',
        isHelius: false,
      };

      configManager.addNetwork('custom-test', customNetwork);
      configManager.removeNetwork('custom-test');
      const networks = configManager.getAvailableNetworks();
      expect(networks['custom-test']).toBeUndefined();
    });

    test('should not remove active network', () => {
      expect(() => {
        configManager.removeNetwork('devnet');
      }).toThrow('Cannot remove active network');
    });

    test('should get connection', () => {
      const connection = configManager.getConnection();
      expect(connection).toBeDefined();
      expect(connection.rpcEndpoint).toBeTruthy();
    });

    test('should cache connections', () => {
      const connection1 = configManager.getConnection();
      const connection2 = configManager.getConnection();
      expect(connection1).toBe(connection2); // Same instance
    });

    test('should clear connections on network switch', async () => {
      const connection1 = configManager.getConnection();
      await configManager.switchNetwork('mainnet', true);
      const connection2 = configManager.getConnection();
      expect(connection1).not.toBe(connection2); // Different instances
    });
  });

  describe('Environment Detection', () => {
    test('should detect cluster from endpoint', () => {
      const manager = new RPCConfigManager('', {
        networks: {
          test: {
            name: 'Test',
            cluster: 'devnet',
            rpcEndpoint: 'https://api.devnet.solana.com',
            provider: 'solana',
            isHelius: false,
          },
        },
        activeNetwork: 'test',
      });

      expect(manager.getCluster()).toBe('devnet');
      manager.destroy();
    });

    test('should handle custom RPC_ENDPOINT from env', () => {
      const originalEnv = process.env.RPC_ENDPOINT;
      process.env.RPC_ENDPOINT = 'https://custom.endpoint.com';

      const manager = new RPCConfigManager('');
      const endpoint = manager.getRPCEndpoint();
      expect(endpoint).toBe('https://custom.endpoint.com');

      process.env.RPC_ENDPOINT = originalEnv;
      manager.destroy();
    });
  });

  describe('Helius Integration', () => {
    test('should append API key to Helius endpoints', () => {
      const manager = new RPCConfigManager('my-api-key', {
        activeNetwork: 'helius-devnet',
      });

      const endpoint = manager.getRPCEndpoint();
      expect(endpoint).toContain('api-key=my-api-key');
      manager.destroy();
    });

    test('should handle missing API key for Helius', () => {
      const manager = new RPCConfigManager('', {
        activeNetwork: 'helius-devnet',
      });

      expect(() => {
        manager.getRPCEndpoint();
      }).toThrow('Helius API key required');
      manager.destroy();
    });
  });

  describe('Health Checks', () => {
    test('should perform health check', async () => {
      const result = await configManager.performHealthCheck('devnet');
      expect(result).toBeDefined();
      expect(result.timestamp).toBeDefined();
      expect(typeof result.healthy).toBe('boolean');
    }, 15000); // Increase timeout for network call

    test('should get health status', async () => {
      await configManager.performHealthCheck('devnet');
      const status = configManager.getHealthStatus('devnet');
      expect(status).toBeDefined();
    });

    test('should get all health statuses', async () => {
      await configManager.performHealthCheck('devnet');
      const statuses = configManager.getAllHealthStatuses();
      expect(statuses.size).toBeGreaterThan(0);
    });
  });
});

describe('RPC Validation', () => {
  describe('validateRPCEndpoint', () => {
    test('should validate valid devnet endpoint', async () => {
      const result = await validateRPCEndpoint(
        'https://api.devnet.solana.com',
        10000
      );
      
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
      expect(result.metadata?.version).toBeDefined();
    }, 15000);

    test('should reject invalid URL', async () => {
      const result = await validateRPCEndpoint('not-a-url');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Invalid URL');
    });

    test('should timeout on unreachable endpoint', async () => {
      const result = await validateRPCEndpoint(
        'https://nonexistent.endpoint.invalid',
        2000
      );
      
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }, 5000);

    test('should warn on high latency', async () => {
      // This might pass or fail depending on network conditions
      const result = await validateRPCEndpoint(
        'https://api.devnet.solana.com',
        10000
      );
      
      if (result.metadata && result.metadata.latencyMs && result.metadata.latencyMs > 5000) {
        expect(result.warnings.some(w => w.includes('High latency'))).toBe(true);
      }
    }, 15000);
  });

  describe('Error Parsing', () => {
    test('should parse timeout errors', () => {
      const error = new Error('Request timeout');
      const rpcError = parseRPCError(error, 'https://test.com');
      
      expect(rpcError.code).toBe(RPCErrorCode.TIMEOUT);
      expect(rpcError.retryable).toBe(true);
    });

    test('should parse rate limit errors', () => {
      const error = new Error('429 Too Many Requests');
      const rpcError = parseRPCError(error, 'https://test.com');
      
      expect(rpcError.code).toBe(RPCErrorCode.RATE_LIMITED);
      expect(rpcError.retryable).toBe(true);
    });

    test('should parse unauthorized errors', () => {
      const error = new Error('401 Unauthorized');
      const rpcError = parseRPCError(error, 'https://test.com');
      
      expect(rpcError.code).toBe(RPCErrorCode.UNAUTHORIZED);
      expect(rpcError.retryable).toBe(false);
    });

    test('should parse connection errors', () => {
      const error = new Error('ECONNREFUSED');
      const rpcError = parseRPCError(error, 'https://test.com');
      
      expect(rpcError.code).toBe(RPCErrorCode.CONNECTION_FAILED);
      expect(rpcError.retryable).toBe(true);
    });
  });

  describe('Retry Logic', () => {
    test('should succeed on first attempt', async () => {
      let attempts = 0;
      const operation = async () => {
        attempts++;
        return 'success';
      };

      const result = await retryRPCOperation(operation, 3, 100, 'test');
      expect(result).toBe('success');
      expect(attempts).toBe(1);
    });

    test('should retry on failure and succeed', async () => {
      let attempts = 0;
      const operation = async () => {
        attempts++;
        if (attempts < 2) {
          throw new Error('Temporary failure');
        }
        return 'success';
      };

      const result = await retryRPCOperation(operation, 3, 100, 'test');
      expect(result).toBe('success');
      expect(attempts).toBe(2);
    }, 10000);

    test('should fail after max retries', async () => {
      let attempts = 0;
      const operation = async () => {
        attempts++;
        throw new Error('Permanent failure');
      };

      await expect(
        retryRPCOperation(operation, 3, 100, 'test')
      ).rejects.toThrow('Permanent failure');
      
      expect(attempts).toBe(3);
    }, 10000);

    test('should not retry non-retryable errors', async () => {
      let attempts = 0;
      const operation = async () => {
        attempts++;
        throw new Error('401 Unauthorized');
      };

      await expect(
        retryRPCOperation(operation, 3, 100, 'test')
      ).rejects.toThrow();
      
      expect(attempts).toBe(1); // Should not retry
    });
  });
});

describe('RPC Metrics Tracker', () => {
  let tracker: RPCMetricsTracker;

  beforeEach(() => {
    tracker = new RPCMetricsTracker();
  });

  test('should record successful calls', () => {
    tracker.recordSuccess('https://test.com', 100);
    tracker.recordSuccess('https://test.com', 200);

    const metrics = tracker.getMetrics('https://test.com');
    expect(metrics?.totalCalls).toBe(2);
    expect(metrics?.successfulCalls).toBe(2);
    expect(metrics?.failedCalls).toBe(0);
    expect(metrics?.averageLatencyMs).toBe(150);
    expect(metrics?.successRate).toBe(1);
  });

  test('should record failed calls', () => {
    const error = {
      code: RPCErrorCode.TIMEOUT,
      message: 'Timeout',
      endpoint: 'https://test.com',
      timestamp: Date.now(),
      retryable: true,
    };

    tracker.recordFailure('https://test.com', error);

    const metrics = tracker.getMetrics('https://test.com');
    expect(metrics?.totalCalls).toBe(1);
    expect(metrics?.successfulCalls).toBe(0);
    expect(metrics?.failedCalls).toBe(1);
    expect(metrics?.successRate).toBe(0);
  });

  test('should calculate success rate', () => {
    tracker.recordSuccess('https://test.com', 100);
    tracker.recordSuccess('https://test.com', 100);
    tracker.recordFailure('https://test.com', {
      code: RPCErrorCode.TIMEOUT,
      message: 'Timeout',
      endpoint: 'https://test.com',
      timestamp: Date.now(),
      retryable: true,
    });

    const metrics = tracker.getMetrics('https://test.com');
    expect(metrics?.totalCalls).toBe(3);
    expect(metrics?.successRate).toBeCloseTo(0.667, 2);
  });

  test('should track multiple endpoints', () => {
    tracker.recordSuccess('https://endpoint1.com', 100);
    tracker.recordSuccess('https://endpoint2.com', 200);

    const allMetrics = tracker.getAllMetrics();
    expect(allMetrics.size).toBe(2);
    expect(allMetrics.get('https://endpoint1.com')).toBeDefined();
    expect(allMetrics.get('https://endpoint2.com')).toBeDefined();
  });

  test('should reset metrics', () => {
    tracker.recordSuccess('https://test.com', 100);
    tracker.reset();

    const metrics = tracker.getMetrics('https://test.com');
    expect(metrics).toBeNull();
  });

  test('should limit stored errors to 10', () => {
    for (let i = 0; i < 15; i++) {
      tracker.recordFailure('https://test.com', {
        code: RPCErrorCode.TIMEOUT,
        message: `Error ${i}`,
        endpoint: 'https://test.com',
        timestamp: Date.now(),
        retryable: true,
      });
    }

    const metrics = tracker.getMetrics('https://test.com');
    expect(metrics?.errors.length).toBe(10);
  });
});
