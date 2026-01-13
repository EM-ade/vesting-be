/**
 * Token Metadata Service
 * Dynamically fetches token metadata from Helius DAS API for ANY token
 */

import { getRPCConfig } from '../config';

interface HeliusTokenMetadata {
  symbol?: string;
  name?: string;
  decimals?: number;
}

interface TokenMetadata {
  symbol: string;
  name: string;
  decimals: number;
}

// Cache for token metadata to avoid repeated API calls
const tokenMetadataCache: Map<string, { metadata: TokenMetadata; timestamp: number }> = new Map();
const CACHE_DURATION = 60 * 60 * 1000; // 1 hour

/**
 * Fetch token metadata using Helius DAS API (supports all token types)
 * This works for ANY token on Solana, not just a hardcoded list
 */
export async function fetchTokenMetadata(mintAddress: string): Promise<TokenMetadata> {
  // Check cache first
  const cached = tokenMetadataCache.get(mintAddress);
  const now = Date.now();
  
  if (cached && now - cached.timestamp < CACHE_DURATION) {
    return cached.metadata;
  }

  try {
    const heliusUrl = getRPCConfig().getRPCEndpoint();
    
    const response = await fetch(heliusUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'token-metadata',
        method: 'getAsset',
        params: {
          id: mintAddress,
          displayOptions: {
            showFungible: true // Important for SPL tokens
          }
        }
      })
    });

    if (response.ok) {
      const data = await response.json() as any;
      const result = data.result;
      
      // Extract metadata from various possible locations
      const symbol = result?.content?.metadata?.symbol || 
                    result?.token_info?.symbol ||
                    result?.content?.metadata?.name?.split(' ')[0] ||
                    `${mintAddress.slice(0, 4)}...${mintAddress.slice(-4)}`;
      
      const name = result?.content?.metadata?.name || 
                   result?.token_info?.name ||
                   'Unknown Token';
      
      const decimals = result?.token_info?.decimals || 
                       result?.content?.metadata?.decimals || 
                       9;
      
      const metadata: TokenMetadata = { symbol, name, decimals };
      
      // Cache the result
      tokenMetadataCache.set(mintAddress, { metadata, timestamp: now });
      
      console.log(`[TOKEN METADATA] Fetched ${mintAddress}: ${symbol}`);
      return metadata;
    }
  } catch (err) {
    console.error(`[TOKEN METADATA] Failed to fetch for ${mintAddress}:`, err);
  }
  
  // Fallback: return shortened address
  const fallbackMetadata: TokenMetadata = {
    symbol: `${mintAddress.slice(0, 4)}...${mintAddress.slice(-4)}`,
    name: 'Unknown Token',
    decimals: 9,
  };
  
  // Cache fallback too (but with shorter duration)
  tokenMetadataCache.set(mintAddress, { 
    metadata: fallbackMetadata, 
    timestamp: now - CACHE_DURATION + 60000 // Expire in 1 minute for fallbacks
  });
  
  return fallbackMetadata;
}

/**
 * Get token symbol by mint address (cached)
 * This replaces the hardcoded token registry
 */
export async function getTokenSymbol(mintAddress: string): Promise<string> {
  const metadata = await fetchTokenMetadata(mintAddress);
  return metadata.symbol;
}

/**
 * Batch fetch token metadata for multiple mints
 */
export async function fetchTokenMetadataBatch(mintAddresses: string[]): Promise<Map<string, TokenMetadata>> {
  const results = new Map<string, TokenMetadata>();
  
  // Fetch in parallel
  const promises = mintAddresses.map(async (mint) => {
    const metadata = await fetchTokenMetadata(mint);
    results.set(mint, metadata);
  });
  
  await Promise.all(promises);
  
  return results;
}

/**
 * Clear the metadata cache (useful for testing)
 */
export function clearTokenMetadataCache(): void {
  tokenMetadataCache.clear();
}
