import type {
  ClockPort,
  IdPort,
  DatabasePort,
  EventPort,
} from "@campussec/contracts";
export interface StorageDependencies {
  dataDir: string;
  spaceId: string;
  principalId: string;
  identityEpoch: number;
  /** Optional authenticated snapshot persistence; plaintext SQLite is never created in this mode. */
  encryption?: {encrypt(text:string):Uint8Array;decrypt(bytes:Uint8Array):string};
  clock: ClockPort;
  ids: IdPort;
}
export interface Storage {
  db: DatabasePort;
  events: EventPort;
  close(): Promise<void>;
}
