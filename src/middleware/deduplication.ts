/**
 * Request Deduplication Middleware
 * Prevents duplicate requests from being processed multiple times
 * Useful for preventing accidental double-claims from frontend retries
 */

interface InFlightRequest {
  response: any;
  timestamp: number;
  status: 'pending' | 'completed';
}

class RequestDeduplicator {
  private inFlightRequests: Map<string, InFlightRequest> = new Map();
  private readonly TTL_MS = 60000; // 60 seconds

  /**
   * Generate a unique key for a request
   * Based on wallet + endpoint + request body
   */
  private generateKey(wallet: string, endpoint: string, body: any): string {
    const bodyStr = JSON.stringify(body || {});
    return `${wallet}:${endpoint}:${bodyStr}`;
  }

  /**
   * Check if request is already in flight
   */
  isInFlight(wallet: string, endpoint: string, body: any): boolean {
    const key = this.generateKey(wallet, endpoint, body);
    const request = this.inFlightRequests.get(key);

    if (!request) {
      return false;
    }

    // Check if expired
    if (Date.now() - request.timestamp > this.TTL_MS) {
      this.inFlightRequests.delete(key);
      return false;
    }

    return request.status === 'pending';
  }

  /**
   * Get cached response for duplicate request
   */
  getCachedResponse(wallet: string, endpoint: string, body: any): any {
    const key = this.generateKey(wallet, endpoint, body);
    const request = this.inFlightRequests.get(key);

    if (request && request.status === 'completed') {
      return request.response;
    }

    return null;
  }

  /**
   * Mark request as in-flight
   */
  markInFlight(wallet: string, endpoint: string, body: any): void {
    const key = this.generateKey(wallet, endpoint, body);
    this.inFlightRequests.set(key, {
      response: null,
      timestamp: Date.now(),
      status: 'pending',
    });
  }

  /**
   * Mark request as completed and cache response
   */
  markCompleted(wallet: string, endpoint: string, body: any, response: any): void {
    const key = this.generateKey(wallet, endpoint, body);
    this.inFlightRequests.set(key, {
      response,
      timestamp: Date.now(),
      status: 'completed',
    });
  }

  /**
   * Clear expired entries
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, request] of this.inFlightRequests.entries()) {
      if (now - request.timestamp > this.TTL_MS) {
        this.inFlightRequests.delete(key);
      }
    }
  }

  /**
   * Get cache size (for monitoring)
   */
  size(): number {
    return this.inFlightRequests.size;
  }
}

// Export singleton instance
export const deduplicator = new RequestDeduplicator();

/**
 * Express middleware for request deduplication
 * SECURITY: Prevents duplicate claim requests from being processed
 */
export function deduplicationMiddleware(req: any, res: any, next: any) {
  const wallet = req.body?.userWallet;
  const endpoint = req.path;

  if (!wallet) {
    return next();
  }

  // Check if request is already in flight
  if (deduplicator.isInFlight(wallet, endpoint, req.body)) {
    console.log(`[DEDUP] ⚠️ Duplicate request blocked from ${wallet} on ${endpoint}`);
    return res.status(429).json({
      error: 'Duplicate request detected',
      message: 'A request with the same parameters is already being processed. Please wait.',
    });
  }

  // Check for cached response (recently completed request)
  const cachedResponse = deduplicator.getCachedResponse(wallet, endpoint, req.body);
  if (cachedResponse) {
    console.log(`[DEDUP] 📦 Returning cached response for ${wallet} on ${endpoint}`);
    return res.status(200).json(cachedResponse);
  }

  // Mark request as in-flight
  deduplicator.markInFlight(wallet, endpoint, req.body);
  console.log(`[DEDUP] ✓ New request from ${wallet} on ${endpoint}`);

  // Override res.json to cache the response
  const originalJson = res.json.bind(res);
  res.json = function(data: any) {
    // Cache successful responses only
    if (res.statusCode >= 200 && res.statusCode < 300) {
      deduplicator.markCompleted(wallet, endpoint, req.body, data);
    }
    return originalJson(data);
  };

  next();
}

// Cleanup expired entries every minute
setInterval(() => {
  deduplicator.cleanup();
  const size = deduplicator.size();
  if (size > 0) {
    console.log(`[DEDUP] Cache size: ${size} entries`);
  }
}, 60000);
