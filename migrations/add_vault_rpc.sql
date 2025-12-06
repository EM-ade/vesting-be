-- Function to atomically update vault balances
CREATE OR REPLACE FUNCTION update_vault_balances(
    p_project_id UUID,
    p_token_delta NUMERIC,
    p_sol_delta NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE projects
    SET 
        vault_balance_token = COALESCE(vault_balance_token, 0) + p_token_delta,
        vault_balance_sol = COALESCE(vault_balance_sol, 0) + p_sol_delta,
        updated_at = NOW()
    WHERE id = p_project_id;
END;
$$;
