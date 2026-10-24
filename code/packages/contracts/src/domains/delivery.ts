/** Engineering contract 0.2.0; declarations preserved from the source snapshot. */
import type {
  AppError,
  CallContext,
  Id,
  Instant,
  ReadTx,
  Result,
  WriteTx,
} from "./common.js";
import type { ResultPackage } from "./reports.js";
import type { HostReceipt } from "./host.js";

export type DeliveryState =
  | "pending"
  | "sending"
  | "delivered"
  | "uncertain"
  | "retryable_failed"
  | "blocked";

export interface DeliveryRecord {
  id: Id;
  originBindingId: Id;
  requestId: Id;
  runId?: Id;
  resultVersion: number;
  deliveryKey: string;
  state: DeliveryState;
  attempts: number;
  result: ResultPackage;
  receipt?: HostReceipt;
  lastError?: AppError;
  nextAttemptAt?: Instant;
}

export interface DeliveryService {
  enqueueInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { bindingId: Id; result: ResultPackage },
  ): Result<DeliveryRecord>;
  tick(ctx: CallContext): Promise<Result<number>>;
  status(ctx: CallContext, requestId: Id): Promise<Result<DeliveryRecord[]>>;
  getResult(
    ctx: CallContext,
    input: { requestId: Id; resultVersion?: number },
  ): Promise<Result<ResultPackage>>;
}

export interface SubscriptionAtomicPort {
  subscribeInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { requestId: Id; bindingId: Id; canCancel: boolean },
  ): Result<void>;
  listInTx(
    tx: ReadTx,
    ctx: CallContext,
    requestId: Id,
  ): Result<ResultSubscription[]>;
  withdrawInTx(
    tx: WriteTx,
    ctx: CallContext,
    input: { requestId: Id; bindingId: Id },
  ): Result<void>;
}

export interface ResultSubscription {
  requestId: Id;
  bindingId: Id;
  canCancel: boolean;
  state: "active" | "withdrawn";
}
