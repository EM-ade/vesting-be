/**
 * Migration Script: Update all RPC endpoint references to use centralized config
 * 
 * This script helps migrate from hardcoded RPC endpoints to the centralized
 * RPC configuration system.
 * 
 * What it does:
 * 1. Finds all files using old RPC patterns
 * 2. Reports current usage
 * 3. Provides migration instructions
 * 4. Optionally performs automated updates (with backup)
 * 
 * Usage:
 *   ts-node scripts/migrateToRPCConfig.ts --dry-run    # Preview changes
 *   ts-node scripts/migrateToRPCConfig.ts --migrate    # Apply changes (creates backups)
 */

import * as fs from 'fs';
import * as path from 'path';

interface MigrationPattern {
  pattern: RegExp;
  replacement: string;
  description: string;
  importNeeded?: string;
}

const MIGRATION_PATTERNS: MigrationPattern[] = [
  // Pattern 1: new Connection with hardcoded endpoint
  {
    pattern: /new Connection\(['"`]https:\/\/[^'"`]+['"`]/g,
    replacement: 'getActiveConnection()',
    description: 'Replace hardcoded Connection with getActiveConnection()',
    importNeeded: "import { getActiveConnection } from '../config';",
  },
  
  // Pattern 2: config.rpcEndpoint usage
  {
    pattern: /config\.rpcEndpoint/g,
    replacement: 'getRPCConfig().getRPCEndpoint()',
    description: 'Replace config.rpcEndpoint with getRPCConfig().getRPCEndpoint()',
    importNeeded: "import { getRPCConfig } from '../config';",
  },
  
  // Pattern 3: Hardcoded Helius endpoints in strings
  {
    pattern: /['"`]https:\/\/(mainnet|devnet)\.helius-rpc\.com[^'"`]*['"`]/g,
    replacement: 'getRPCConfig().getRPCEndpoint()',
    description: 'Replace hardcoded Helius endpoints',
    importNeeded: "import { getRPCConfig } from '../config';",
  },
  
  // Pattern 4: getNetwork() returning 'devnet' | 'mainnet-beta'
  {
    pattern: /getNetwork\(\):\s*['"`]devnet['"`]\s*\|\s*['"`]mainnet-beta['"`]/g,
    replacement: "getNetwork(): SolanaCluster",
    description: 'Update getNetwork() return type to SolanaCluster',
    importNeeded: "import { SolanaCluster } from '../config/rpcConfig';",
  },
];

interface FileIssue {
  file: string;
  issues: {
    line: number;
    content: string;
    pattern: string;
    suggestion: string;
  }[];
}

interface MigrationReport {
  totalFiles: number;
  filesWithIssues: number;
  totalIssues: number;
  fileIssues: FileIssue[];
}

/**
 * Scan a directory recursively for TypeScript files
 */
function scanDirectory(dir: string, exclude: string[] = ['node_modules', 'dist', '.git']): string[] {
  const files: string[] = [];
  
  function scan(currentDir: string) {
    const items = fs.readdirSync(currentDir);
    
    for (const item of items) {
      const fullPath = path.join(currentDir, item);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        if (!exclude.includes(item)) {
          scan(fullPath);
        }
      } else if (stat.isFile() && (item.endsWith('.ts') || item.endsWith('.tsx'))) {
        files.push(fullPath);
      }
    }
  }
  
  scan(dir);
  return files;
}

/**
 * Analyze a file for migration issues
 */
function analyzeFile(filePath: string): FileIssue | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const issues: FileIssue['issues'] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    for (const pattern of MIGRATION_PATTERNS) {
      if (pattern.pattern.test(line)) {
        issues.push({
          line: i + 1,
          content: line.trim(),
          pattern: pattern.description,
          suggestion: pattern.replacement,
        });
      }
    }
  }
  
  if (issues.length === 0) {
    return null;
  }
  
  return {
    file: filePath,
    issues,
  };
}

/**
 * Generate migration report
 */
function generateReport(srcDir: string): MigrationReport {
  console.log('🔍 Scanning for RPC configuration usage...\n');
  
  const files = scanDirectory(srcDir);
  console.log(`Found ${files.length} TypeScript files\n`);
  
  const fileIssues: FileIssue[] = [];
  let totalIssues = 0;
  
  for (const file of files) {
    const issue = analyzeFile(file);
    if (issue) {
      fileIssues.push(issue);
      totalIssues += issue.issues.length;
    }
  }
  
  return {
    totalFiles: files.length,
    filesWithIssues: fileIssues.length,
    totalIssues,
    fileIssues,
  };
}

/**
 * Print migration report
 */
function printReport(report: MigrationReport): void {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('📋 RPC Configuration Migration Report');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  console.log(`Total files scanned: ${report.totalFiles}`);
  console.log(`Files needing migration: ${report.filesWithIssues}`);
  console.log(`Total issues found: ${report.totalIssues}\n`);
  
  if (report.fileIssues.length === 0) {
    console.log('✅ No migration needed! All files are using centralized RPC config.\n');
    return;
  }
  
  console.log('Files requiring updates:\n');
  
  for (const fileIssue of report.fileIssues) {
    console.log(`📄 ${fileIssue.file}`);
    console.log(`   ${fileIssue.issues.length} issue(s) found:\n`);
    
    for (const issue of fileIssue.issues) {
      console.log(`   Line ${issue.line}:`);
      console.log(`   Current:  ${issue.content}`);
      console.log(`   Issue:    ${issue.pattern}`);
      console.log(`   Suggest:  ${issue.suggestion}\n`);
    }
    
    console.log('');
  }
}

/**
 * Create backup of a file
 */
function backupFile(filePath: string): string {
  const backupPath = `${filePath}.backup`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

/**
 * Apply automated migrations to a file
 */
function migrateFile(filePath: string, dryRun: boolean = true): boolean {
  let content = fs.readFileSync(filePath, 'utf-8');
  let modified = false;
  let importsNeeded = new Set<string>();
  
  for (const pattern of MIGRATION_PATTERNS) {
    const matches = content.match(pattern.pattern);
    if (matches && matches.length > 0) {
      modified = true;
      
      // Apply replacement
      content = content.replace(pattern.pattern, pattern.replacement);
      
      // Track needed imports
      if (pattern.importNeeded) {
        importsNeeded.add(pattern.importNeeded);
      }
    }
  }
  
  if (!modified) {
    return false;
  }
  
  // Add imports at the top if needed
  if (importsNeeded.size > 0) {
    const importStatements = Array.from(importsNeeded).join('\n');
    // Find the last import statement
    const importRegex = /import .+ from .+;/g;
    const matches = content.match(importRegex);
    
    if (matches && matches.length > 0) {
      const lastImport = matches[matches.length - 1];
      content = content.replace(lastImport, `${lastImport}\n${importStatements}`);
    } else {
      // No imports found, add at the top
      content = `${importStatements}\n\n${content}`;
    }
  }
  
  if (!dryRun) {
    // Create backup
    const backupPath = backupFile(filePath);
    console.log(`   ✅ Created backup: ${backupPath}`);
    
    // Write migrated content
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`   ✅ Migrated: ${filePath}`);
  } else {
    console.log(`   📝 Would migrate: ${filePath}`);
  }
  
  return true;
}

/**
 * Migrate all files
 */
function migrateAll(srcDir: string, dryRun: boolean = true): void {
  const files = scanDirectory(srcDir);
  let migratedCount = 0;
  
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`${dryRun ? '🔍 DRY RUN MODE' : '🚀 MIGRATION MODE'} - ${dryRun ? 'Preview only' : 'Applying changes'}`);
  console.log(`${'═'.repeat(60)}\n`);
  
  for (const file of files) {
    if (migrateFile(file, dryRun)) {
      migratedCount++;
    }
  }
  
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Summary: ${migratedCount} file(s) ${dryRun ? 'would be' : 'were'} migrated`);
  console.log(`${'═'.repeat(60)}\n`);
  
  if (dryRun) {
    console.log('💡 Run with --migrate flag to apply changes');
  } else {
    console.log('✅ Migration complete! Backup files (.backup) created for all modified files');
    console.log('⚠️  Please review changes and test thoroughly before committing');
    console.log('💡 You can restore from backups if needed: mv file.ts.backup file.ts');
  }
}

/**
 * Main execution
 */
function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || !args.includes('--migrate');
  const srcDir = path.join(__dirname, '..', 'src');
  
  console.log('🔧 RPC Configuration Migration Tool\n');
  
  // Generate and print report
  const report = generateReport(srcDir);
  printReport(report);
  
  if (report.filesWithIssues === 0) {
    return;
  }
  
  // Ask for confirmation if not in dry-run mode
  if (!dryRun) {
    console.log('⚠️  WARNING: This will modify files and create backups');
    console.log('Press Ctrl+C to cancel, or wait 5 seconds to continue...\n');
    
    // Wait 5 seconds
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    wait(5000).then(() => {
      migrateAll(srcDir, dryRun);
    });
  } else {
    migrateAll(srcDir, dryRun);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

export { generateReport, printReport, migrateFile, migrateAll };
