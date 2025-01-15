import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { schema } from './schema';
import * as dotenv from 'dotenv';

dotenv.config();

if (!process.env.SUPABASE_URL) {
    throw new Error('Missing SUPABASE_URL environment variable');
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY environment variable');
}

export const supabase: SupabaseClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
        auth: {
            autoRefreshToken: true,
            persistSession: false,
        },
    }
);

export const initializeDatabase = async () => {
    try {
        await supabase.rpc('exec', {
            query: `
                BEGIN;
                ${Object.values(schema).join(';\n')}
                COMMIT;
            `,
        });
        console.log("Database initialized or already up-to-date.");
    } catch (error: any) {
        console.error('Failed to initialize database:', error);
        throw new Error(`Database initialization failed: ${error.message}`);
    }
};

export const tableExists = async (tableName: string): Promise<boolean> => {
    try {
        const { error } = await supabase.from(tableName).select('count').limit(0); // Limit 0 is more efficient
        return !error;
    } catch (error) {
        console.error(`Error checking if table ${tableName} exists:`, error);
        return false;
    }
};
