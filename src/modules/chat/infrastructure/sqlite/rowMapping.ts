/**
 * Maps between the SQLite row shape (flat columns + `extra` JSON blob) and
 * the domain `ChatMessage`. Kept separate from queryBuilder.ts so the SQL
 * layer never needs to know about ChatMessage's shape beyond the columns it
 * filters/sorts on.
 */

import type { ChatMessage, ChatParticipant } from '../../domain/entities/types';
import { computeDerivedFields } from './schema';

export interface MessageRow {
  id: number;
  type: string;
  timestamp: number;
  date_key: number;
  hour: number;
  day_of_week: number;
  from_id: string;
  from_name: string;
  text: string | null;
  text_length: number;
  service_action: string | null;
  extra: string | null;
}

interface ExtraFields {
  editedTimestamp?: number;
  textEntities?: ChatMessage['textEntities'];
  reactions?: ChatMessage['reactions'];
  file?: ChatMessage['file'];
  serviceActor?: string;
  discardReason?: string;
  viaBot?: string;
}

export function messageToRow(message: ChatMessage): (string | number | null)[] {
  const { dateKey, hour, dayOfWeek } = computeDerivedFields(message.timestamp.getTime());
  const extra: ExtraFields = {};
  if (message.editedTimestamp) extra.editedTimestamp = message.editedTimestamp.getTime();
  if (message.textEntities) extra.textEntities = message.textEntities;
  if (message.reactions) extra.reactions = message.reactions;
  if (message.file) extra.file = message.file;
  if (message.serviceActor) extra.serviceActor = message.serviceActor;
  if (message.discardReason) extra.discardReason = message.discardReason;
  if (message.viaBot) extra.viaBot = message.viaBot;
  const hasExtra = Object.keys(extra).length > 0;

  return [
    message.id,
    message.type,
    message.timestamp.getTime(),
    dateKey,
    hour,
    dayOfWeek,
    message.fromId,
    message.from,
    // eslint-disable-next-line unicorn/no-null -- SQL NULL, not JS "no value"; sqlite-wasm binds `null` as NULL
    message.text ?? null,
    message.text?.length ?? 0,
    // eslint-disable-next-line unicorn/no-null -- SQL NULL
    message.serviceAction ?? null,
    // eslint-disable-next-line unicorn/no-null -- SQL NULL
    hasExtra ? JSON.stringify(extra) : null,
  ];
}

export function rowToMessage(row: MessageRow): ChatMessage {
  const extra: ExtraFields = row.extra ? JSON.parse(row.extra) as ExtraFields : {};
  const message: ChatMessage = {
    id: row.id,
    type: row.type as ChatMessage['type'],
    timestamp: new Date(row.timestamp),
    from: row.from_name,
    fromId: row.from_id,
  };
  if (row.text !== null) message.text = row.text;
  if (row.service_action !== null) message.serviceAction = row.service_action;
  if (extra.editedTimestamp !== undefined) message.editedTimestamp = new Date(extra.editedTimestamp);
  if (extra.textEntities) message.textEntities = extra.textEntities;
  if (extra.reactions) message.reactions = extra.reactions;
  if (extra.file) message.file = extra.file;
  if (extra.serviceActor) message.serviceActor = extra.serviceActor;
  if (extra.discardReason) message.discardReason = extra.discardReason;
  if (extra.viaBot) message.viaBot = extra.viaBot;
  return message;
}

export function participantToRow(participant: ChatParticipant): (string | number)[] {
  return [participant.id, participant.name, participant.color ?? '', participant.isMe ? 1 : 0];
}

export function rowToParticipant(row: { id: string; name: string; color: string | null; is_me: number }): ChatParticipant {
  const participant: ChatParticipant = { id: row.id, name: row.name, isMe: row.is_me === 1 };
  if (row.color) participant.color = row.color;
  return participant;
}
