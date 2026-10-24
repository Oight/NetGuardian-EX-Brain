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
  clock: ClockPort;
  ids: IdPort;
}
export interface Storage {
  db: DatabasePort;
  events: EventPort;
  close(): Promise<void>;
}
