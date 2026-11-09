"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import { updateProjectBodySchema } from "@contracts/api/projects";
import type { Project, ProjectDetail, Site } from "@contracts/api/projects";
import { apiFetch, ApiError } from "@/lib/api/client";
import { problemMessage } from "@/lib/api/problem-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";

/** Every cached query for this project — the sidebar, comparison and dashboard included. */
function invalidateProject(queryClient: QueryClient, projectId: string) {
  return queryClient.invalidateQueries({
    predicate: (query) => query.queryKey.includes(projectId),
  });
}

export function SettingsView({
  project,
  initialCompetitors,
}: {
  project: ProjectDetail;
  initialCompetitors: Site[];
}) {
  return (
    <div className="flex flex-col gap-6 p-5 md:p-10">
      <div>
        <h1 className="text-[28px] leading-tight font-extrabold tracking-[-0.02em]">Settings</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Project details, the competitor you are measured against, and deletion.
        </p>
      </div>
      <GeneralSection project={project} />
      <CompetitorsSection projectId={project.id} initialCompetitors={initialCompetitors} />
      <DeleteSection project={project} />
    </div>
  );
}

// ─── General ───────────────────────────────────────────────────────────────────────────

/** The contract's own PATCH rules, with both fields present (the form always shows both). */
const generalSchema = updateProjectBodySchema.innerType().pick({ name: true, timezone: true }).required();

type GeneralValues = z.infer<typeof generalSchema>;

function GeneralSection({ project }: { project: ProjectDetail }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState<GeneralValues>({
    name: project.name,
    timezone: project.timezone,
  });
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<GeneralValues>({ defaultValues: saved, resolver: zodResolver(generalSchema) });

  const [name, timezone] = useWatch({ control, name: ["name", "timezone"] });
  const changes: Partial<GeneralValues> = {
    ...(name !== saved.name ? { name } : {}),
    ...(timezone !== saved.timezone ? { timezone } : {}),
  };
  const dirty = Object.keys(changes).length > 0;

  const update = useMutation({
    // Only changed fields are sent: the contract requires at least one, and an untouched
    // field must never be rewritten with a stale value.
    mutationFn: (body: Partial<GeneralValues>) =>
      apiFetch<Project>(`/v1/projects/${project.id}`, { method: "PATCH", body }),
    onSuccess: (updated) => {
      setSaved({ name: updated.name, timezone: updated.timezone });
      toast.success("Project updated");
      void invalidateProject(queryClient, project.id);
      router.refresh();
    },
  });

  return (
    <Section title="General">
      <form
        onSubmit={handleSubmit(() => dirty && update.mutate(changes))}
        className="mt-4 flex max-w-lg flex-col gap-4"
      >
        {update.isError && (
          <Alert variant="destructive">
            <AlertDescription>{problemMessage(update.error)}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-name">Project name</Label>
          <Input id="project-name" {...register("name")} />
          {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-timezone">Timezone</Label>
          <Input id="project-timezone" placeholder="e.g. Asia/Kolkata" {...register("timezone")} />
          <p className="text-xs text-muted-foreground">
            IANA name. Weekly runs and digests are scheduled in this timezone.
          </p>
          {errors.timezone && (
            <p className="text-xs text-destructive">{errors.timezone.message}</p>
          )}
        </div>
        <Button type="submit" disabled={!dirty || update.isPending} className="w-fit">
          {update.isPending ? "Saving…" : "Save changes"}
        </Button>
      </form>
    </Section>
  );
}

// ─── Competitors ───────────────────────────────────────────────────────────────────────

interface CompetitorValues {
  url: string;
  name: string;
}

function CompetitorsSection({
  projectId,
  initialCompetitors,
}: {
  projectId: string;
  initialCompetitors: Site[];
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: competitors } = useQuery({
    queryKey: ["competitors", projectId],
    queryFn: async () =>
      (await apiFetch<{ data: Site[] }>(`/v1/projects/${projectId}/competitors`)).data,
    initialData: initialCompetitors,
  });

  const { register, handleSubmit, reset } = useForm<CompetitorValues>({
    defaultValues: { url: "", name: "" },
  });

  const afterChange = () => {
    void invalidateProject(queryClient, projectId);
    router.refresh();
  };

  const add = useMutation({
    mutationFn: (values: CompetitorValues) =>
      apiFetch<Site>(`/v1/projects/${projectId}/competitors`, {
        method: "POST",
        body: {
          url: values.url.trim(),
          ...(values.name.trim() === "" ? {} : { name: values.name.trim() }),
        },
      }),
    onSuccess: (site) => {
      reset();
      toast.success(`Now comparing against ${site.domain}`);
      afterChange();
    },
  });

  const remove = useMutation({
    mutationFn: (site: Site) =>
      apiFetch<void>(`/v1/projects/${projectId}/competitors/${site.id}`, { method: "DELETE" }),
    onSuccess: (_, site) => {
      toast.success(`Stopped comparing against ${site.domain}`);
      afterChange();
    },
    onError: (error) => toast.error(problemMessage(error)),
  });

  return (
    <Section
      title="Competitor"
      description="Comparison and share of voice are measured against this site. Removing it keeps its crawl history but detaches it from comparisons."
    >
      {competitors.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No competitor yet.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-2">
          {competitors.map((site) => (
            <li
              key={site.id}
              className="flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{site.name ?? site.domain}</p>
                <p className="truncate text-xs text-muted-foreground">{site.url}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={remove.isPending}
                onClick={() => remove.mutate(site)}
                aria-label={`Remove ${site.domain}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={handleSubmit((values) => add.mutate(values))}
        className="mt-5 flex max-w-lg flex-col gap-3"
      >
        {add.isError && (
          <Alert variant="destructive">
            <AlertDescription>{competitorError(add.error)}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="competitor-url">Competitor URL</Label>
          <Input
            id="competitor-url"
            placeholder="https://competitor.com"
            {...register("url", { required: true })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="competitor-name">
            Name <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input id="competitor-name" {...register("name")} />
        </div>
        <Button type="submit" variant="outline" disabled={add.isPending} className="w-fit">
          {add.isPending ? "Adding…" : "Add competitor"}
        </Button>
      </form>
    </Section>
  );
}

function competitorError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.problem.code === "PLAN_LIMIT_EXCEEDED") {
      return "Your plan allows one competitor per project. Remove the current one first.";
    }
    if (error.problem.code === "INVALID_URL") {
      return error.problem.detail ?? "That doesn't look like a website address we can crawl.";
    }
  }
  return problemMessage(error);
}

// ─── Delete ────────────────────────────────────────────────────────────────────────────

function DeleteSection({ project }: { project: ProjectDetail }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");

  const destroy = useMutation({
    mutationFn: () =>
      apiFetch<{ status: "PURGE_SCHEDULED" }>(`/v1/projects/${project.id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      queryClient.removeQueries({ predicate: (query) => query.queryKey.includes(project.id) });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      toast.success(`${project.name} was deleted`);
      router.replace("/projects");
      router.refresh();
    },
  });

  return (
    <Section
      title="Delete project"
      description="Deletes this project for good: crawls, scores, prompt history, recommendations and reports. Snapshots are purged from storage within 30 days. This cannot be undone."
      danger
    >
      {destroy.isError && (
        <Alert variant="destructive" className="mt-4">
          <AlertDescription>{problemMessage(destroy.error)}</AlertDescription>
        </Alert>
      )}
      {!confirming ? (
        <Button variant="destructive" className="mt-4 w-fit" onClick={() => setConfirming(true)}>
          Delete project…
        </Button>
      ) : (
        <div className="mt-4 flex max-w-lg flex-col gap-3">
          <Label htmlFor="confirm-delete">
            Type <span className="font-bold">{project.name}</span> to confirm
          </Label>
          <Input
            id="confirm-delete"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
          />
          <div className="flex gap-2">
            <Button
              variant="destructive"
              disabled={typed !== project.name || destroy.isPending}
              onClick={() => destroy.mutate()}
            >
              {destroy.isPending ? "Deleting…" : "Delete forever"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setConfirming(false);
                setTyped("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

// ─── Layout ────────────────────────────────────────────────────────────────────────────

function Section({
  title,
  description,
  danger = false,
  children,
}: {
  title: string;
  description?: string;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={
        danger
          ? "panel border-destructive p-6"
          : "panel p-6"
      }
    >
      <h2 className="text-base font-bold tracking-tight">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      {children}
    </section>
  );
}
