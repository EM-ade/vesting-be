import { Request, Response, NextFunction } from 'express';
import { getSupabaseClient } from '../lib/supabaseClient';

// Extend Express Request to include project data
declare global {
  namespace Express {
    interface Request {
      project?: any;
      projectId?: string;
      userProjectRole?: string;
    }
  }
}

export const projectContextMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  // Allow public routes or admin routes that might not have project context yet
  // But if x-project-id is present, we try to load it.
  const projectId = (req.headers['x-project-id'] as string) || (req.query.projectId as string);
  
  if (!projectId) {
    // If no project ID, we just continue. Some routes might not need it.
    // Routes that strictly require it should check if req.projectId is set.
    return next();
  }

  try {
    const supabase = getSupabaseClient();
    const { data: project, error } = await supabase
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (error || !project) {
      // If project ID was provided but invalid, we should probably error out?
      // Or just ignore? Safer to error if client explicitly sent a project ID.
      return res.status(404).json({ error: 'Project not found' });
    }

    req.project = project;
    req.projectId = projectId;

    // Check if user has access to this project (if user is authenticated)
    // req.user should be set by auth middleware (if it runs before this)
    // Assuming Supabase Auth middleware puts user in req.user
    /*
    const userId = (req as any).user?.id;
    if (userId) {
      const { data: access } = await supabase
        .from('user_project_access')
        .select('role')
        .eq('user_id', userId)
        .eq('project_id', projectId)
        .single();

      if (access) {
        req.userProjectRole = access.role;
      }
    }
    */

    next();
  } catch (error) {
    console.error('Project context error:', error);
    res.status(500).json({ error: 'Invalid project context' });
  }
};
