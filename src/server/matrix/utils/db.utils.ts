import { pgPool } from "@/server/db/client";
import { UserPayload } from "@/server/types";
import { EventTimeline, EventType, LoginResponse, MatrixClient, MatrixEvent, Room, SyncStateData } from "matrix-js-sdk";

export async function getExistingCredentials(userId: string) {
    try {
        const result = await pgPool.query(
            'SELECT device_id, access_token FROM auth_credentials WHERE user_id = $1',
            [userId]
        );
        if (result.rows.length > 0) {
            return result.rows[0];
        } else {
            return null;
        }
    } catch (error) {
        console.error("Error fetching credentials:", error);
        return null;
    }
}

export async function persistMessage(roomId: string | undefined, event: MatrixEvent): Promise<void> {
    try {
    const query = `
        INSERT INTO messages (event_id, room_id, sender, content, event_type, timestamp, is_encrypted, relates_to, error)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (event_id) DO UPDATE SET
            room_id = EXCLUDED.room_id,
            sender = EXCLUDED.sender,
            content = EXCLUDED.content,
            event_type = EXCLUDED.type,
            timestamp = EXCLUDED.timestamp,
            is_encrypted = EXCLUDED.is_encrypted,
            relates_to,
            error
        `;

    const values = [
        event.getId(),
        roomId,
        event.sender,
        JSON.stringify(event.getContent()),
        event.getType(),
        event.getTs(),
        event.isEncrypted(),
        JSON.stringify(event.getRelation()),
        event.error
    ];

    await pgPool.query(query, values);
    } catch (error) {
        console.error("Error persisting message:", error);
        throw error;
    }
}

export async function persistParticipants(room: Room): Promise<void> {
    const members = room.getJoinedMembers();
    const batchSize = 100;

    for (let i = 0; i < members.length; i += batchSize) {
        const batch = members.slice(i, i + batchSize);
        const query = `
        INSERT INTO participants (
            user_id, display_name, avatar_url, membership,
            room_id, joined_ts, last_updated
        )
        VALUES
            ${batch.map((_, index) =>
                `($${index * 7 + 1}, $${index * 7 + 2}, $${index * 7 + 3}, $${index * 7 + 4}, $${index * 7 + 5}, $${index * 7 + 6}, $${index * 7 + 7})`
            ).join(',')}
            ON CONFLICT (user_id, room_id) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            avatar_url = EXCLUDED.avatar_url,
            membership = EXCLUDED.membership,
            last_updated = EXCLUDED.last_updated
        `;

        const values = batch.flatMap(member => [
            member.userId,
            member.name,
            member.getMxcAvatarUrl() ?? '',
            member.membership,
            room.roomId,
            member.events.member?.getTs(),
            new Date().toISOString()
        ]);

        try {
            await pgPool.query(query, values);
        } catch (error: any) {
            throw new Error(`Failed to sync participants batch: ${error.message}`);
        }
    }
}

export async function persistRoom(room: Room): Promise<void> {
    const state = room.getLiveTimeline().getState(EventTimeline.FORWARDS);
    const roomData = {
        id: room.roomId,
        name: room.name,
        topic: state?.getStateEvents('m.room.topic')[0]?.getContent()?.topic ?? '',
        is_encrypted: !!state?.getStateEvents(EventType.RoomEncryption, ''),
        created_ts: state?.getStateEvents('m.room.create', '')?.getTs(),
        avatar_url: state?.getStateEvents('m.room.avatar')[0]?.getContent()?.url ?? '',
        last_updated: new Date().toISOString()
    };

    const query = `
        INSERT INTO rooms (
            id, name, topic, is_encrypted, created_ts,
            avatar_url, last_updated
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        topic = EXCLUDED.topic,
        is_encrypted = EXCLUDED.is_encrypted,
        avatar_url = EXCLUDED.avatar_url,
        last_updated = EXCLUDED.last_updated
    `;

    try {
        await pgPool.query(query, [
            roomData.id,
            roomData.name,
            roomData.topic,
            roomData.is_encrypted,
            roomData.created_ts,
            roomData.avatar_url,
            roomData.last_updated
        ]);
    } catch (error: any) {
        throw new Error(`Failed to sync room: ${error.message}`);
    }
}


export async function setKeyBackupStatus(status: boolean) {
    const query = `
        INSERT INTO key_backup_status (
            status,
            created_at
        ) VALUES ($1, $2)
    `;

    await pgPool.query(query, [
        status,
        new Date().toISOString()
    ]);
}

export async function setAuthCredentials(client: MatrixClient, loginResponse: LoginResponse, authConfig: UserPayload) {
    const query = `
        INSERT INTO auth_credentials (
            user_id, device_id, access_token, refresh_token, domain, homeserver_url, expires_in_ms, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `;

    await pgPool.query(query, [
        client.getUserId(),
        loginResponse.device_id,
        loginResponse.access_token,
        loginResponse.refresh_token,
        authConfig.domain,
        client.getUserId()?.split(":")[1],
        loginResponse.expires_in_ms,
        new Date().toISOString()
    ]);
}

export async function loadLatestSyncData() {
    const query = `
      SELECT *
        FROM sync_state
        ORDER BY created_at DESC
        LIMIT 1
    `;

    const result = await pgPool.query(query);
    return result.rows[0] || null;
}

export async function updateSyncState(state: string, data: SyncStateData) {
    const query = `
        INSERT INTO sync_state (
            next_batch,
            state,
            sync_data,
            created_at
        ) VALUES ($1, $2, $3, $4)
    `;

    await pgPool.query(query, [
        state,
        data.nextSyncToken,
        data,
        new Date().toISOString()
    ]);
}
