export const schema = {
    auth_credentials: `
        CREATE TABLE IF NOT EXISTS auth_credentials (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            domain TEXT NOT NULL,
            homeserver_url TEXT NOT NULL,
            expires_in_ms BIGINT,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `,

    sync_state: `
        CREATE TABLE IF NOT EXISTS sync_state (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            next_batch TEXT UNIQUE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `,

    rooms: `
        CREATE TABLE IF NOT EXISTS rooms (
            id TEXT PRIMARY KEY,
            name TEXT,
            topic TEXT,
            membership TEXT,
            is_encrypted BOOLEAN NOT NULL DEFAULT false,
            created_ts BIGINT,
            avatar_url TEXT,
            last_updated TIMESTAMP WITH TIME ZONE NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `,

    participants: `
        CREATE TABLE IF NOT EXISTS participants (
            user_id TEXT NOT NULL,
            room_id TEXT NOT NULL,
            display_name TEXT,
            avatar_url TEXT,
            membership TEXT NOT NULL,
            joined_ts BIGINT,
            last_updated TIMESTAMP WITH TIME ZONE NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, room_id),
            FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
        );
    `,

    messages: `
        CREATE TABLE IF NOT EXISTS messages (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            event_id TEXT NOT NULL UNIQUE,
            room_id TEXT NOT NULL,
            sender TEXT NOT NULL,
            content JSONB NOT NULL,
            event_type TEXT NOT NULL,
            timestamp BIGINT NOT NULL,
            is_encrypted BOOLEAN NOT NULL DEFAULT false,
            relates_to JSONB,
            error TEXT,
            processed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
        );
    `,

    key_backup_status: `
        CREATE TABLE IF NOT EXISTS key_backup_status (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            status BOOLEAN DEFAULT false,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `,

    indexes: `
        CREATE INDEX IF NOT EXISTS idx_messages_room_timestamp ON messages(room_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
        CREATE INDEX IF NOT EXISTS idx_messages_event_type ON messages(event_type);
        CREATE INDEX IF NOT EXISTS idx_messages_encrypted ON messages(is_encrypted) WHERE is_encrypted = true;
        CREATE INDEX IF NOT EXISTS idx_participants_room ON participants(room_id);
        CREATE INDEX IF NOT EXISTS idx_participants_membership ON participants(membership);
        CREATE INDEX IF NOT EXISTS idx_rooms_membership ON rooms(membership);
    `
};
