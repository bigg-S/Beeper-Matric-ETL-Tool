export const schema = {
    users: `
        CREATE TABLE IF NOT EXISTS users (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            matrix_user_id TEXT UNIQUE NOT NULL,
            display_name TEXT,
            avatar_url TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `,

    rooms: `
        CREATE TABLE IF NOT EXISTS rooms (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            matrix_room_id TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            topic TEXT,
            encrypted BOOLEAN DEFAULT false,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `,

    room_members: `
        CREATE TABLE IF NOT EXISTS room_members (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
            user_id UUID REFERENCES users(id) ON DELETE CASCADE,
            matrix_room_id TEXT NOT NULL,
            matrix_user_id TEXT NOT NULL,
            membership_state TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(room_id, user_id)
        );
    `,

    messages: `
        CREATE TABLE IF NOT EXISTS messages (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            matrix_event_id TEXT UNIQUE NOT NULL,
            room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
            sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
            matrix_room_id TEXT NOT NULL,
            matrix_sender_id TEXT NOT NULL,
            content TEXT,
            timestamp TIMESTAMPTZ NOT NULL,
            encrypted BOOLEAN DEFAULT false,
            event_type TEXT,
            state TEXT DEFAULT 'active',   -- active, deleted, redacted, etc.
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `,

    sync_status: `
        CREATE TABLE IF NOT EXISTS sync_status (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            sync_type TEXT,
            state TEXT NOT NULL,
            progress FLOAT,
            last_sync TIMESTAMPTZ,
            error TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `,

    timeline_gaps: `
        CREATE TABLE IF NOT EXISTS timeline_gaps (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
            matrix_room_id TEXT NOT NULL,
            from_event TEXT NOT NULL,
            to_event TEXT NOT NULL,
            detected_at TIMESTAMPTZ NOT NULL,
            status TEXT NOT NULL,
            retry_count INTEGER DEFAULT 0,
            last_retry_at TIMESTAMPTZ,
            metadata JSONB DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(matrix_room_id, from_event, to_event)
        );
    `,

    indexes: `
        CREATE INDEX IF NOT EXISTS idx_messages_matrix_room_id ON messages(matrix_room_id);
        CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
        CREATE INDEX IF NOT EXISTS idx_room_members_matrix_ids ON room_members(matrix_room_id, matrix_user_id);
        CREATE INDEX IF NOT EXISTS idx_timeline_gaps_status ON timeline_gaps(status);
        CREATE INDEX IF NOT EXISTS idx_messages_matrix_event_id ON messages(matrix_event_id);
    `
};
