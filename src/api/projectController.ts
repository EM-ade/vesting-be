import { Request, Response } from 'express';
import { getSupabaseClient } from '../lib/supabaseClient';
import { getConnection } from '../config';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

export class ProjectController {
  
  /**
   * GET /api/projects
   * List all available projects
   * Public endpoint
   */
  async listProjects(req: Request, res: Response) {
    try {
      const supabase = getSupabaseClient();
      
      // TODO: Should this be public? For now yes, to allow project selection.
      const { data: projects, error } = await supabase
        .from('projects')
        .select('id, name, symbol, mint_address, logo_url, is_active')
        .eq('is_active', true)
        .order('name');

      if (error) {
        throw error;
      }

      res.json(projects || []);
    } catch (error) {
      console.error('Failed to list projects:', error);
      res.status(500).json({ error: 'Failed to list projects' });
    }
  }

  /**
   * GET /api/projects/:id
   * Get project details and refresh live balance
   */
  async getProjectDetails(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const supabase = getSupabaseClient();
      const connection = getConnection();
      
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
   */
  async updateProject(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const { mint_address, logo_url, description, website_url } = req.body;
      const supabase = getSupabaseClient();

      const updates: any = {};
      if (mint_address !== undefined) updates.mint_address = mint_address;
      if (logo_url !== undefined) updates.logo_url = logo_url;
      if (description !== undefined) updates.description = description;
      if (website_url !== undefined) updates.website_url = website_url;

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
