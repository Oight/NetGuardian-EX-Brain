import type { ClockPort, IdPort, Result } from '@campussec/contracts';

export class FakeClock implements ClockPort {
  private milliseconds = Date.parse('2026-10-23T01:00:00.000Z');
  now() { return new Date(this.milliseconds).toISOString(); }
  monotonicMs() { return this.milliseconds; }
  advance(milliseconds: number) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('Clock advances must be nonnegative');
    this.milliseconds += milliseconds;
  }
}

export class FakeIds implements IdPort {
  private counter = 0;
  next() { return `20000000-0000-4000-8000-${(++this.counter).toString(16).padStart(12, '0')}`; }
}

export class ScriptedPort<I, O> {
  readonly calls: I[] = [];
  private steps: ((input: I) => Promise<Result<O>>)[] = [];
  push(step: (input: I) => Promise<Result<O>>) { this.steps.push(step); }
  async invoke(input: I) {
    this.calls.push(input);
    const next = this.steps.shift();
    if (!next) throw new Error('Unscripted external call');
    return next(input);
  }
}
