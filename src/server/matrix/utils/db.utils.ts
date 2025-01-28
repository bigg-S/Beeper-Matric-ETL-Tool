import { pgPool } from '@/server/db/client';
import { UserPayload } from '@/server/types';
import {
  EventTimeline,
  EventType,
  LoginResponse,
  MatrixClient,
  MatrixEvent,
  Room,
  RoomMember,
} from 'matrix-js-sdk';

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
    console.error('Error fetching credentials:', error);
    return null;
  }
}

export async function persistMessage(
  roomId: string | undefined,
  event: MatrixEvent
): Promise<void> {
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
      event.error,
    ];

    await pgPool.query(query, values);
  } catch (error) {
    console.error('Error persisting message:', error);
    throw error;
  }
}

export async function persistParticipant(member: RoomMember): Promise<void> {
  const query = `
    INSERT INTO participants (
      user_id, display_name, avatar_url, membership,
      room_id, joined_ts, last_updated
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7
    )
    ON CONFLICT (user_id, room_id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      avatar_url = EXCLUDED.avatar_url,
      membership = EXCLUDED.membership,
      last_updated = EXCLUDED.last_updated
    WHERE
      participants.display_name IS DISTINCT FROM EXCLUDED.display_name
      OR participants.avatar_url IS DISTINCT FROM EXCLUDED.avatar_url
      OR participants.membership IS DISTINCT FROM EXCLUDED.membership
      OR participants.last_updated IS DISTINCT FROM EXCLUDED.last_updated
  `;

  const values = [
    member.userId,
    member.name,
    member.getMxcAvatarUrl() ?? '',
    member.membership,
    member.roomId,
    member.events.member?.getTs(),
    new Date().toISOString(),
  ];

  try {
    await pgPool.query(query, values);
  } catch (error: any) {
    throw new Error(`Failed to sync participant: ${error.message}`);
  }
}

export async function persistRoom(room: Room, membership: string): Promise<void> {
  const state = room.getLiveTimeline().getState(EventTimeline.FORWARDS);
  const roomData = {
    id: room.roomId,
    name: room.name,
    topic: state?.getStateEvents('m.room.topic')[0]?.getContent()?.topic ?? '',
    is_encrypted: !!state?.getStateEvents(EventType.RoomEncryption, ''),
    created_ts: state?.getStateEvents('m.room.create', '')?.getTs(),
    avatar_url: state?.getStateEvents('m.room.avatar')[0]?.getContent()?.url ?? '',
    last_updated: new Date().toISOString(),
  };

  const query = `
    INSERT INTO rooms (
      id, name, topic, membership, is_encrypted, created_ts,
      avatar_url, last_updated
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      topic = EXCLUDED.topic,
      membership = EXCLUDE.membership,
      is_encrypted = EXCLUDED.is_encrypted,
      avatar_url = EXCLUDED.avatar_url,
      last_updated = EXCLUDED.last_updated
    WHERE
      rooms.name IS DISTINCT FROM EXCLUDED.name
      OR rooms.topic IS DISTINCT FROM EXCLUDED.topic
      OR rooms.is_encrypted IS DISTINCT FROM EXCLUDED.is_encrypted
      OR rooms.avatar_url IS DISTINCT FROM EXCLUDED.avatar_url
      OR rooms.last_updated IS DISTINCT FROM EXCLUDED.last_updated
    `;

  try {
    await pgPool.query(query, [
      roomData.id,
      roomData.name,
      roomData.topic,
      membership,
      roomData.is_encrypted,
      roomData.created_ts,
      roomData.avatar_url,
      roomData.last_updated,
    ]);
  } catch (error: any) {
    throw new Error(`Failed to sync room: ${error.message}`);
  }
}

export async function persistParticipants(room: Room): Promise<void> {
  const members = room.getJoinedMembers();
  const batchSize = 100;

  for (let i = 0; i < members.length; i += batchSize) {
    const batch = members.slice(i, i + batchSize);

    const query =
        `INSERT INTO participants (
            user_id, display_name, avatar_url, membership,
            room_id, joined_ts, last_updated
        )
        VALUES
            ${batch
              .map(
                (_, index) =>
                  `($${index * 7 + 1}, $${index * 7 + 2}, $${index * 7 + 3}, $${index * 7 + 4}, $${index * 7 + 5}, $${index * 7 + 6}, $${index * 7 + 7})`
              )
              .join(',')}
        ON CONFLICT (user_id, room_id) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            avatar_url = EXCLUDED.avatar_url,
            membership = EXCLUDED.membership,
            last_updated = EXCLUDED.last_updated
        WHERE
            participants.display_name IS DISTINCT FROM EXCLUDED.display_name
            OR participants.avatar_url IS DISTINCT FROM EXCLUDED.avatar_url
            OR participants.membership IS DISTINCT FROM EXCLUDED.membership
            OR participants.last_updated IS DISTINCT FROM EXCLUDED.last_updated
            `
        ;

    const values = batch.flatMap((member) => [
      member.userId,
      member.name,
      member.getMxcAvatarUrl() ?? '',
      member.membership,
      room.roomId,
      member.events.member?.getTs(),
      new Date().toISOString(),
    ]);

    try {
      await pgPool.query(query, values);
    } catch (error: any) {
      throw new Error("Failed to sync participants batch: ${error.message}");
    }
  }
}

export async function setKeyBackupStatus(status: boolean) {
  const query = `
    INSERT INTO key_backup_status (
      status,
      created_at
    ) VALUES ($1, $2)
  `;

  await pgPool.query(query, [status, new Date().toISOString()]);
}

export async function setAuthCredentials(
  client: MatrixClient,
  authResponse: LoginResponse,
  authConfig: UserPayload
) {
  const query = `
      INSERT INTO auth_credentials (
        user_id, device_id, access_token, refresh_token, domain, homeserver_url, expires_in_ms, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `;

  await pgPool.query(query, [
    client.getUserId(),
    authResponse.device_id,
    authResponse.access_token,
    authResponse.refresh_token,
    authConfig.domain,
    client.getUserId()?.split(':')[1],
    authResponse.expires_in_ms,
    new Date().toISOString(),
  ]);
}

export async function updateDeviceId(
  userId: string | undefined,
  newDeviceId: string | null
) {
  if (!userId || !newDeviceId) {
    console.log("Invalid user or device ID");
    return;
  }

  const query = `
    UPDATE auth_credentials
    SET device_id = $1
    WHERE user_id = $2
  `;

  try {
    const result = await pgPool.query(query, [
      newDeviceId,
      userId
    ]);

    if (result.rowCount === 0) {
      throw new Error(`No credentials found for user ID: ${userId}`);
    }

    return result.rowCount;
  } catch (error: any) {
    throw new Error(`Failed to update device ID: ${error.message}`);
  }
}

export async function loadLatestSyncToken(): Promise<string | null> {
  const query = `
    SELECT next_batch
    FROM sync_state
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const result = await pgPool.query(query);
  return result.rows[0]?.next_batch || null;
}

export async function updateSyncToken(syncToken: string): Promise<void> {
  const query = `
    INSERT INTO sync_state (next_batch, created_at)
    VALUES ($1, $2)
    ON CONFLICT (next_batch) DO UPDATE
    SET created_at = EXCLUDED.created_at
  `;
  await pgPool.query(query, [syncToken, new Date().toISOString()]);
}
