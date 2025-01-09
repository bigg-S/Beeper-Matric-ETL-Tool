export const schema = {
    rooms: `
        CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        topic TEXT,
        encrypted BOOLEAN DEFAULT false,
        members TEXT[] DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
    );
    `,
    messages: `
        CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        room_id TEXT REFERENCES rooms(id),
        sender TEXT NOT NULL,
        content TEXT,
        timestamp TIMESTAMPTZ NOT NULL,
        encrypted BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
    );
    `,
    sync_status: `
        CREATE TABLE IF NOT EXISTS sync_status (
        id SERIAL PRIMARY KEY,
        state TEXT NOT NULL,
        progress FLOAT,
        last_sync TIMESTAMPTZ,
        error TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
    );
    `,
};
