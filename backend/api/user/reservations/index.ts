import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sql } from '../../_lib/db';
import { logger, withRequestLogging } from '../../_lib/logger';
import { ok, err } from '../../_lib/types';
import { withUser } from '../../_lib/withUser';

interface ReservationBody {
  id?: string;
  restaurantId?: string;
  restaurantName?: string;
  restaurantPhotoUrl?: string | null;
  datetime?: string;
  partySize?: number;
  confirmationCode?: string | null;
  platform?: string | null;
  status?: string;
  calendarEventId?: string | null;
  reminderNotificationId?: string | null;
}

async function handler(req: VercelRequest, res: VercelResponse, userId: string) {
  if (req.method === 'GET') {
    const rows = await sql`
      SELECT
        id,
        restaurant_id            AS "restaurantId",
        restaurant_name          AS "restaurantName",
        restaurant_photo_url     AS "restaurantPhotoUrl",
        datetime,
        party_size               AS "partySize",
        confirmation_code        AS "confirmationCode",
        platform,
        status,
        calendar_event_id        AS "calendarEventId",
        reminder_notification_id AS "reminderNotificationId",
        created_at               AS "createdAt"
      FROM user_reservations
      WHERE user_id = ${userId}
      ORDER BY datetime ASC
    `;
    return res.status(200).json(ok({ reservations: rows }));
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as ReservationBody;
    const id = body.id;
    const restaurantId = body.restaurantId;
    const restaurantName = body.restaurantName;
    const datetime = body.datetime;
    const partySize = body.partySize;

    if (!id || !restaurantId || !restaurantName || !datetime || typeof partySize !== 'number') {
      return res.status(400).json(err('Missing required reservation fields', 'INVALID_BODY'));
    }

    await sql`
      INSERT INTO user_reservations (
        id, user_id, restaurant_id, restaurant_name, restaurant_photo_url,
        datetime, party_size, confirmation_code, platform, status,
        calendar_event_id, reminder_notification_id
      )
      VALUES (
        ${id}, ${userId}, ${restaurantId}, ${restaurantName}, ${body.restaurantPhotoUrl ?? null},
        ${datetime}, ${partySize}, ${body.confirmationCode ?? null}, ${body.platform ?? null},
        ${body.status ?? 'confirmed'}, ${body.calendarEventId ?? null}, ${body.reminderNotificationId ?? null}
      )
      ON CONFLICT(id) DO UPDATE SET
        datetime                 = excluded.datetime,
        party_size               = excluded.party_size,
        confirmation_code        = excluded.confirmation_code,
        platform                 = excluded.platform,
        status                   = excluded.status,
        calendar_event_id        = excluded.calendar_event_id,
        reminder_notification_id = excluded.reminder_notification_id
    `;

    logger.success('user.reservation.saved', { userId, id, restaurantId });
    return res.status(200).json(ok({ id }));
  }

  return res.status(405).json(err('Method not allowed', 'METHOD_NOT_ALLOWED'));
}

export default withRequestLogging(withUser(handler));
