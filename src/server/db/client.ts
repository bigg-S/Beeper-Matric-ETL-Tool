import { createClient } from '@supabase/supabase-js';
import { schema } from './schema';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing Supabase environment variables');
}

export const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
        auth: {
        autoRefreshToken: true,
        persistSession: true,
        },
    }
);

export const initializeDatabase = async () => {
    for (const [table, query] of Object.entries(schema)) {
        const { error } = await supabase.from(table).select('count').single();

        if (error && error.code === '42P01') {
        // table doesn't exist, create it
        const { error: createError } = await supabase.rpc('exec', { query });
        if (createError) {
            throw new Error(`Failed to create ${table} table: ${createError.message}`);
        }
        }
    }
};
