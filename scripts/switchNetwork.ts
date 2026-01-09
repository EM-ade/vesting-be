#!/usr/bin/env ts-node
/**
 * Network Switcher Script
 * 
 * Easily switch between devnet and mainnet for both backend and frontend
 * 
 * Usage:
 *   npm run switch-network devnet
 *   npm run switch-network mainnet
 *   npm run switch-network status
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// TYPES & CONSTANTS
// ============================================================================

type Network = 'devnet' | 'mainnet';

interface NetworkConfig {
  backend: {
    rpcNetwork: string;
    rpcEndpoint: string;
  };
  frontend: {
    code: string;
    description: string;
  };
}

const CONFIGS: Record<Network, NetworkConfig> = {
  devnet: {
    backend: {
      rpcNetwork: 'helius-devnet',
      rpcEndpoint: 'https://devnet.helius-rpc.com/?api-key=a53cd9fb-465b-4ee6-a217-c33cdd15707d',
    },
    frontend: {
      code: `  // FORCED TO DEVNET FOR TESTING
  // Override environment detection to always use devnet
  const selectedNetwork = 'helius-devnet';
  
  console.log(\`[RPC Config] ⚠️  FORCED TO DEVNET - All environments using: \${selectedNetwork}\`);
  console.log(\`[RPC Config] Current NODE_ENV: \${process.env.NODE_ENV}\`);
  console.log(\`[RPC Config] To switch back to automatic, restore environment detection logic\`);
  
  return selectedNetwork;`,
      description: 'Forced to devnet',
    },
  },
  mainnet: {
    backend: {
      rpcNetwork: 'helius-mainnet',
      rpcEndpoint: 'https://mainnet.helius-rpc.com/?api-key=a53cd9fb-465b-4ee6-a217-c33cdd15707d',
    },
    frontend: {
      code: `  // Auto-detect based on NODE_ENV (set by Vercel)
  const nodeEnv = process.env.NODE_ENV;
  const isProduction = nodeEnv === 'production';
  const isPreview = process.env.VERCEL_ENV === 'preview';
  
  let selectedNetwork: string;
  
  if (isProduction && !isPreview) {
    selectedNetwork = 'helius-mainnet';
    console.log(\`[RPC Config] Production environment detected, using: \${selectedNetwork}\`);
  } else {
    selectedNetwork = 'helius-devnet';
    console.log(\`[RPC Config] Development/Preview environment detected, using: \${selectedNetwork}\`);
  }
  
  return selectedNetwork;`,
      description: 'Automatic (production=mainnet, dev=devnet)',
    },
  },
};

// ============================================================================
// FILE PATHS
// ============================================================================

const BACKEND_ENV = path.join(__dirname, '..', '.env');
const BACKEND_ENV_LOCAL = path.join(__dirname, '..', '.env.local');
const FRONTEND_RPC_CONFIG = path.join(__dirname, '..', '..', 'vesting-fe', 'src', 'config', 'rpcConfig.ts');

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

function writeFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, 'utf-8');
}

function createBackup(filePath: string): string {
  const backupPath = `${filePath}.backup`;
  if (fileExists(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
  }
  return '';
}

// ============================================================================
// NETWORK DETECTION
// ============================================================================

function detectCurrentNetwork(): { backend: string; frontend: string } {
  let backend = 'unknown';
  let frontend = 'unknown';

  // Check backend
  if (fileExists(BACKEND_ENV)) {
    const content = readFile(BACKEND_ENV);
    const match = content.match(/RPC_NETWORK=([^\s\n]+)/);
    if (match) {
      backend = match[1].includes('devnet') ? 'devnet' : 'mainnet';
    }
  }

  // Check frontend
  if (fileExists(FRONTEND_RPC_CONFIG)) {
    const content = readFile(FRONTEND_RPC_CONFIG);
    if (content.includes("selectedNetwork = 'helius-devnet'") && content.includes('DEVNET MODE')) {
      frontend = 'devnet';
    } else if (content.includes("selectedNetwork = 'helius-devnet'") && content.includes('FORCED TO DEVNET')) {
      frontend = 'devnet';
    } else if (content.includes('isProduction') && content.includes('helius-mainnet')) {
      frontend = 'mainnet (automatic)';
    } else {
      frontend = 'unknown';
    }
  }

  return { backend, frontend };
}

// ============================================================================
// NETWORK SWITCHING
// ============================================================================

function switchBackendNetwork(network: Network): void {
  const config = CONFIGS[network];
  
  console.log(`\n🔄 Switching backend to ${network.toUpperCase()}...`);

  // Update .env
  if (fileExists(BACKEND_ENV)) {
    createBackup(BACKEND_ENV);
    let content = readFile(BACKEND_ENV);
    
    // Replace RPC_NETWORK
    content = content.replace(
      /RPC_NETWORK=helius-(devnet|mainnet)/,
      `RPC_NETWORK=${config.backend.rpcNetwork}`
    );
    
    // Replace RPC_ENDPOINT if it exists
    content = content.replace(
      /RPC_ENDPOINT=https:\/\/(devnet|mainnet)\.helius-rpc\.com[^\s\n]*/,
      `RPC_ENDPOINT=${config.backend.rpcEndpoint}`
    );
    
    writeFile(BACKEND_ENV, content);
    console.log(`  ✅ Updated .env`);
  } else {
    console.log(`  ⚠️  .env file not found`);
  }

  // Update .env.local
  if (fileExists(BACKEND_ENV_LOCAL)) {
    createBackup(BACKEND_ENV_LOCAL);
    let content = readFile(BACKEND_ENV_LOCAL);
    
    // Replace RPC_NETWORK
    content = content.replace(
      /RPC_NETWORK=helius-(devnet|mainnet)/,
      `RPC_NETWORK=${config.backend.rpcNetwork}`
    );
    
    // Replace RPC_ENDPOINT
    content = content.replace(
      /RPC_ENDPOINT=https:\/\/(devnet|mainnet|api\.devnet|api\.mainnet-beta)\.([^\s\n]*)/,
      `RPC_ENDPOINT=${config.backend.rpcEndpoint}`
    );
    
    writeFile(BACKEND_ENV_LOCAL, content);
    console.log(`  ✅ Updated .env.local`);
  } else {
    console.log(`  ⚠️  .env.local file not found`);
  }

  console.log(`✅ Backend switched to ${network.toUpperCase()}`);
}

function switchFrontendNetwork(network: Network): void {
  const config = CONFIGS[network];
  
  console.log(`\n🔄 Switching frontend to ${network.toUpperCase()}...`);

  if (!fileExists(FRONTEND_RPC_CONFIG)) {
    console.log(`  ❌ Frontend RPC config not found: ${FRONTEND_RPC_CONFIG}`);
    return;
  }

  createBackup(FRONTEND_RPC_CONFIG);
  let content = readFile(FRONTEND_RPC_CONFIG);

  // Find the DEFAULT_NETWORK_KEY section
  const startMarker = '  // FORCED TO DEVNET FOR TESTING';
  const endMarker = '  return selectedNetwork;';
  
  // Check if we have the forced devnet section or the automatic section
  const hasForcedDevnet = content.includes(startMarker);
  const hasAutomatic = content.includes('// Auto-detect based on NODE_ENV');

  if (hasForcedDevnet || hasAutomatic) {
    // Find the start of the logic (after override check)
    const overrideEndIndex = content.indexOf('return override;');
    if (overrideEndIndex === -1) {
      console.log(`  ❌ Could not find override section`);
      return;
    }

    // Find the end of the function
    const functionEndIndex = content.indexOf('})();', overrideEndIndex);
    if (functionEndIndex === -1) {
      console.log(`  ❌ Could not find function end`);
      return;
    }

    // Extract before and after
    const beforeLogic = content.substring(0, overrideEndIndex + 'return override;'.length);
    const afterLogic = content.substring(functionEndIndex);

    // Build new content
    const newLogic = `
  
${config.frontend.code}
  
  /* COMMENTED OUT - ${network === 'devnet' ? 'Automatic environment detection' : 'Forced devnet override'}
${network === 'devnet' ? CONFIGS.mainnet.frontend.code : CONFIGS.devnet.frontend.code}
  */`;

    content = beforeLogic + newLogic + '\n' + afterLogic;
    
    writeFile(FRONTEND_RPC_CONFIG, content);
    console.log(`  ✅ Updated rpcConfig.ts`);
    console.log(`  📝 Frontend now: ${config.frontend.description}`);
  } else {
    console.log(`  ⚠️  Could not identify current frontend configuration`);
  }

  console.log(`✅ Frontend switched to ${network.toUpperCase()}`);
}

// ============================================================================
// STATUS DISPLAY
// ============================================================================

function displayStatus(): void {
  const current = detectCurrentNetwork();
  
  console.log('\n========================================');
  console.log('📊 CURRENT NETWORK STATUS');
  console.log('========================================\n');
  
  console.log('Backend:');
  console.log(`  Network:  ${current.backend.toUpperCase()}`);
  if (fileExists(BACKEND_ENV)) {
    const content = readFile(BACKEND_ENV);
    const rpcMatch = content.match(/RPC_NETWORK=([^\s\n]+)/);
    if (rpcMatch) {
      console.log(`  Config:   ${rpcMatch[1]}`);
    }
  }
  
  console.log('\nFrontend:');
  console.log(`  Network:  ${current.frontend.toUpperCase()}`);
  
  console.log('\n========================================\n');
  
  if (current.backend !== current.frontend.split(' ')[0]) {
    console.log('⚠️  WARNING: Backend and frontend are on different networks!');
    console.log('   This may cause issues. Run switch-network to sync them.\n');
  }
}

// ============================================================================
// MAIN
// ============================================================================

function main() {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase();

  console.log('🔧 Network Switcher\n');

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log('Usage:');
    console.log('  npm run switch-network devnet      # Switch to devnet');
    console.log('  npm run switch-network mainnet     # Switch to mainnet');
    console.log('  npm run switch-network status      # Show current status');
    console.log('  npm run switch-network help        # Show this help\n');
    process.exit(0);
  }

  if (command === 'status') {
    displayStatus();
    process.exit(0);
  }

  if (command !== 'devnet' && command !== 'mainnet') {
    console.error(`❌ Invalid network: ${command}`);
    console.error('   Valid options: devnet, mainnet, status\n');
    process.exit(1);
  }

  const network = command as Network;
  
  console.log(`Switching to ${network.toUpperCase()}...\n`);
  console.log('⚠️  This will modify:');
  console.log('   • vesting-be/.env');
  console.log('   • vesting-be/.env.local');
  console.log('   • vesting-fe/src/config/rpcConfig.ts');
  console.log('\n📦 Backups will be created (.backup extension)\n');

  // Perform switch
  switchBackendNetwork(network);
  switchFrontendNetwork(network);

  console.log('\n========================================');
  console.log(`✅ SUCCESSFULLY SWITCHED TO ${network.toUpperCase()}`);
  console.log('========================================\n');

  console.log('Next steps:');
  console.log('  1. Restart your backend server');
  console.log('  2. Restart your frontend dev server');
  console.log('  3. Clear browser cache if needed');
  console.log('  4. Verify with: npm run switch-network status\n');

  if (network === 'devnet') {
    console.log('⚠️  DEVNET MODE - Remember:');
    console.log('   • All transactions are on devnet');
    console.log('   • Use devnet SOL and tokens');
    console.log('   • Get devnet SOL: solana airdrop 2 <address> --url devnet\n');
  } else {
    console.log('🚨 MAINNET MODE - Remember:');
    console.log('   • All transactions use REAL funds');
    console.log('   • Double-check wallet addresses');
    console.log('   • Test thoroughly on devnet first\n');
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

export { switchBackendNetwork, switchFrontendNetwork, detectCurrentNetwork, displayStatus };
