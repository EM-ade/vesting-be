/**
 * Script to generate a vault for an existing project
 * Usage: ts-node scripts/generateVaultForProject.ts <projectId>
 */
import { createProjectVault } from '../src/services/vaultService';
import { getSupabaseClient } from '../src/lib/supabaseClient';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
    const projectId = process.argv[2];

    if (!projectId) {
        console.error('Usage: ts-node scripts/generateVaultForProject.ts <projectId>');
        process.exit(1);
    }

    console.log(`Generating vault for project: ${projectId}`);

    const supabase = getSupabaseClient();

    // Check if project exists and doesn't have a vault
    const { data: project, error } = await supabase
        .from('projects')
        .select('id, name, vault_public_key')
        .eq('id', projectId)
        .single();

    if (error || !project) {
        console.error('Project not found:', error?.message);
        process.exit(1);
    }

    if (project.vault_public_key) {
        console.log(`Project "${project.name}" already has a vault: ${project.vault_public_key}`);
        process.exit(0);
    }

    try {
        const vaultPublicKey = await createProjectVault(projectId);
        console.log(`✅ Vault created successfully!`);
        console.log(`   Project: ${project.name}`);
        console.log(`   Vault Public Key: ${vaultPublicKey}`);
    } catch (e) {
        console.error('Failed to create vault:', e);
        process.exit(1);
    }
}

main();
