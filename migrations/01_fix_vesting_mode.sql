-- Add 'manual' to valid_vesting_mode check constraint
ALTER TABLE vesting_streams DROP CONSTRAINT valid_vesting_mode;
ALTER TABLE vesting_streams ADD CONSTRAINT valid_vesting_mode CHECK (vesting_mode IN ('snapshot', 'dynamic', 'manual'));

-- Update config table constraint as well if needed (though config usually stays static)
ALTER TABLE config DROP CONSTRAINT valid_mode;
ALTER TABLE config ADD CONSTRAINT valid_mode CHECK (vesting_mode IN ('snapshot', 'dynamic', 'manual'));
