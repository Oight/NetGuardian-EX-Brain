import type { CallContext } from "@campussec/contracts";
import { FakeIds } from "./clock.js";

export const SPACE = "10000000-0000-4000-8000-000000000001";
export const PRINCIPAL = "10000000-0000-4000-8000-000000000002";
export const CONNECTION = "10000000-0000-4000-8000-000000000003";
export const CASE = "10000000-0000-4000-8000-000000000004";
export const scope = {
  connectionId: CONNECTION,
  agentIds: ["001"],
  from: "2026-10-23T00:30:00.000Z",
  to: "2026-10-23T01:00:00.000Z",
  timeZone: "Asia/Shanghai",
};
const traces = new FakeIds();
export const context = (): CallContext => ({
  actor: {
    spaceId: SPACE,
    principalId: PRINCIPAL,
    identityEpoch: 1,
    role: "ui",
  },
  traceId: traces.next(),
});
