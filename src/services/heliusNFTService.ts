import { PublicKey } from '@solana/web3.js';

/**
 * Helius NFT Service
 * Uses Helius DAS API to detect NFT holders and count NFTs
 */
export class HeliusNFTService {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, network: 'devnet' | 'mainnet-beta' = 'devnet') {
    this.apiKey = apiKey;
    // Use correct Helius RPC endpoints - ensure no double slash or query params
    const domain = network === 'mainnet-beta' ? 'mainnet.helius-rpc.com' : 'devnet.helius-rpc.com';
    this.baseUrl = `https://${domain}`;
  }

  /**
   * Retry helper with exponential backoff
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    initialDelay: number = 1000
  ): Promise<T> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        
        if (attempt < maxRetries - 1) {
          const delay = initialDelay * Math.pow(2, attempt);
          console.log(`  ⏳ Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw lastError;
  }

  /**
   * Get all holders of an NFT collection
   * FIXED: Improved pagination logic with proper cursor handling and rate limiting
   */
  async getAllHolders(collectionAddress: PublicKey): Promise<Array<{ wallet: string; nftCount: number }>> {
    try {
      let page = 1;
      let allAssets: any[] = [];
      let hasMore = true;
      const collectionAddr = collectionAddress.toBase58();
      
      console.log(`   🔍 Fetching holders for collection: ${collectionAddr}`);

      // Fetch all pages using Helius DAS API
      while (hasMore) {
        // Add delay between requests to avoid rate limiting (except first page)
        if (page > 1) {
          await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay between pages
        }

        const response = await this.retryWithBackoff(async () => {
          // Correctly append API key here
          const url = `${this.baseUrl}/?api-key=${this.apiKey}`;
          return await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: `get-assets-page-${page}`,
              method: 'getAssetsByGroup',
              params: {
                groupKey: 'collection',
                groupValue: collectionAddr,
                page: page,
                limit: 1000,
                displayOptions: {
                  showCollectionMetadata: false,
                },
              },
            }),
          });
        }, 5, 2000); // Increased to 5 retries for better reliability

        if (!response.ok) {
          const errorText = await response.text();
          console.error('Helius API error:', response.status, errorText);
          throw new Error(`Helius API error: ${response.statusText} - ${errorText}`);
        }

        const data: any = await response.json();
        
        if (data.error) {
          console.error('Helius RPC error:', data.error);
          throw new Error(`Helius RPC error: ${data.error.message || JSON.stringify(data.error)}`);
        }
        
        const assets = data.result?.items || [];
        const total = data.result?.total;
        
        // Log sample asset structure on first page for debugging
        if (page === 1 && assets.length > 0) {
          console.log('   🔍 Sample asset structure:', {
            id: assets[0].id,
            ownership: assets[0].ownership,
            owner: assets[0].owner,
            ownerAddress: assets[0].ownerAddress,
            hasOwnership: !!assets[0].ownership,
            hasOwner: !!assets[0].owner,
            hasOwnerAddress: !!assets[0].ownerAddress,
          });
          if (total !== undefined) {
            console.log(`   📊 Total assets in collection: ${total}`);
          }
        }
        
        if (assets.length === 0) {
          hasMore = false;
          if (page === 1) {
            console.warn(`   ⚠️  No assets found on first page for collection ${collectionAddr}`);
          }
        } else {
          allAssets = allAssets.concat(assets);
          console.log(`   📄 Page ${page}: Fetched ${assets.length} assets (total: ${allAssets.length}${total !== undefined ? `/${total}` : ''})`);
          
          // IMPORTANT: Don't trust the 'total' field - keep fetching until we get < 1000
          // The API sometimes caps 'total' at 1000 even if there are more assets
          if (assets.length < 1000) {
            // If we got less than 1000, we're on the last page
            hasMore = false;
            console.log(`   ✅ Reached last page (got ${assets.length} < 1000)`);
          } else {
            // Got exactly 1000, there might be more
            page++;
            console.log(`   ➡️  Moving to page ${page} (got full page of 1000)`);
          }
        }
      }
      
      // Group by owner with improved ownership detection
      const holderMap = new Map<string, number>();
      let skippedAssets = 0;
      let burnedAssets = 0;
      const BURN_ADDRESSES = [
        '1nc1nerator11111111111111111111111111111111',
        '11111111111111111111111111111111',
      ];
      
      for (const asset of allAssets) {
        // Try multiple ownership structures that Helius might return
        const owner = asset.ownership?.owner || asset.owner || asset.ownerAddress;
        
        if (owner) {
          // Skip burned NFTs
          if (BURN_ADDRESSES.includes(owner)) {
            burnedAssets++;
            continue;
          }
          
          holderMap.set(owner, (holderMap.get(owner) || 0) + 1);
        } else {
          skippedAssets++;
          // Log first few skipped assets for debugging
          if (skippedAssets <= 3) {
            console.warn('   ⚠️ Skipped asset with missing owner:', {
              id: asset.id,
              ownership: asset.ownership,
              owner: asset.owner,
              ownerAddress: asset.ownerAddress,
            });
          }
        }
      }

      if (skippedAssets > 0) {
        console.warn(`   ⚠️ Warning: Skipped ${skippedAssets} assets with missing ownership data`);
      }
      
      if (burnedAssets > 0) {
        console.log(`   🔥 Filtered out ${burnedAssets} burned assets`);
      }

      console.log(`   ✅ Fetched ${allAssets.length} NFTs from collection (${holderMap.size} unique holders, ${skippedAssets} skipped, ${burnedAssets} burned)`);

      // Convert to array and sort by NFT count (descending) for consistency
      return Array.from(holderMap.entries())
        .map(([wallet, nftCount]) => ({
          wallet,
          nftCount,
        }))
        .sort((a, b) => b.nftCount - a.nftCount);
    } catch (error) {
      console.error('Failed to get holders from Helius:', error);
      throw error;
    }
  }


  /**
   * Count NFTs owned by a wallet from specific collections
   */
  async countNFTsFromCollections(
    wallet: PublicKey,
    collections: PublicKey[]
  ): Promise<Map<string, number>> {
    try {
      const url = `${this.baseUrl}/?api-key=${this.apiKey}`;
      
      // Fetch ALL pages of NFTs for this wallet
      let page = 1;
      let allNfts: any[] = [];
      let hasMore = true;

      while (hasMore) {
        const response = await this.retryWithBackoff(async () => {
          return await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: `nft-by-owner-page-${page}`,
              method: 'getAssetsByOwner',
              params: {
                ownerAddress: wallet.toBase58(),
                page: page,
                limit: 1000,
              },
            }),
          });
        }, 3, 2000);

        if (!response.ok) {
          throw new Error(`Helius API error: ${response.statusText}`);
        }

        const data: any = await response.json();
        const nfts = data.result?.items || [];
        
        if (nfts.length === 0) {
          hasMore = false;
        } else {
          allNfts = allNfts.concat(nfts);
          page++;
          
          // If we got less than 1000, we're done
          if (nfts.length < 1000) {
            hasMore = false;
          }
        }
      }

      console.log(`   📊 Fetched ${allNfts.length} total NFTs for wallet ${wallet.toBase58().substring(0, 8)}...`);

      // Count NFTs per collection
      const collectionCounts = new Map<string, number>();
      
      for (const collection of collections) {
        const collectionAddr = collection.toBase58();
        const count = allNfts.filter((nft: any) => {
          return nft.grouping?.some((g: any) => 
            g.group_key === 'collection' && g.group_value === collectionAddr
          );
        }).length;
        
        collectionCounts.set(collectionAddr, count);
      }

      return collectionCounts;
    } catch (error) {
      console.error('Failed to count NFTs:', error);
      throw error;
    }
  }

  /**
   * Count total NFTs owned by a wallet (from any collection)
   */
  async countAllNFTs(wallet: PublicKey): Promise<number> {
    try {
      const url = `${this.baseUrl}/?api-key=${this.apiKey}`;
      
      // Fetch ALL pages of NFTs for this wallet
      let page = 1;
      let totalCount = 0;
      let hasMore = true;

      while (hasMore) {
        const response = await this.retryWithBackoff(async () => {
          return await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: `nft-count-page-${page}`,
              method: 'getAssetsByOwner',
              params: {
                ownerAddress: wallet.toBase58(),
                page: page,
                limit: 1000,
              },
            }),
          });
        }, 3, 2000);

        if (!response.ok) {
          throw new Error(`Helius API error: ${response.statusText}`);
        }

        const data: any = await response.json();
        const nfts = data.result?.items || [];
        
        if (nfts.length === 0) {
          hasMore = false;
        } else {
          totalCount += nfts.length;
          page++;
          
          // If we got less than 1000, we're done
          if (nfts.length < 1000) {
            hasMore = false;
          }
        }
      }

      console.log(`   📊 Total NFT count for wallet ${wallet.toBase58().substring(0, 8)}...: ${totalCount}`);
      return totalCount;
    } catch (error) {
      console.error('Failed to count all NFTs:', error);
      throw error;
    }
  }

  /**
   * Check if wallet meets NFT requirements for a vesting stream
   */
  async checkEligibility(
    wallet: PublicKey,
    requirements: Array<{ collection: string; min_nfts: number; tier: number }>
  ): Promise<{ eligible: boolean; tier: number | null; nftCounts: Record<string, number> }> {
    try {
      const collections = requirements.map((r) => new PublicKey(r.collection));
      const collectionCounts = await this.countNFTsFromCollections(wallet, collections);

      const nftCounts: Record<string, number> = {};
      let highestTier: number | null = null;

      // Check each requirement
      for (const req of requirements) {
        const count = collectionCounts.get(req.collection) || 0;
        nftCounts[req.collection] = count;

        // If meets requirement, update highest tier
        if (count >= req.min_nfts) {
          if (highestTier === null || req.tier > highestTier) {
            highestTier = req.tier;
          }
        }
      }

      return {
        eligible: highestTier !== null,
        tier: highestTier,
        nftCounts,
      };
    } catch (error) {
      console.error('Failed to check eligibility:', error);
      throw error;
    }
  }
}
