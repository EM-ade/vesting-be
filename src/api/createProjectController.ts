import { Request, Response } from 'express';
import { getSupabaseClient } from '../lib/supabaseClient';
import { createProjectVault } from '../services/vaultService';

export class CreateProjectController {
  
  /**
   * POST /api/projects
   * Create a new project
   */
  async createProject(req: Request, res: Response) {
    try {
      const { name, symbol, logo_url, description, wallet_address } = req.body;

      if (!name || !symbol || !wallet_address) {
        return res.status(400).json({ error: 'Name, symbol, and wallet_address are required' });
      }

      const supabase = getSupabaseClient();

      // 0. Ensure User Exists
      // Upsert user into auth_users to get UUID
      let userId: string;
      
      const { data: user, error: userError } = await supabase
        .from('auth_users')
        .select('id')
        .eq('wallet_address', wallet_address)
        .single();

      if (user) {
        userId = user.id;
      } else {
        // Create new user
        const { data: newUser, error: createError } = await supabase
          .from('auth_users')
          .insert({ wallet_address })
          .select('id')
          .single();
          
        if (createError || !newUser) {
           // Fallback: if auth_users table missing (migration didn't run), generate a random UUID
           // forcing the insert to rely on maybe DB trigger or just fail if FK constraint exists.
           // But user_project_access has user_id NOT NULL.
           // If migration 'add_auth_users' ran, auth_users exists.
           console.error('Failed to create/find user:', createError);
           throw new Error('Failed to register user for project ownership');
        }
        userId = newUser.id;
      }

      // 1. Create Project
      const { data: project, error: projectError } = await supabase
        .from('projects')
        .insert({
          name,
          symbol,
          logo_url,
          description,
          mint_address: '', // Can be updated later
          is_active: true
        })
        .select('id')
        .single();

      if (projectError) {
        throw new Error(`Failed to create project: ${projectError.message}`);
      }

      const projectId = project.id;

      // 2. Generate Vault
      try {
        await createProjectVault(projectId);
      } catch (vaultError) {
        console.error('Failed to generate vault:', vaultError);
        // We don't rollback project here, but maybe we should log it or return a warning
        // But the onboarding modal will handle missing vault by showing "Generating..." or letting user regenerate.
        // Actually, if vault generation fails, the onboarding modal will be stuck on "Generating..." forever.
        // We should probably throw here to inform the user.
        throw new Error(`Failed to generate vault: ${vaultError instanceof Error ? vaultError.message : 'Unknown error'}`);
      }

      // 3. Assign Owner Role
      const { error: accessError } = await supabase
        .from('user_project_access')
        .insert({
          project_id: projectId,
          user_id: userId,
          wallet_address: wallet_address,
          role: 'owner'
        });

      if (accessError) {
        // Rollback project creation if possible, or just log error
        console.error('Failed to assign owner:', accessError);
        // Ideally we should delete the project here to keep DB clean
        await supabase.from('projects').delete().eq('id', projectId);
        throw new Error(`Failed to assign project owner: ${accessError.message}`);
      }

      res.status(201).json({
        success: true,
        projectId: projectId,
        message: 'Project created successfully'
      });

    } catch (error) {
      console.error('Create project error:', error);
      res.status(500).json({ 
        error: error instanceof Error ? error.message : 'Unknown error occurred' 
      });
    }
  }
}
