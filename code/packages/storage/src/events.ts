import { fail, internalError, ok, parseWith, callContextSchema, parseDomainEvent, canonicalJson, type CallContext, type DatabasePort, type EventPort, type EventPayloadMap, type ReadTx, type WriteTx, type Result, type SqlValue } from "@campussec/contracts";
import type {StorageDependencies} from "./types.js";
export function createEvents(deps:StorageDependencies&{db:DatabasePort;isWrite(tx:WriteTx):boolean;authorize(ctx:CallContext):Result<void>}):EventPort{
const db=deps.db;
    const events: EventPort = {
      appendInTx<K extends keyof EventPayloadMap>(tx: WriteTx, ctx: CallContext, input: { type: K; aggregateId: string; revision: number; payload: EventPayloadMap[K] }): number {
        if (!deps.isWrite(tx) || !deps.authorize(ctx).ok) throw new Error('Event requires live authorized transaction');
        const event = parseDomainEvent({ ...input, payload: input.payload, seq: 1, spaceId: deps.spaceId, occurredAt: deps.clock.now(), traceId: ctx.traceId });
        if (!event.ok) throw new Error('Invalid event');
        tx.run('INSERT INTO domain_events(event_type,aggregate_id,revision,trace_id,occurred_at,payload_json) VALUES(?,?,?,?,?,?)', [input.type, input.aggregateId, input.revision, ctx.traceId, event.value.occurredAt, canonicalJson(event.value.payload)]);
        return tx.get<{ seq: number }>('SELECT last_insert_rowid() AS seq')!.seq;
      },
      async read(ctx, input) {
        if (!Number.isSafeInteger(input.afterSeq) || input.afterSeq < 0 || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) return fail('INVALID_INPUT', '事件分页参数无效');
        return db.read(ctx, tx => {
          const lastSeq = tx.get<{ seq: number }>("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='domain_events'),0) AS seq")!.seq;
          const first = tx.get<{ seq: number | null }>('SELECT MIN(seq) AS seq FROM domain_events')!.seq;
          const resetRequired = input.afterSeq > lastSeq || (input.afterSeq < lastSeq && (first === null || input.afterSeq < first - 1));
          if (resetRequired) return { events: [], lastSeq, resetRequired: true };
          const rows = tx.all<{ seq: number; event_type: string; aggregate_id: string; revision: number; trace_id: string; occurred_at: string; payload_json: string }>('SELECT seq,event_type,aggregate_id,revision,trace_id,occurred_at,payload_json FROM domain_events WHERE seq>? ORDER BY seq LIMIT ?', [input.afterSeq, input.limit]);
          const values = rows.map(row => {
            const parsed = parseDomainEvent({ seq: row.seq, type: row.event_type, spaceId: deps.spaceId, aggregateId: row.aggregate_id, revision: row.revision, traceId: row.trace_id, occurredAt: row.occurred_at, payload: JSON.parse(row.payload_json) as unknown });
            if (!parsed.ok) throw new Error('Invalid stored event');
            return parsed.value;
          });
          return { events: values, lastSeq, resetRequired: false };
        });
      },
    };
return events;
}
