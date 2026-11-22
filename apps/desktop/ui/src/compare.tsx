import { createResource, createSignal, For, Show } from "solid-js";
import {
  fmtDurationDelta,
  fmtUsd,
  getJson,
  type SessionComparison,
  type SessionRow,
  type TurnPair,
} from "./api";
import {
  compareSessionDetail,
  compareSessionTitle,
  findSession,
  firstDivergentTurn,
  pairedDurationDelta,
  usageDeltaSentence,
} from "./compare-summary";
import { ComparePick } from "./compare-pick";
import { num, t, tn } from "./i18n";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { RowButton } from "@/components/ui/row-button";

function Delta(props: { value: number | null; unit?: string; money?: boolean; duration?: boolean }) {
  const text = () => {
    if (props.duration) return fmtDurationDelta(props.value);
    if (props.value == null) return "—";
    const v = props.money ? Math.abs(props.value).toFixed(4) : num(Math.abs(props.value));
    const sign = props.value > 0 ? "+" : props.value < 0 ? "-" : "";
    return `${sign}${props.money ? "$" : ""}${v}${props.unit ?? ""}`;
  };
  // Only the money delta is a cost, so only it takes the cost colours. More
  // tokens or more time is not a loss, and painting those red would claim it
  // was — the sign already says which way the number moved.
  const tone = () => {
    if (!props.money || props.value == null) return "text-muted-foreground";
    if (props.value > 0) return "text-cost-up";
    if (props.value < 0) return "text-cost-down";
    return "text-cost-flat";
  };
  return <span class={`font-mono tabular-nums ${tone()}`}>{text()}</span>;
}

function TurnPairRow(props: { pair: TurnPair; i: number; diverged: boolean }) {
  const text = (turn: TurnPair["a_turn"]) => {
    const raw = turn?.first_user_text ?? "";
    return raw.trim() ? raw : null;
  };
  const prompt = (turn: TurnPair["a_turn"]) => (
    <p
      class={`mt-2 line-clamp-3 whitespace-pre-wrap break-words text-sm ${
        text(turn) ? "text-foreground" : "text-muted-foreground"
      }`}
    >
      {text(turn) ?? t("compare.noTurn")}
    </p>
  );
  return (
    <div class="space-y-2">
      <Show when={props.diverged}>
        <p class="px-1 text-xs text-muted-foreground">{t("compare.diverged")}</p>
      </Show>
      <div class="min-w-0 rounded-lg border border-border bg-card p-4">
        <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span class="font-mono">{t("compare.turn", { n: props.i + 1 })}</span>
          <Show when={props.pair.same_prompt}>
            <span class="rounded-sm bg-secondary px-1.5 py-0.5 text-2xs text-muted-foreground">
              {t("compare.samePrompt")}
            </span>
          </Show>
          <span class="ml-auto flex max-w-full flex-wrap items-center justify-end gap-x-1 font-mono tabular-nums">
            <span class="text-muted-foreground">{t("compare.delta.mark")}</span>
            <span>
              tok <Delta value={props.pair.delta.input + props.pair.delta.output} />
            </span>
            <span>
              · <Delta value={props.pair.delta.cost_usd} money />
            </span>
            <span>
              · <Delta value={props.pair.delta.duration_ms} duration />
            </span>
          </span>
        </div>
        <div class="mt-2 grid grid-cols-1 gap-3 @min-[560px]/main:grid-cols-2">
          <div class="min-w-0">
            <span class="font-mono text-2xs text-muted-foreground">A</span>
            {prompt(props.pair.a_turn)}
          </div>
          <div class="min-w-0">
            <span class="font-mono text-2xs text-muted-foreground">B</span>
            {prompt(props.pair.b_turn)}
          </div>
        </div>
        <div class="mt-2 flex flex-wrap gap-1.5 font-mono text-2xs">
          <For each={props.pair.tools.only_a}>
            {(name) => (
              <span class="max-w-full break-words rounded-sm bg-secondary px-1.5 py-0.5 text-muted-foreground">
                A · {name}
              </span>
            )}
          </For>
          <For each={props.pair.tools.only_b}>
            {(name) => (
              <span class="max-w-full break-words rounded-sm bg-secondary px-1.5 py-0.5 text-muted-foreground">
                B · {name}
              </span>
            )}
          </For>
          <For each={props.pair.tools.shared}>
            {(name) => (
              <span class="max-w-full break-words rounded-sm bg-muted px-1.5 py-0.5 text-muted-foreground">
                {name}
              </span>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

function SideCard(props: {
  mark: "A" | "B";
  id: string;
  sessions: SessionRow[];
  backend: string;
  model?: string;
  tools: number;
  tokens: number;
  cost: number;
}) {
  const row = () => findSession(props.sessions, props.id);
  return (
    <RowButton
      class="min-w-0 flex-col items-stretch gap-0 rounded-lg border border-border bg-card p-4 text-foreground hover:bg-secondary/40"
      onClick={() => {
        location.hash = `/session/${encodeURIComponent(props.id)}`;
      }}
    >
      <div class="flex items-start gap-2">
        <span class="mt-0.5 rounded-sm bg-secondary px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
          {props.mark}
        </span>
        <span class="min-w-0 flex-1 break-words text-sm font-medium text-foreground">
          {compareSessionTitle(row(), props.id)}
        </span>
        <span class="shrink-0 text-2xs text-muted-foreground">{t("compare.open")}</span>
      </div>
      <Show when={compareSessionDetail(row())}>
        <div class="mt-1 break-words text-xs text-muted-foreground">{compareSessionDetail(row())}</div>
      </Show>
      <div class="mt-1 break-words text-xs text-muted-foreground">
        {props.backend}
        <Show when={props.model}>{(model) => <span class="font-mono"> · {model()}</span>}</Show>
      </div>
      <div class="mt-2 break-words font-mono text-xs text-muted-foreground tabular-nums">
        {tn("compare.totals.tools", props.tools)} · {num(props.tokens)} tok · {fmtUsd(props.cost)}
      </div>
    </RowButton>
  );
}

export function CompareView(props: { a: string; b: string; sessions: SessionRow[] }) {
  const [cmp, { refetch }] = createResource(
    () => `${props.a}/${props.b}`,
    () => getJson<SessionComparison>(`/compare?a=${props.a}&b=${props.b}`),
  );
  const [replacing, setReplacing] = createSignal(false);
  const titleOf = (id: string) => compareSessionTitle(findSession(props.sessions, id), id);

  const swap = () => {
    location.hash = `/compare/${encodeURIComponent(props.b)}/${encodeURIComponent(props.a)}`;
  };

  return (
    <div class="mx-auto w-full min-w-0 max-w-5xl p-4 @min-[560px]/main:p-6">
      <Show
        when={cmp.error}
        fallback={
          <Show
            when={cmp()}
            fallback={<EmptyState icon="activity" title={t("compare.loading")} />}
          >
            {(c) => {
              const divergedAt = () => firstDivergentTurn(c().turn_pairs);
              const sentence = () =>
                usageDeltaSentence({
                  cost: c().summary.delta_totals.cost_usd,
                  tokens: c().summary.delta_totals.input + c().summary.delta_totals.output,
                  durationMs: pairedDurationDelta(c().turn_pairs),
                });
              return (
                <>
                  <header class="min-w-0">
                    <h1 class="break-words text-xl font-semibold">
                      {titleOf(props.a)}{" "}
                      <span class="font-normal text-muted-foreground">{t("compare.vs")}</span>{" "}
                      {titleOf(props.b)}
                    </h1>
                    <p class="mt-1 text-xs text-muted-foreground">{t("compare.scope")}</p>
                    <div class="mt-3 flex flex-wrap gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={swap}>
                        {t("compare.swap")}
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}>
                        {t("compare.change")}
                      </Button>
                    </div>
                  </header>

                  <section class="mt-4 grid grid-cols-1 gap-3 @min-[560px]/main:grid-cols-2">
                    <SideCard
                      mark="A"
                      id={props.a}
                      sessions={props.sessions}
                      backend={c().a.backend}
                      model={c().a.model}
                      tools={c().a.totals.tool_calls}
                      tokens={c().a.totals.input + c().a.totals.output}
                      cost={c().a.totals.cost_usd}
                    />
                    <SideCard
                      mark="B"
                      id={props.b}
                      sessions={props.sessions}
                      backend={c().b.backend}
                      model={c().b.model}
                      tools={c().b.totals.tool_calls}
                      tokens={c().b.totals.input + c().b.totals.output}
                      cost={c().b.totals.cost_usd}
                    />
                  </section>

                  <section class="mt-3 flex flex-col gap-1 rounded-lg border border-border bg-muted px-4 py-2.5 text-xs text-muted-foreground">
                    <p class="min-w-0 break-words text-foreground">{sentence()}</p>
                    <p class="min-w-0 break-words">
                      {tn("compare.summary.turnPairs", c().summary.turn_pairs)} ·{" "}
                      {tn("compare.summary.samePrompt", c().summary.same_prompt)}
                      <span class="text-muted-foreground"> · {t("compare.delta.mark")}</span>
                    </p>
                  </section>

                  <section class="mt-5 space-y-3">
                    <Show
                      when={c().turn_pairs.length > 0}
                      fallback={<EmptyState icon="compare" title={t("palette.empty")} class="py-10" />}
                    >
                      <For each={c().turn_pairs}>
                        {(p, i) => (
                          <TurnPairRow pair={p} i={i()} diverged={divergedAt() === i()} />
                        )}
                      </For>
                    </Show>
                  </section>
                </>
              );
            }}
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
      <ComparePick
        anchorId={replacing() ? props.a : undefined}
        sessions={props.sessions}
        onClose={() => setReplacing(false)}
        onPick={(id) => {
          setReplacing(false);
          if (id === props.b) return;
          location.hash = `/compare/${encodeURIComponent(props.a)}/${encodeURIComponent(id)}`;
        }}
      />
    </div>
  );
}
