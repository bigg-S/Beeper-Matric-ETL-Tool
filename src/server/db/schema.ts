export const schema = {
    auth_credentials: `
        CREATE TABLE IF NOT EXISTS auth_credentials (
            user_id TEXT PRIMARY KEY,
            access_token TEXT NOT NULL,
            refresh_token TEXT NOT NULL,
            device_id TEXT NOT NULL,
            domain TEXT NOT NULL,
            homeserver_url TEXT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `,

    sync_state: `
        CREATE TABLE IF NOT EXISTS sync_state (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            next_batch TEXT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            state TEXT NOT NULL,
            error TEXT
        );
    `,

    sync_chunks: `
        CREATE TABLE IF NOT EXISTS sync_chunks (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            sync_token TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            total_chunks INTEGER NOT NULL,
            chunk_data JSONB NOT NULL,
            processed BOOLEAN DEFAULT false,
            retry_count INTEGER DEFAULT 0,
            timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT unique_chunk UNIQUE (sync_token, chunk_index)
        );
    `,

    rooms: `
        CREATE TABLE IF NOT EXISTS rooms (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name TEXT,
            topic TEXT,
            is_encrypted BOOLEAN NOT NULL DEFAULT false,
            created_ts BIGINT,
            avatar_url TEXT,
            last_message_ts TIMESTAMP WITH TIME ZONE,
            member_count INTEGER DEFAULT 0,
            encrypted_member_count INTEGER DEFAULT 0,
            sync_status TEXT DEFAULT 'pending',
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
            power_level INTEGER DEFAULT 0,
            is_direct BOOLEAN DEFAULT false,
            last_updated TIMESTAMP WITH TIME ZONE NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, room_id),
            FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
        );
    `,

    messages: `
        CREATE TABLE IF NOT EXISTS messages (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            room_id TEXT NOT NULL,
            sender TEXT NOT NULL,
            content JSONB NOT NULL,
            timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
            encrypted BOOLEAN NOT NULL DEFAULT false,
            decrypted BOOLEAN NOT NULL DEFAULT false,
            event_type TEXT NOT NULL,
            relates_to TEXT,
            thread_root TEXT,
            processed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            error TEXT,
            FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
            FOREIGN KEY (relates_to) REFERENCES messages(id),
            FOREIGN KEY (thread_root) REFERENCES messages(id)
        );
    `,

    sync_errors: `
        CREATE TABLE IF NOT EXISTS sync_errors (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            event_id TEXT NOT NULL,
            room_id TEXT NOT NULL,
            error TEXT NOT NULL,
            retry_count INTEGER DEFAULT 0,
            timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            resolved BOOLEAN DEFAULT false,
            resolved_at TIMESTAMP WITH TIME ZONE,
            UNIQUE(event_id)
        );
    `,

    sync_status: `
        CREATE TABLE IF NOT EXISTS sync_status (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            state TEXT NOT NULL,
            last_sync TIMESTAMP WITH TIME ZONE,
            error TEXT,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
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
        CREATE INDEX IF NOT EXISTS idx_sync_chunks_token ON sync_chunks(sync_token);
        CREATE INDEX IF NOT EXISTS idx_sync_chunks_timestamp ON sync_chunks(timestamp);
        CREATE INDEX IF NOT EXISTS idx_sync_chunks_processed ON sync_chunks(processed);

        CREATE INDEX IF NOT EXISTS idx_messages_room_timestamp ON messages(room_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
        CREATE INDEX IF NOT EXISTS idx_messages_event_type ON messages(event_type);
        CREATE INDEX IF NOT EXISTS idx_messages_thread_root ON messages(thread_root);
        CREATE INDEX IF NOT EXISTS idx_messages_relates_to ON messages(relates_to);
        CREATE INDEX IF NOT EXISTS idx_messages_encrypted ON messages(encrypted) WHERE encrypted = true;

        CREATE INDEX IF NOT EXISTS idx_participants_room ON participants(room_id);
        CREATE INDEX IF NOT EXISTS idx_participants_membership ON participants(membership);

        CREATE INDEX IF NOT EXISTS idx_rooms_sync_status ON rooms(sync_status);
        CREATE INDEX IF NOT EXISTS idx_rooms_last_message ON rooms(last_message_ts);

        CREATE INDEX IF NOT EXISTS idx_sync_errors_unresolved ON sync_errors(timestamp) WHERE resolved = false;
    `
};
