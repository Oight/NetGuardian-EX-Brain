import {
  fail,
  ok,
  parseDesktopInput,
  type CallContext,
  type DatabasePort,
  type DeliveryService,
  type ReportCompletionPort,
  type ResultPackageReadPort,
  type ReviewPublicationPort,
  type SubscriptionAtomicPort,
} from "@campussec/contracts";
export function createReviewPublication(d: {
  db: DatabasePort;
  reports: ReportCompletionPort;
  results: ResultPackageReadPort;
  delivery: DeliveryService;
  subscriptions: SubscriptionAtomicPort;
}): ReviewPublicationPort {
  return {
    async publishReview(ctx, input) {
      const valid = parseDesktopInput("results.publishReview", input);
      if (!valid.ok) return valid;
      if (!["ui", "system"].includes(ctx.actor.role))
        return fail("FORBIDDEN", "人工发布仅限本地授权入口");
      const caller: CallContext = {
        traceId: ctx.traceId,
        actor: {
          spaceId: ctx.actor.spaceId,
          principalId: ctx.actor.principalId,
          identityEpoch: ctx.actor.identityEpoch,
          role: "system",
        },
      };
      return d.db.write(ctx, (tx) => {
        const original = d.results.getInTx(tx, caller, {
          requestId: input.requestId,
          resultVersion: input.expectedResultVersion,
        });
        if (!original.ok) return original;
        const { requestId, jobId, caseId, runId, scope } = original.value;
        const published = d.reports.publishReviewedInTx(tx, caller, {
          context: {
            requestId,
            jobId,
            caseId,
            ...(runId ? { runId } : {}),
            scope,
          },
          reportId: input.reportId,
          expectedCaseRevision: input.expectedCaseRevision,
          expectedResultVersion: input.expectedResultVersion,
        });
        if (!published.ok) return published;
        const subs = d.subscriptions.listInTx(tx, caller, requestId);
        if (!subs.ok) return subs;
        for (const s of subs.value.filter((s) => s.state === "active")) {
          const result = d.delivery.enqueueInTx(tx, caller, {
            bindingId: s.bindingId,
            result: published.value,
          });
          if (!result.ok) return result;
        }
        return ok(published.value);
      });
    },
  };
}
