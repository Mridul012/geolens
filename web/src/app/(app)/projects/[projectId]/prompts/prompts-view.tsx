"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { z } from "zod";
import { createPromptBodySchema, type PromptTemplate } from "@contracts/api/prompts";
import type { PromptResult, PromptRun } from "@contracts/api/prompt-runs";
import { apiFetch, ApiError, API_BASE_URL } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

interface PromptListPage {
  readonly data: PromptTemplate[];
}

interface PromptRunListPage {
  readonly data: PromptRun[];
  readonly nextCursor: string | null;
}

interface PromptResultListPage {
  readonly data: PromptResult[];
  readonly nextCursor: string | null;
}

type CreatePromptValues = z.infer<typeof createPromptBodySchema>;

/** No dedicated status type is exported from the contract — derive it from the resource. */
type PromptRunStatus = PromptRun["status"];

const IN_FLIGHT: PromptRunStatus[] = ["QUEUED", "RUNNING"];

const RUN_STATUS_VARIANT: Record<PromptRunStatus, "default" | "secondary" | "destructive"> = {
  QUEUED: "secondary",
  RUNNING: "secondary",
  COMPLETED: "default",
  COMPLETED_DEGRADED: "secondary",
  FAILED: "destructive",
};

interface LiveProgress {
  readonly cellsDone: number;
  readonly cellsTotal: number;
}

export function PromptsView({
  projectId,
  initialPrompts,
  initialRuns,
  initialRunsNextCursor,
}: {
  projectId: string;
  initialPrompts: PromptTemplate[];
  initialRuns: PromptRun[];
  initialRunsNextCursor: string | null;
}) {
  const queryClient = useQueryClient();
  const [addingPrompt, setAddingPrompt] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedResultId, setSelectedResultId] = useState<string | null>(null);
  const [liveProgress, setLiveProgress] = useState<LiveProgress | null>(null);

  const promptsQuery = useQuery({
    queryKey: ["prompts", projectId],
    queryFn: () => apiFetch<PromptListPage>(`/v1/projects/${projectId}/prompts`),
    initialData: { data: initialPrompts },
  });
  const prompts = promptsQuery.data.data;

  const runsQuery = useInfiniteQuery({
    queryKey: ["prompt-runs", projectId],
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams({ limit: "10" });
      if (pageParam) search.set("cursor", pageParam);
      return apiFetch<PromptRunListPage>(`/v1/projects/${projectId}/prompt-runs?${search.toString()}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    initialData: { pages: [{ data: initialRuns, nextCursor: initialRunsNextCursor }], pageParams: [null] },
  });
  const runs = runsQuery.data ? runsQuery.data.pages.flatMap((page) => page.data) : [];
  // Runs come back newest-first (docs/API.md §3), so the head of the list is the one that
  // matters for both the "run in flight" gate and which SSE stream to open.
  const latestRun = runs[0] ?? null;
  const inFlight = latestRun !== null && IN_FLIGHT.includes(latestRun.status);

  const resultsQuery = useQuery({
    queryKey: ["prompt-run-results", projectId, selectedRunId],
    queryFn: () =>
      apiFetch<PromptResultListPage>(
        `/v1/projects/${projectId}/prompt-runs/${selectedRunId}/results?limit=50`,
      ),
    enabled: selectedRunId !== null,
  });
  const results = resultsQuery.data?.data ?? [];
  const selectedResult = results.find((result) => result.id === selectedResultId) ?? null;

  const startRun = useMutation({
    mutationFn: () =>
      apiFetch<PromptRun>(`/v1/projects/${projectId}/prompt-runs`, {
        method: "POST",
        // Mirrors dashboard-view.tsx's start-crawl trigger: the body schema defaults an
        // omitted body to {} but rejects a literal `null`, which is what an empty POST
        // with no explicit body parses to server-side.
        body: {},
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["prompt-runs", projectId] }),
    onError: (error) => toast.error(errorMessage(error)),
  });

  // Live SSE progress while the latest run is in-flight. The run row (refetched via
  // `prompt-runs`) is the source of truth once it finishes — on `done`/`error` we close the
  // stream and invalidate both the run list and this run's results.
  useEffect(() => {
    if (!inFlight || !latestRun) return;
    const runId = latestRun.id;

    const source = new EventSource(
      `${API_BASE_URL}/v1/projects/${projectId}/prompt-runs/${runId}/progress`,
      { withCredentials: true },
    );

    const handleProgress = (event: MessageEvent) => {
      try {
        setLiveProgress(JSON.parse(event.data as string) as LiveProgress);
      } catch {
        // Malformed frame — ignore, next tick will correct itself.
      }
    };

    const finish = () => {
      source.close();
      void queryClient.invalidateQueries({ queryKey: ["prompt-runs", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["prompt-run-results", projectId, runId] });
    };

    const handleError = (event: Event) => {
      const data = (event as MessageEvent).data as string | undefined;
      if (typeof data === "string") {
        try {
          const problem = JSON.parse(data) as { detail?: string; title?: string };
          toast.error(problem.detail ?? problem.title ?? "Prompt run progress stream failed.");
        } catch {
          // Not a Problem frame — likely the browser's own connection-error event.
        }
      }
      finish();
    };

    source.addEventListener("progress", handleProgress);
    source.addEventListener("done", finish);
    source.addEventListener("error", handleError);

    return () => {
      source.removeEventListener("progress", handleProgress);
      source.removeEventListener("done", finish);
      source.removeEventListener("error", handleError);
      source.close();
    };
  }, [inFlight, latestRun, projectId, queryClient]);

  const progressPercent =
    liveProgress && liveProgress.cellsTotal > 0
      ? Math.min(100, Math.round((liveProgress.cellsDone / liveProgress.cellsTotal) * 100))
      : null;

  return (
    <div className="flex flex-col gap-6 p-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Prompts</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Real answers from real AI engines to the questions your buyers ask.
          </p>
        </div>
        <Button onClick={() => startRun.mutate()} disabled={startRun.isPending || inFlight}>
          {inFlight ? "Run in progress…" : "Run now →"}
        </Button>
      </div>

      {inFlight && (
        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <SectionLabel>Live progress</SectionLabel>
          <Progress value={progressPercent} className="mt-3" />
          <p className="mt-2 text-xs text-muted-foreground">
            {liveProgress
              ? `${liveProgress.cellsDone} / ${liveProgress.cellsTotal} cells`
              : "Waiting for the run to start…"}
          </p>
        </div>
      )}

      <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <SectionLabel>Tracked prompts</SectionLabel>
          {!addingPrompt && (
            <Button variant="outline" size="sm" onClick={() => setAddingPrompt(true)}>
              Add prompt
            </Button>
          )}
        </div>

        {prompts.length === 0 ? (
          <EmptyRow text="No prompts tracked yet — add one to start measuring AI answers." />
        ) : (
          <div className="mt-3 flex flex-col">
            {prompts.map((prompt) => (
              <PromptRow key={prompt.id} projectId={projectId} prompt={prompt} />
            ))}
          </div>
        )}

        {addingPrompt && (
          <AddPromptForm projectId={projectId} onDone={() => setAddingPrompt(false)} />
        )}
      </div>

      <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        <SectionLabel>Run history</SectionLabel>
        {runs.length === 0 ? (
          <EmptyRow text="No prompt runs yet — click “Run now” to get your first answers." />
        ) : (
          <div className="mt-3 overflow-hidden rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Engines</TableHead>
                  <TableHead>Mention rate</TableHead>
                  <TableHead>Citation share</TableHead>
                  <TableHead>Queued</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow
                    key={run.id}
                    className="cursor-pointer"
                    data-state={run.id === selectedRunId ? "selected" : undefined}
                    onClick={() => setSelectedRunId(run.id)}
                  >
                    <TableCell>
                      <Badge variant={RUN_STATUS_VARIANT[run.status]}>{run.status}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {run.trigger === "MANUAL" ? "Manual" : "Scheduled"}
                    </TableCell>
                    <TableCell className="text-sm">{run.engines.join(", ") || "—"}</TableCell>
                    <TableCell className="text-sm">{formatPercent(run.mentionRate)}</TableCell>
                    <TableCell className="text-sm">{formatPercent(run.citationShare)}</TableCell>
                    <TableCell className="text-sm">{relativeTime(run.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {runsQuery.hasNextPage && (
          <Button
            variant="outline"
            onClick={() => runsQuery.fetchNextPage()}
            disabled={runsQuery.isFetchingNextPage}
            className="mt-4"
          >
            {runsQuery.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        )}
      </div>

      {selectedRunId && (
        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <SectionLabel>Results</SectionLabel>
          {resultsQuery.isLoading ? (
            <div className="mt-3 flex flex-col gap-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : results.length === 0 ? (
            <EmptyRow text="No results for this run yet." />
          ) : (
            <div className="mt-3 overflow-hidden rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Engine</TableHead>
                    <TableHead>Mentioned</TableHead>
                    <TableHead>Cited</TableHead>
                    <TableHead>Sentiment</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.map((result) => (
                    <TableRow key={result.id}>
                      <TableCell className="text-sm font-semibold">{result.engine}</TableCell>
                      <TableCell>
                        <Badge variant={result.brandMentioned ? "default" : "outline"}>
                          {result.brandMentioned ? "Mentioned" : "Not mentioned"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={result.brandCited ? "default" : "outline"}>
                          {result.brandCited ? "Cited" : "Not cited"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {result.sentiment ? (
                          <Badge variant="secondary">{result.sentiment}</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSelectedResultId(result.id)}
                        >
                          View answer
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      <Sheet
        open={selectedResultId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedResultId(null);
        }}
      >
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
          {selectedResult && <ResultDetailPanel result={selectedResult} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function PromptRow({ projectId, prompt }: { projectId: string; prompt: PromptTemplate }) {
  const queryClient = useQueryClient();

  const update = useMutation({
    mutationFn: (body: { pinned?: boolean; status?: "ACTIVE" | "ARCHIVED" }) =>
      // `text` is never sent from here — pin/archive only. See createPromptBodySchema's
      // sibling `updatePromptBodySchema`: sending `text` gets a 403 PROMPT_TEXT_IMMUTABLE.
      apiFetch<PromptTemplate>(`/v1/projects/${projectId}/prompts/${prompt.id}`, {
        method: "PATCH",
        body,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["prompts", projectId] }),
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <div className="flex items-center gap-3 border-b border-border py-3.5 last:border-none">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{prompt.text}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {prompt.intent && <Badge variant="secondary">{prompt.intent}</Badge>}
          <Badge variant="outline">{prompt.source}</Badge>
        </div>
      </div>
      <Button
        variant={prompt.pinned ? "secondary" : "outline"}
        size="sm"
        onClick={() => update.mutate({ pinned: !prompt.pinned })}
        disabled={update.isPending}
      >
        {prompt.pinned ? "Pinned" : "Pin"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => update.mutate({ status: "ARCHIVED" })}
        disabled={update.isPending}
      >
        Archive
      </Button>
    </div>
  );
}

function AddPromptForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreatePromptValues>({
    resolver: zodResolver(createPromptBodySchema),
    defaultValues: { text: "", intent: "" },
  });

  const mutation = useMutation({
    mutationFn: (values: CreatePromptValues) =>
      apiFetch<PromptTemplate>(`/v1/projects/${projectId}/prompts`, {
        method: "POST",
        body: values,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompts", projectId] });
      reset();
      onDone();
    },
  });

  return (
    <div className="mt-4 rounded-xl border-2 border-dashed border-border p-4">
      {mutation.isError && (
        <Alert variant="destructive" className="mb-3">
          <AlertDescription>{errorMessage(mutation.error)}</AlertDescription>
        </Alert>
      )}
      <form
        onSubmit={handleSubmit((values) => mutation.mutate(values))}
        className="flex flex-col gap-3"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="prompt-text">Prompt text</Label>
          <textarea
            id="prompt-text"
            rows={3}
            className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            {...register("text")}
          />
          {errors.text && <p className="text-xs text-destructive">{errors.text.message}</p>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="prompt-intent">
            Intent <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="prompt-intent"
            {...register("intent", {
              // An empty text input is "", not undefined — the schema's `.optional()` only
              // accepts the latter.
              setValueAs: (value: string) => (value === "" ? undefined : value),
            })}
          />
          {errors.intent && <p className="text-xs text-destructive">{errors.intent.message}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={mutation.isPending}>
            {mutation.isPending ? "Adding…" : "Add prompt"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

function ResultDetailPanel({ result }: { result: PromptResult }) {
  return (
    <>
      <SheetHeader>
        <SheetTitle>{result.engine}</SheetTitle>
        <SheetDescription>{result.model}</SheetDescription>
      </SheetHeader>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={result.brandMentioned ? "default" : "outline"}>
            {result.brandMentioned ? "Brand mentioned" : "Brand not mentioned"}
          </Badge>
          <Badge variant={result.brandCited ? "default" : "outline"}>
            {result.brandCited ? "Brand cited" : "Brand not cited"}
          </Badge>
          {result.sentiment && <Badge variant="secondary">{result.sentiment}</Badge>}
        </div>

        {result.competitorsMentioned && result.competitorsMentioned.length > 0 && (
          <div>
            <SectionLabel>Competitors mentioned</SectionLabel>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {result.competitorsMentioned.map((competitor) => (
                <Badge key={competitor.name} variant={competitor.cited ? "default" : "outline"}>
                  {competitor.name}
                  {competitor.cited ? " · cited" : ""}
                </Badge>
              ))}
            </div>
          </div>
        )}

        <div>
          <SectionLabel>Answer</SectionLabel>
          {/* The answer text is the product's credibility moment — render it verbatim,
              never paraphrased or truncated (docs/Frontend-Design.md). */}
          {result.answerText === null ? (
            <Alert variant="destructive" className="mt-2">
              <AlertDescription>
                {result.error ?? "This engine returned no answer."}
              </AlertDescription>
            </Alert>
          ) : (
            <p className="mt-2 text-sm whitespace-pre-wrap text-foreground">
              {result.answerText}
            </p>
          )}
        </div>

        {result.citations && result.citations.length > 0 && (
          <div>
            <SectionLabel>Citations</SectionLabel>
            <ul className="mt-2 flex flex-col gap-1.5">
              {result.citations.map((citation) => (
                <li key={citation} className="truncate text-xs">
                  <a
                    href={citation}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline underline-offset-4 hover:text-primary/80"
                  >
                    {citation}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
      {children}
    </span>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <p className="mt-3 text-sm text-muted-foreground">{text}</p>;
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const hours = Math.round(diffMs / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.problem.detail ?? error.problem.title;
  return "Something went wrong. Please try again.";
}
