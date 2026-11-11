import { PermissionResponse, QuestionResponse } from "@agent-strata/api";
import type { AnswerResult, PermissionRequests } from "./permission-requests";

export type { PendingAsk, PendingQuestion } from "./permission-requests";

function answered(result: AnswerResult): Response {
  return result.ok ? Response.json({ ok: true }) : Response.json({ error: result.error }, { status: result.status });
}

export function promptRoute(
  req: Request,
  path: string,
  requests: PermissionRequests,
): Promise<Response> | Response | undefined {
  if (path === "/permissions" && req.method === "GET") {
    return Response.json({
      pending: [...requests.pendingAsks.values()].map(
        ({ resolve: _resolve, submitting: _submitting, local: _local, ...pending }) => pending,
      ),
    });
  }

  const permissionMatch = path.match(/^\/permissions\/([^/]+)\/respond$/);
  if (permissionMatch && req.method === "POST") {
    return (async () => {
      const parsed = PermissionResponse.safeParse(await req.json().catch(() => null));
      if (!parsed.success) {
        return Response.json({ error: "invalid permission response" }, { status: 400 });
      }
      const requestId = decodeURIComponent(permissionMatch[1]!);
      return answered(await requests.answerPermission(requestId, parsed.data.decision, parsed.data.scope));
    })();
  }

  if (path === "/questions" && req.method === "GET") {
    const limit = Number(new URL(req.url).searchParams.get("limit") ?? 200);
    return Response.json({ pending: requests.pendingQuestionList(limit) });
  }

  const questionMatch = path.match(/^\/questions\/([^/]+)\/respond$/);
  if (!questionMatch || req.method !== "POST") return undefined;
  return (async () => {
    const parsed = QuestionResponse.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "invalid question response" }, { status: 400 });
    const requestId = decodeURIComponent(questionMatch[1]!);
    return answered(await requests.answerQuestion(requestId, parsed.data.decision, parsed.data.answers));
  })();
}
