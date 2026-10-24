import type { ClockPort, IdPort, Result } from "@campussec/contracts";

export class FakeClock implements ClockPort {
  private milliseconds = Date.parse("2026-10-23T01:00:00.000Z");
  now() {
    return new Date(this.milliseconds).toISOString();
  }
  monotonicMs() {
    return this.milliseconds;
  }
  advance(milliseconds: number) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0)
      throw new Error("Clock advances must be nonnegative");
    this.milliseconds += milliseconds;
  }
}

export class FakeIds implements IdPort {
  private counter = 0;
  next() {
    return `20000000-0000-4000-8000-${(++this.counter).toString(16).padStart(12, "0")}`;
  }
}

export class ScriptedPort<I, O> {
  readonly calls: I[] = [];
  private steps: ((input: I) => Promise<Result<O>>)[] = [];
  push(step: (input: I) => Promise<Result<O>>) {
    this.steps.push(step);
  }
  pending() {
    return this.steps.length;
  }
  assertDrained() {
    if (this.steps.length) throw new Error("Unused external script steps");
  }
  async invoke(input: I) {
    this.calls.push(input);
    const next = this.steps.shift();
    if (!next) throw new Error("Unscripted external call");
    return next(input);
  }
}

/** Atomic callbacks must never await. Wrong async scripts fail before a caller can commit. */
export class SyncScriptedPort<I, O> {
  readonly calls: I[] = [];
  private steps: ((input: I) => Result<O>)[] = [];
  push(step: (input: I) => Result<O>) {
    this.steps.push(step);
  }
  pending() {
    return this.steps.length;
  }
  invoke(input: I): Result<O> {
    this.calls.push(input);
    const step = this.steps.shift();
    if (!step) throw new Error("Unscripted atomic call");
    const result = step(input);
    if (isThenable(result) || (result.ok && isThenable(result.value))) {
      void Promise.resolve(
        isThenable(result) ? result : result.ok ? result.value : undefined,
      ).catch(() => undefined);
      throw new Error("Atomic scripts must be synchronous");
    }
    return result;
  }
}
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    !!value &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
/** Explicitly controlled in-flight response: useful for cancel/late reply/restart scenarios. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}
