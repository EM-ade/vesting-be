import { Client } from 'pg';
import fs from 'fs';
import path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

// Ordered list of migrations to ensure correct dependency resolution
const MIGRATION_ORDER = [
  '00_initial_schema.sql',
  'add_cliff_minutes.sql',
  'add_enable_claims.sql',
  'add_snapshot_taken.sql',
  'add_token_mint_to_vesting_streams.sql',
  'add_unique_claim_constraint.sql',
  'remove_unique_constraint.sql',
  'multi_project_expansion.sql',
  'add_vault_rpc.sql',
  'add_auth_users.sql',
  'update_role_check_constraint.sql',
  '01_fix_vesting_mode.sql',
  '02_backfill_project_id.sql',
  '03_enhance_pool_schema.sql'
];

const migrate = async () => {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error('❌ DATABASE_URL is not defined in .env');
    console.error('Please get the connection string from Supabase Dashboard -> Settings -> Database -> Connection string');
    process.exit(1);
  }

  console.log('🔌 Connecting to database...');

  const client = new Client({
    connectionString,
    ssl: {
      rejectUnauthorized: false // Required for Supabase
    }
  });

  try {
    await client.connect();
    console.log('✅ Connected successfully');

    // Create migrations table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

    const migrationsDir = path.join(__dirname, '../migrations');

    console.log('🚀 Starting migrations...');

    for (const migrationFile of MIGRATION_ORDER) {
      const filePath = path.join(migrationsDir, migrationFile);

      if (!fs.existsSync(filePath)) {
        console.warn(`⚠️ Migration file not found: ${migrationFile}, skipping...`);
        continue;
      }

      // Check if migration already executed
      const checkResult = await client.query(
        'SELECT id FROM _migrations WHERE name = $1',
        [migrationFile]
      );

      if (checkResult.rows.length > 0) {
        console.log(`⏭️  Skipping ${migrationFile} (already executed)`);
        continue;
      }

      console.log(`▶️  Executing ${migrationFile}...`);
      const sql = fs.readFileSync(filePath, 'utf8');

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO _migrations (name) VALUES ($1)',
          [migrationFile]
        );
        await client.query('COMMIT');
        console.log(`✅ ${migrationFile} completed`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`❌ Failed to execute ${migrationFile}:`);
        console.error(err);
        // Don't break the loop? Or should we? Usually yes for migrations.
        // But some migrations might be idempotent or partially failing due to "IF NOT EXISTS"
        // Let's stop on error to be safe.
        process.exit(1);
      }
    }

    console.log('✨ All migrations completed successfully!');

  } catch (err) {
    console.error('❌ Database connection error:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
};

migrate();
