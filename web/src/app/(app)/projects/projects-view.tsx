"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createProjectBodySchema, type Project } from "@contracts/api/projects";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { z } from "zod";

interface ProjectsPage {
  readonly data: Project[];
  readonly nextCursor: string | null;
}

// The schema defaults `timezone`, so its input (raw form values) and output (submitted
// body) shapes differ — RHF needs both to type the resolver and the submit handler.
type CreateProjectInput = z.input<typeof createProjectBodySchema>;
type CreateProjectOutput = z.output<typeof createProjectBodySchema>;

export function ProjectsView({ initialProjects }: { initialProjects: Project[] }) {
  const [creating, setCreating] = useState(initialProjects.length === 0);

  const { data } = useQuery({
    queryKey: ["projects"],
    queryFn: () => apiFetch<ProjectsPage>("/v1/projects"),
    initialData: { data: initialProjects, nextCursor: null },
  });

  const projects = data.data;

  return (
    <div className="flex flex-col gap-9">
      <div>
        <h1 className="text-[37px] leading-tight font-extrabold tracking-[-0.02em]">Your projects</h1>
        <p className="mt-1.5 text-muted-foreground">
          Pick one to open, or start tracking a new site.
        </p>
      </div>

      {projects.length > 0 && (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
          {!creating && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex min-h-[180px] flex-col items-center justify-center gap-2.5 rounded-[10px] border border-dashed border-input text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary">
                <PlusIcon className="h-4.5 w-4.5" />
              </span>
              <span className="text-sm font-semibold">New project</span>
            </button>
          )}
        </div>
      )}

      {creating && <CreateProjectCard onCancel={projects.length > 0 ? () => setCreating(false) : undefined} />}
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const ownSite = project.sites.find((site) => site.role === "OWN");
  const competitor = project.sites.find((site) => site.role === "COMPETITOR");

  return (
    <Link
      href={`/projects/${project.id}`}
      className="flex flex-col gap-3.5 panel p-6 transition-colors hover:border-foreground"
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-foreground text-sm font-extrabold text-background">
        {project.name.slice(0, 2).toUpperCase()}
      </div>
      <div className="text-[17px] font-bold">{project.name}</div>
      <div className="text-sm text-muted-foreground">{ownSite?.domain ?? "no site"}</div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
        {competitor ? `vs. ${competitor.domain}` : "no competitor added"}
      </div>
    </Link>
  );
}

function CreateProjectCard({ onCancel }: { onCancel?: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateProjectInput, unknown, CreateProjectOutput>({
    resolver: zodResolver(createProjectBodySchema),
    defaultValues: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
  });

  const mutation = useMutation({
    mutationFn: (values: CreateProjectOutput) =>
      apiFetch<Project>("/v1/projects", { method: "POST", body: values }),
    onSuccess: async (project) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      router.push(`/projects/${project.id}`);
    },
  });

  return (
    <div className="max-w-xl panel p-9">
      <h2 className="text-[21px] font-extrabold tracking-[-0.01em]">Track a new site</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Add your site and, optionally, one competitor. You start the first crawl from the
        dashboard.
      </p>

      {mutation.isError && (
        <Alert variant="destructive" className="mt-5">
          <AlertDescription>{errorMessage(mutation.error)}</AlertDescription>
        </Alert>
      )}

      <form
        onSubmit={handleSubmit((values) => mutation.mutate(values))}
        className="mt-6 flex flex-col gap-4.5"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">Project name</Label>
          <Input id="name" {...register("name")} />
          {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="url">Your website</Label>
          <Input id="url" placeholder="https://acme.com" {...register("url")} />
          {errors.url && <p className="text-xs text-destructive">{errors.url.message}</p>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="competitorUrl">
            Competitor <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="competitorUrl"
            placeholder="https://competitor.com"
            {...register("competitorUrl", {
              // An empty text input is "", not undefined — the schema's `.optional()` only
              // accepts the latter (its `.min(1)` rejects an empty string as present-but-invalid).
              setValueAs: (value: string) => (value === "" ? undefined : value),
            })}
          />
        </div>
        <div className="mt-1 flex items-center gap-3">
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Creating…" : "Create project"}
          </Button>
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.problem.detail ?? error.problem.title;
  return "Something went wrong. Please try again.";
}
