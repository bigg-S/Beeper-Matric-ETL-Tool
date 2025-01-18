import pg from 'pg';
import { schema } from './schema';
import * as dotenv from 'dotenv';

dotenv.config();

if (!process.env.DATABASE_URL) {
    throw new Error('Missing DATABASE_URL environment variable');
}

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20,
});

export const pgPool = pool;

export const initializeDatabase = async () => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const existingTablesResult = await client.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public';
        `);
        const existingTables = new Set(existingTablesResult.rows.map(row => row.table_name));

        for (const [tableName, schemaSQL] of Object.entries(schema)) {
            if (tableName === 'indexes') continue;

            if (!existingTables.has(tableName)) {
                await client.query(schemaSQL);
                console.log(`Table ${tableName} created.`);
            } else {
                console.log(`Table ${tableName} already exists. Skipping creation.`);
            }
        }

        if (schema.indexes) {
            await client.query(schema.indexes);
            console.log("Indexes created.");
        }

        await client.query('COMMIT');
        console.log("Database initialized successfully.");
    } catch (error: any) {
        await client.query('ROLLBACK');
        console.error('Failed to initialize database:', error);
        throw new Error(`Database initialization failed: ${error.message}`);
    } finally {
        client.release();
    }
};

process.on('SIGINT', async () => {
    console.log('Closing database pool...');
    await pool.end();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('Closing database pool...');
    await pool.end();
    process.exit(0);
});
