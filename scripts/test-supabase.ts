import * as dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import path from 'path';

// Load env from parent directory
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log('Testing Supabase Connection...');
console.log('URL:', supabaseUrl ? 'Found' : 'Missing');
console.log('Key:', supabaseKey ? 'Found' : 'Missing');

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase credentials in .env');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function testConnection() {
    try {
        const { count, error } = await supabase
            .from('vesting_streams')
            .select('*', { count: 'exact', head: true });

        if (error) {
            console.error('Supabase Error:', error);
        } else {
            console.log('Supabase Connection Successful!');
            console.log('Vesting Streams Count:', count);
        }
    } catch (err) {
        console.error('Unexpected Error:', err);
    }
}

testConnection();
