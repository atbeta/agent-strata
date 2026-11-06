import { createResource, For, Show } from "solid-js";
import { fmtDurationDelta, fmtUsd, getJson, type SessionComparison, type TurnPair } from "./api";
import { num, t, tn } from "./i18n";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

function Delta(props: { value: number | null; unit?: string; money?: boolean; duration?: boolean }) {
  const cls = () =>
    props.value != null && props.value > 0
      ? "text-cost-up"
      : props.value != null && props.value < 0
        ? "text-cost-down"
        : "text-cost-flat";
  const text = () => {
    if (props.duration) return fmtDurationDelta(props.value);
    if (props.value == null) return "—";
    const v = props.money ? Math.abs(props.value).toFixed(4) : num(Math.abs(props.value));
    const sign = props.value > 0 ? "+" : props.value < 0 ? "-" : "";
    return `${sign}${props.money ? "$" : ""}${v}${props.unit ?? ""}`;
  };
  return <span class={`font-mono tabular-nums ${cls()}`}>{text()}</span>;
}

function TurnPairRow(props: { pair: TurnPair; i: number }) {
  const label = (t: TurnPair["a_turn"]) =>
    t == null ? "—" : (t.first_user_text ?? t.turn_id).slice(0, 60);
  return (
    <div class="min-w-0 rounded-lg border border-border bg-card p-4">
      <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span class="font-mono">{t("compare.turn", { n: props.i + 1 })}</span>
        <Show when={props.pair.same_prompt}>
          <span class="rounded-sm bg-secondary px-1.5 py-0.5 text-2xs text-muted-foreground">
            {t("compare.samePrompt")}
          </span>
        </Show>
        <span class="ml-auto flex max-w-full flex-wrap items-center justify-end gap-x-1 font-mono tabular-nums">
          <span>Δ tok <Delta value={props.pair.delta.input + props.pair.delta.output} /></span>
          <span>· Δ <Delta value={props.pair.delta.cost_usd} money /></span>
          <span>· Δ <Delta value={props.pair.delta.duration_ms} duration /></span>
        </span>
      </div>
      <div class="mt-2 grid grid-cols-1 gap-3 @min-[560px]/main:grid-cols-2">
        <div class="min-w-0 truncate text-sm text-event-user">{label(props.pair.a_turn)}</div>
        <div class="min-w-0 truncate text-sm text-event-assistant">{label(props.pair.b_turn)}</div>
      </div>
      <div class="mt-2 flex flex-wrap gap-1.5 font-mono text-2xs">
        <For each={props.pair.tools.only_a}>
          {(t) => (
            <span class="max-w-full break-words rounded-sm bg-event-user/15 px-1.5 py-0.5 text-event-user">A: {t}</span>
          )}
        </For>
        <For each={props.pair.tools.only_b}>
          {(t) => (
            <span class="max-w-full break-words rounded-sm bg-event-assistant/15 px-1.5 py-0.5 text-event-assistant">
              B: {t}
            </span>
          )}
        </For>
        <For each={props.pair.tools.shared}>
          {(t) => (
            <span class="max-w-full break-words rounded-sm bg-muted px-1.5 py-0.5 text-muted-foreground">{t}</span>
          )}
        </For>
      </div>
    </div>
  );
}

export function CompareView(props: { a: string; b: string }) {
  const [cmp, { refetch }] = createResource(
    () => `${props.a}/${props.b}`,
    () => getJson<SessionComparison>(`/compare?a=${props.a}&b=${props.b}`),
  );

  return (
    <div class="mx-auto w-full min-w-0 max-w-5xl p-4 @min-[560px]/main:p-6">
      <Show
        when={cmp.error}
        fallback={
          <Show
            when={cmp()}
            fallback={<EmptyState icon="activity" title={t("compare.loading")} />}
          >
            {(c) => (
              <>
                <header class="min-w-0">
                  <h1 class="text-xl font-semibold">{t("compare.title")}</h1>
                  <p class="mt-1 break-words font-mono text-xs text-muted-foreground">
                    {c().a.session_id} {t("compare.vs")} {c().b.session_id}
                  </p>
                </header>

                <section class="mt-4 grid grid-cols-1 gap-3 @min-[560px]/main:grid-cols-2">
                  <div class="min-w-0 rounded-lg border border-event-user/40 bg-card p-4">
                    <div class="break-words text-xs font-medium text-event-user">A · {c().a.backend}</div>
                    <Show when={c().a.model}>
                      <div class="mt-0.5 break-words font-mono text-xs text-muted-foreground">{c().a.model}</div>
                    </Show>
                    <div class="mt-2 break-words font-mono text-xs text-muted-foreground tabular-nums">
                      {tn("compare.totals.tools", c().a.totals.tool_calls)} ·{" "}
                      {num(c().a.totals.input + c().a.totals.output)} tok ·{" "}
                      {fmtUsd(c().a.totals.cost_usd)}
                    </div>
                  </div>
                  <div class="min-w-0 rounded-lg border border-event-assistant/40 bg-card p-4">
                    <div class="break-words text-xs font-medium text-event-assistant">B · {c().b.backend}</div>
                    <Show when={c().b.model}>
                      <div class="mt-0.5 break-words font-mono text-xs text-muted-foreground">{c().b.model}</div>
                    </Show>
                    <div class="mt-2 break-words font-mono text-xs text-muted-foreground tabular-nums">
                      {tn("compare.totals.tools", c().b.totals.tool_calls)} ·{" "}
                      {num(c().b.totals.input + c().b.totals.output)} tok ·{" "}
                      {fmtUsd(c().b.totals.cost_usd)}
                    </div>
                  </div>
                </section>

                <section class="mt-3 flex flex-wrap gap-x-6 gap-y-1 rounded-lg border border-border bg-muted px-4 py-2.5 text-xs text-muted-foreground">
                  <span class="min-w-0 break-words">
                    {tn("compare.summary.turnPairs", c().summary.turn_pairs)} ·{" "}
                    {tn("compare.summary.samePrompt", c().summary.same_prompt)}
                  </span>
                  <span class="min-w-0 break-words">
                    {t("compare.delta.total")} <Delta value={c().summary.delta_totals.input + c().summary.delta_totals.output} />{" "}
                    tok · <Delta value={c().summary.delta_totals.cost_usd} money />
                  </span>
                </section>

                <section class="mt-5 space-y-3">
                  <Show
                    when={c().turn_pairs.length > 0}
                    fallback={<EmptyState icon="columns" title={t("palette.empty")} class="py-10" />}
                  >
                    <For each={c().turn_pairs}>{(p, i) => <TurnPairRow pair={p} i={i()} />}</For>
                  </Show>
                </section>
              </>
            )}
          </Show>
        }
      >
        <EmptyState
          icon="alert"
          tone="danger"
          title={t("session.service_unreachable")}
          description={t("startup.serviceErrorHint")}
          action={
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              {t("session.retry")}
            </Button>
          }
        />
      </Show>
    </div>
  );
}
