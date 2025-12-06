-- Backfill project_id for existing vesting_streams and vestings
-- This assumes there's at least one project in the database

DO $$
DECLARE
    default_project_id UUID;
BEGIN
    -- Get the first project ID (or create a default one if none exists)
    SELECT id INTO default_project_id FROM projects LIMIT 1;
    
    -- If no project exists, create a default one
    IF default_project_id IS NULL THEN
        INSERT INTO projects (name, symbol, mint_address, description)
        VALUES (
            'Lil Gargs',
            'GARG',
            'COALESCE((SELECT token_mint FROM config LIMIT 1), ''EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'')',
            'Default project for existing vesting pools'
        )
        RETURNING id INTO default_project_id;
        
        RAISE NOTICE 'Created default project with ID: %', default_project_id;
    END IF;
    
    -- Update vesting_streams that don't have a project_id
    UPDATE vesting_streams
    SET project_id = default_project_id
    WHERE project_id IS NULL;
    
    RAISE NOTICE 'Updated % vesting_streams', (SELECT COUNT(*) FROM vesting_streams WHERE project_id = default_project_id);
    
    -- Update vestings that don't have a project_id
    UPDATE vestings
    SET project_id = default_project_id
    WHERE project_id IS NULL;
    
    RAISE NOTICE 'Updated % vestings', (SELECT COUNT(*) FROM vestings WHERE project_id = default_project_id);
    
    -- Update claim_history that doesn't have a project_id
    UPDATE claim_history
    SET project_id = default_project_id
    WHERE project_id IS NULL;
    
    RAISE NOTICE 'Updated % claim_history records', (SELECT COUNT(*) FROM claim_history WHERE project_id = default_project_id);
END $$;
