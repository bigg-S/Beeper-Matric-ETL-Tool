export const schema = {
    users: `
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            display_name TEXT,
            avatar_url TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `,
    rooms: `
        CREATE TABLE IF NOT EXISTS rooms (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            topic TEXT,
            encrypted BOOLEAN DEFAULT false,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `,
    room_members: `
        CREATE TABLE IF NOT EXISTS room_members (
            room_id TEXT REFERENCES rooms(id),
            user_id TEXT REFERENCES users(id),
            PRIMARY KEY (room_id, user_id),
            membership_state TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `,
    messages: `
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            room_id TEXT REFERENCES rooms(id),
            sender TEXT NOT NULL REFERENCES users(id),
            content TEXT,
            timestamp TIMESTAMPTZ NOT NULL,
            encrypted BOOLEAN DEFAULT false,
            event_type TEXT,
            deleted BOOLEAN DEFAULT FALSE, -- Or state TEXT
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `,
    sync_status: `
        CREATE TABLE IF NOT EXISTS sync_status (
            id SERIAL PRIMARY KEY,
            sync_type TEXT,
            state TEXT NOT NULL,
            progress FLOAT,
            last_sync TIMESTAMPTZ,
            error TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `,
};
