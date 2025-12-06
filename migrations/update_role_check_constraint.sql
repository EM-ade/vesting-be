-- Update role check constraint to include 'owner'
ALTER TABLE user_project_access DROP CONSTRAINT IF EXISTS user_project_access_role_check;
ALTER TABLE user_project_access ADD CONSTRAINT user_project_access_role_check CHECK (role IN ('owner', 'admin', 'viewer'));
