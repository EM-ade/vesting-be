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
        // Get projects where user has access (use two queries for now - JOIN syntax might vary by Supabase version)
        const { data: accessRecords, error: accessError } = await supabase
          .from('user_project_access')
          .select('project_id')
          .eq('wallet_address', walletAddress);

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

      // Live Balance Check (On-Chain)
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

      res.json(project);
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
