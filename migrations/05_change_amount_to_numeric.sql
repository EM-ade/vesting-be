-- Change total_pool_amount to numeric to support fractional tokens
ALTER TABLE vesting_streams 
ALTER COLUMN total_pool_amount TYPE numeric;
