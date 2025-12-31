import { Request, Response } from 'express';
import { getSupabaseClient } from '../lib/supabaseClient';
import { getConnection } from '../config';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

export class ProjectController {

  /**
   * GET /api/projects
   * List projects accessible to the connected wallet
   * Requires wallet parameter to filter by user access
   * OPTIMIZED: Uses single JOIN query instead of two sequential queries
   */
  async listProjects(req: Request, res: Response) {
    try {
      const supabase = getSupabaseClient();
      const walletAddress = req.query.wallet as string;

      // If wallet provided, filter by user access
      if (walletAddress) {
        // Get projects where user has access with retry logic for transient network errors
        let accessRecords = null;
        let accessError = null;
        let retries = 3;
        
        while (retries > 0 && !accessRecords) {
          const result = await supabase
            .from('user_project_access')
            .select('project_id')
            .eq('wallet_address', walletAddress);
          
          accessRecords = result.data;
          accessError = result.error;
          
          if (accessError && retries > 1) {
            console.warn(`Retry attempt ${4 - retries} for user access fetch...`);
            await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms before retry
            retries--;
          } else {
            break;
          }
        }

        if (accessError) {
          console.error('Failed to fetch user access records:', accessError);
          throw accessError;
        }

        if (!accessRecords || accessRecords.length === 0) {
          // User has no projects yet
          return res.json([]);
        }

        const projectIds = accessRecords.map(record => record.project_id);

        // Get project details for accessible projects
        const { data: projects, error: projectsError } = await supabase
          .from('projects')
          .select('id, name, symbol, mint_address, logo_url, is_active, vault_public_key')
          .in('id', projectIds)
          .eq('is_active', true)
          .order('name');

        if (projectsError) {
          console.error('Failed to fetch projects:', projectsError);
          throw projectsError;
        }

        return res.json(projects || []);
      }

      // No wallet provided - return empty array (require authentication)
      res.json([]);
    } catch (error) {
      console.error('Failed to list projects:', error);
      res.status(500).json({ error: 'Failed to list projects' });
    }
  }

  /**
   * GET /api/projects/:id
   * Get project details and refresh live balance
   * SECURITY: Public endpoint - anyone can view project details
   * This is intentional as projects are public information
   */
  async getProjectDetails(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const supabase = getSupabaseClient();
      const connection = getConnection();

      // Get project details (public information)
      const { data: project, error } = await supabase
        .from('projects')
        .select('id, name, symbol, mint_address, logo_url, description, website_url, is_active, claim_fee_lamports, vault_public_key, vault_balance_sol, vault_balance_token')
        .eq('id', id)
        .single();

      if (error) {
        throw error;
      }

      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      // OPTIMIZATION: Fetch vesting progress data in parallel with live balance
      const [vestingProgressData] = await Promise.all([
        // Get vesting progress aggregates
        (async () => {
          try {
            // Get all active pools for this project
            const { data: pools } = await supabase
              .from('vesting_streams')
              .select('id, total_pool_amount, start_time, end_time, vesting_duration_seconds')
              .eq('project_id', id)
              .eq('is_active', true);

            if (!pools || pools.length === 0) {
              return { totalAllocated: 0, totalClaimed: 0, totalVested: 0, vestingProgress: 0 };
            }

            const poolIds = pools.map(p => p.id);

            // Batch fetch vestings and claims
            const [vestingsData, claimsData] = await Promise.all([
              supabase
                .from('vestings')
                .select('token_amount, vesting_stream_id')
                .in('vesting_stream_id', poolIds)
                .eq('is_active', true),
              supabase
                .from('claim_history')
                .select('amount_claimed, vesting_id')
                .eq('project_id', id)
            ]);

            // Calculate totals
            const totalAllocated = vestingsData.data?.reduce((sum: number, v: any) => 
              sum + Number(v.token_amount), 0) || 0;

            // Convert claims from base units (need to divide by 10^9)
            const totalClaimedRaw = claimsData.data?.reduce((sum: number, c: any) => 
              sum + Number(c.amount_claimed), 0) || 0;
            const totalClaimed = totalClaimedRaw / 1e9; // Convert from base units

            // Calculate vested amount based on time elapsed
            const now = Date.now();
            let totalVested = 0;

            pools.forEach(pool => {
              const startTime = new Date(pool.start_time).getTime();
              const endTime = new Date(pool.end_time).getTime();
              const duration = endTime - startTime;
              
              if (now < startTime) {
                // Not started yet
                return;
              } else if (now >= endTime) {
                // Fully vested
                totalVested += pool.total_pool_amount;
              } else {
                // Partially vested
                const elapsed = now - startTime;
                const vestedPercentage = Math.min(1, elapsed / duration);
                totalVested += pool.total_pool_amount * vestedPercentage;
              }
            });

            const vestingProgress = totalAllocated > 0 ? (totalVested / totalAllocated) * 100 : 0;

            return {
              totalAllocated,
              totalClaimed,
              totalVested,
              vestingProgress: Math.min(100, Math.round(vestingProgress * 100) / 100)
            };
          } catch (err) {
            console.warn('Failed to fetch vesting progress:', err);
            return { totalAllocated: 0, totalClaimed: 0, totalVested: 0, vestingProgress: 0 };
          }
        })(),
        // Live Balance Check (On-Chain)
        (async () => {
          if (project.vault_public_key) {
            try {
              const vaultPubkey = new PublicKey(project.vault_public_key);
              const solBalance = await connection.getBalance(vaultPubkey);
              const solBalanceFormatted = solBalance / LAMPORTS_PER_SOL;

              // Update DB if balance changed significantly (> 0.0001 SOL diff)
              if (Math.abs(solBalanceFormatted - (project.vault_balance_sol || 0)) > 0.0001) {
                await supabase
                  .from('projects')
                  .update({ vault_balance_sol: solBalanceFormatted })
                  .eq('id', id);

                project.vault_balance_sol = solBalanceFormatted;
              }
            } catch (balErr) {
              console.warn(`Failed to fetch live balance for project ${id}:`, balErr);
            }
          }
        })()
      ]);

      // Add vesting progress to response
      res.json({
        ...project,
        vestingProgress: vestingProgressData
      });
    } catch (error) {
      console.error('Failed to get project details:', error);
      res.status(500).json({ error: 'Failed to get project details' });
    }
  }

  /**
   * PUT /api/projects/:id
   * Update project details (e.g. mint address)
   * SECURITY: Should verify user has access to this project
   * Note: This endpoint should be protected by adminAuth middleware
   */
  async updateProject(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { mint_address, logo_url, description, website_url } = req.body;
      const supabase = getSupabaseClient();

      // SECURITY NOTE: This endpoint should be protected by requireAdmin middleware
      // which verifies the user has owner/admin role for this project
      // The middleware should have already checked access before this runs

      const updates: any = {};
      if (mint_address !== undefined) updates.mint_address = mint_address;
      if (logo_url !== undefined) updates.logo_url = logo_url;
      if (description !== undefined) updates.description = description;
      if (website_url !== undefined) updates.website_url = website_url;

      // Update project (middleware should have already verified access)
      const { data: project, error } = await supabase
        .from('projects')
        .update(updates)
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;

      res.json(project);
    } catch (error) {
      console.error('Failed to update project:', error);
      res.status(500).json({ error: 'Failed to update project' });
    }
  }
}
