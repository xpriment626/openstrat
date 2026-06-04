import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  IsoDateTimeSchema,
  JsonRecordSchema,
  NonEmptyStringSchema
} from "@openstrat/domain";

export const AppendEventInputSchema = z.object({
  id: NonEmptyStringSchema.optional(),
  stream_id: NonEmptyStringSchema,
  type: NonEmptyStringSchema,
  occurred_at: IsoDateTimeSchema.optional(),
  payload: z.unknown(),
  metadata: JsonRecordSchema.optional()
});

export const StoredEventSchema = z.object({
  sequence: z.number().int().positive(),
  id: NonEmptyStringSchema,
  stream_id: NonEmptyStringSchema,
  type: NonEmptyStringSchema,
  occurred_at: IsoDateTimeSchema,
  payload: z.unknown(),
  metadata: JsonRecordSchema
});

export type AppendEventInput = z.infer<typeof AppendEventInputSchema>;
export type StoredEvent = z.infer<typeof StoredEventSchema>;

export interface EventLogRepository {
  append(input: AppendEventInput): StoredEvent;
  get(sequence: number): StoredEvent | undefined;
  list(streamId?: string): StoredEvent[];
  close(): void;
}

interface EventRow {
  sequence: number;
  id: string;
  stream_id: string;
  type: string;
  occurred_at: string;
  payload_json: string;
  metadata_json: string;
}

export class SqliteEventLog implements EventLogRepository {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    this.initialize();
  }

  append(input: AppendEventInput): StoredEvent {
    const event = AppendEventInputSchema.parse(input);
    const id = event.id ?? randomUUID();
    const occurredAt = event.occurred_at ?? new Date().toISOString();
    const metadata = event.metadata ?? {};

    const result = this.db
      .prepare(
        `
          INSERT INTO event_log (
            id,
            stream_id,
            type,
            occurred_at,
            payload_json,
            metadata_json
          )
          VALUES (?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        id,
        event.stream_id,
        event.type,
        occurredAt,
        JSON.stringify(event.payload),
        JSON.stringify(metadata)
      );

    return StoredEventSchema.parse({
      sequence: Number(result.lastInsertRowid),
      id,
      stream_id: event.stream_id,
      type: event.type,
      occurred_at: occurredAt,
      payload: event.payload,
      metadata
    });
  }

  get(sequence: number): StoredEvent | undefined {
    const row = this.db
      .prepare("SELECT * FROM event_log WHERE sequence = ?")
      .get(sequence) as EventRow | undefined;

    return row ? this.rowToEvent(row) : undefined;
  }

  list(streamId?: string): StoredEvent[] {
    const rows =
      streamId === undefined
        ? (this.db
            .prepare("SELECT * FROM event_log ORDER BY sequence ASC")
            .all() as unknown as EventRow[])
        : (this.db
            .prepare(
              "SELECT * FROM event_log WHERE stream_id = ? ORDER BY sequence ASC"
            )
            .all(streamId) as unknown as EventRow[]);

    return rows.map((row) => this.rowToEvent(row));
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event_log (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        stream_id TEXT NOT NULL,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_event_log_stream_sequence
        ON event_log(stream_id, sequence);

      CREATE TRIGGER IF NOT EXISTS event_log_reject_update
      BEFORE UPDATE ON event_log
      BEGIN
        SELECT RAISE(ABORT, 'event_log is append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS event_log_reject_delete
      BEFORE DELETE ON event_log
      BEGIN
        SELECT RAISE(ABORT, 'event_log is append-only');
      END;
    `);
  }

  private rowToEvent(row: EventRow): StoredEvent {
    return StoredEventSchema.parse({
      sequence: row.sequence,
      id: row.id,
      stream_id: row.stream_id,
      type: row.type,
      occurred_at: row.occurred_at,
      payload: JSON.parse(row.payload_json) as unknown,
      metadata: JSON.parse(row.metadata_json) as unknown
    });
  }
}
