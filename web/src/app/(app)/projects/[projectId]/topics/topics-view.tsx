"use client";

import type { ReactNode } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import { createTopicBodySchema, type Topic } from "@contracts/api/topics";
import type { TopicCoverage, TopicCoverageResponse } from "@contracts/api/coverage";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface TopicsListResponse {
  readonly data: Topic[];
}

type CreateTopicValues = z.infer<typeof createTopicBodySchema>;

export function TopicsView({
  projectId,
  initialTopics,
  initialCoverage,
}: {
  projectId: string;
  initialTopics: Topic[];
  initialCoverage: TopicCoverageResponse;
}) {
  const { data: topicsData } = useQuery({
    queryKey: ["topics", projectId],
    queryFn: () => apiFetch<TopicsListResponse>(`/v1/projects/${projectId}/topics`),
    initialData: { data: initialTopics },
  });

  const { data: coverage } = useQuery({
    queryKey: ["topics-coverage", projectId],
    queryFn: () => apiFetch<TopicCoverageResponse>(`/v1/projects/${projectId}/topics/coverage`),
    initialData: initialCoverage,
  });

  return (
    <div className="flex flex-col gap-6 p-10">
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight">Topics & Coverage</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          The topics AI engines associate with your site, and how your coverage compares to
          your competitor&apos;s.
        </p>
      </div>

      <TaxonomySection topics={topicsData.data} projectId={projectId} />
      <CoverageSection coverage={coverage} />
    </div>
  );
}

function TaxonomySection({ topics, projectId }: { topics: Topic[]; projectId: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <SectionLabel>Taxonomy</SectionLabel>

      {topics.length === 0 ? (
        <EmptyRow text="No topics yet — add one below." />
      ) : (
        <div className="mt-3 flex flex-col">
          {topics.map((topic) => (
            <TopicRow key={topic.id} topic={topic} projectId={projectId} />
          ))}
        </div>
      )}

      <AddTopicForm projectId={projectId} />
    </div>
  );
}

function TopicRow({ topic, projectId }: { topic: Topic; projectId: string }) {
  const queryClient = useQueryClient();
  const archived = topic.status === "ARCHIVED";

  const toggleStatus = useMutation({
    mutationFn: () =>
      apiFetch<Topic>(`/v1/projects/${projectId}/topics/${topic.id}`, {
        method: "PATCH",
        body: { status: archived ? "ACTIVE" : "ARCHIVED" },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["topics", projectId] }),
  });

  return (
    <div
      className={`flex items-start justify-between gap-3.5 border-b border-border py-3.5 last:border-none${
        archived ? " opacity-60" : ""
      }`}
    >
      <div className="flex flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{topic.label}</span>
          <Badge variant="secondary">{topic.source}</Badge>
          {topic.buyerIntent !== null && <Badge variant="outline">{topic.buyerIntent}</Badge>}
          {archived && <Badge variant="outline">Archived</Badge>}
        </div>
        {topic.description && (
          <p className="text-xs text-muted-foreground">{topic.description}</p>
        )}
        {toggleStatus.isError && (
          <p className="text-xs text-destructive">{errorMessage(toggleStatus.error)}</p>
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => toggleStatus.mutate()}
        disabled={toggleStatus.isPending}
      >
        {archived ? "Unarchive" : "Archive"}
      </Button>
    </div>
  );
}

function AddTopicForm({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateTopicValues>({
    resolver: zodResolver(createTopicBodySchema),
  });

  const mutation = useMutation({
    mutationFn: (values: CreateTopicValues) =>
      apiFetch<Topic>(`/v1/projects/${projectId}/topics`, { method: "POST", body: values }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["topics", projectId] });
      reset();
    },
  });

  return (
    <div className="mt-5 rounded-xl border-2 border-dashed border-border p-5">
      <div className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
        Add topic
      </div>

      {mutation.isError && (
        <Alert variant="destructive" className="mt-3">
          <AlertDescription>{errorMessage(mutation.error)}</AlertDescription>
        </Alert>
      )}

      <form
        onSubmit={handleSubmit((values) => mutation.mutate(values))}
        className="mt-3 flex flex-col gap-3.5 sm:flex-row sm:items-end"
      >
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="topic-label">Label</Label>
          <Input id="topic-label" {...register("label")} />
          {errors.label && <p className="text-xs text-destructive">{errors.label.message}</p>}
        </div>
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="topic-description">
            Description <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          {/* No shadcn Textarea is installed; a plain textarea styled to match Input keeps
              this screen from adding a new primitive that other in-flight screens might also
              be installing right now. */}
          <textarea
            id="topic-description"
            rows={1}
            className="min-h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30"
            aria-invalid={errors.description ? "true" : undefined}
            {...register("description", {
              setValueAs: (value: string) => (value === "" ? undefined : value),
            })}
          />
          {errors.description && (
            <p className="text-xs text-destructive">{errors.description.message}</p>
          )}
        </div>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? "Adding…" : "Add topic"}
        </Button>
      </form>
    </div>
  );
}

function CoverageSection({ coverage }: { coverage: TopicCoverageResponse }) {
  const hasCompetitorCrawl = coverage.competitorCrawlId !== null;

  // Missing rows (strong for the competitor, absent for us) are the most actionable —
  // surface them first, then rank the rest by the widest gap.
  const rows = [...coverage.data].sort((a: TopicCoverage, b: TopicCoverage) => {
    if (a.missing !== b.missing) return a.missing ? -1 : 1;
    const aGap = a.gap ?? Number.NEGATIVE_INFINITY;
    const bGap = b.gap ?? Number.NEGATIVE_INFINITY;
    return bGap - aGap;
  });

  return (
    <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <SectionLabel>Coverage</SectionLabel>

      {!hasCompetitorCrawl && (
        <NotYetMeasured caption="No competitor crawl yet — competitor coverage and gap will appear once a competitor site has a completed crawl." />
      )}

      {rows.length === 0 ? (
        <EmptyRow text="No coverage data yet." />
      ) : (
        <Table className="mt-3">
          <TableHeader>
            <TableRow>
              <TableHead>Topic</TableHead>
              <TableHead>Own coverage</TableHead>
              <TableHead>Own depth</TableHead>
              <TableHead>Competitor coverage</TableHead>
              <TableHead>Gap</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.topicId}>
                <TableCell className="font-semibold">{row.label}</TableCell>
                <TableCell>
                  <NullSafeValue value={row.ownCoverage} />
                </TableCell>
                <TableCell>
                  <NullSafeValue value={row.ownDepth} />
                </TableCell>
                <TableCell>
                  {hasCompetitorCrawl ? (
                    <NullSafeValue value={row.competitorCoverage} />
                  ) : (
                    <MutedDash />
                  )}
                </TableCell>
                <TableCell>
                  {hasCompetitorCrawl ? <GapValue gap={row.gap} /> : <MutedDash />}
                </TableCell>
                <TableCell>{row.missing && <Badge variant="destructive">Missing</Badge>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function NullSafeValue({ value }: { value: number | null }) {
  if (value === null) return <MutedDash />;
  return <span>{value}</span>;
}

function GapValue({ gap }: { gap: number | null }) {
  if (gap === null) return <MutedDash />;
  if (gap > 0) return <span className="font-semibold text-destructive">+{gap}</span>;
  return <span className="text-muted-foreground">{gap}</span>;
}

function MutedDash() {
  return <span className="font-semibold text-muted-foreground/50">—</span>;
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
      {children}
    </span>
  );
}

function NotYetMeasured({ caption }: { caption: string }) {
  return (
    <div className="mt-3 flex items-center gap-3 rounded-xl border-2 border-dashed border-border bg-secondary/50 px-4 py-3">
      <span className="text-lg font-extrabold text-muted-foreground/50">—</span>
      <span className="text-xs text-muted-foreground">{caption}</span>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <p className="mt-3 text-sm text-muted-foreground">{text}</p>;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.problem.detail ?? error.problem.title;
  return "Something went wrong. Please try again.";
}
