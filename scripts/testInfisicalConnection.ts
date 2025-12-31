/**
 * Test Infisical Connection
 * Simple script to test if Infisical credentials are loaded and working
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

console.log('🔍 Checking Infisical configuration...\n');

// Check if env vars are loaded
console.log('Environment variables:');
console.log(`  INFISICAL_CLIENT_ID: ${process.env.INFISICAL_CLIENT_ID ? '✅ Set (length: ' + process.env.INFISICAL_CLIENT_ID.length + ')' : '❌ Not set'}`);
console.log(`  INFISICAL_CLIENT_SECRET: ${process.env.INFISICAL_CLIENT_SECRET ? '✅ Set (length: ' + process.env.INFISICAL_CLIENT_SECRET.length + ')' : '❌ Not set'}`);
console.log(`  INFISICAL_PROJECT_ID: ${process.env.INFISICAL_PROJECT_ID ? '✅ Set (length: ' + process.env.INFISICAL_PROJECT_ID.length + ')' : '❌ Not set'}`);
console.log(`  INFISICAL_ENVIRONMENT: ${process.env.INFISICAL_ENVIRONMENT || '❌ Not set'}`);
console.log(`  INFISICAL_SECRET_PATH: ${process.env.INFISICAL_SECRET_PATH || '❌ Not set'}`);

console.log('\n🔌 Testing Infisical connection...\n');

async function testConnection() {
  try {
    // Import the health check function
    const { healthCheck } = await import('../src/services/infisicalService');
    
    const isHealthy = await healthCheck();
    
    if (isHealthy) {
      console.log('✅ Infisical connection successful!');
      console.log('\n🎉 You are ready to use Infisical!');
      process.exit(0);
    } else {
      console.log('❌ Infisical health check failed');
      process.exit(1);
    }
  } catch (error: any) {
    console.error('❌ Error testing connection:', error.message);
    console.error('\nFull error:', error);
    process.exit(1);
  }
}

testConnection();
