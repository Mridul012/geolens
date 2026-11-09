"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Report, ReportSection } from "@contracts/api/reports";
import { REPORT_SECTIONS } from "@contracts/api/reports";

type ReportKind = Report["kind"];
type ReportStatus = Report["status"];
import { apiFetch, ApiError, API_BASE_URL } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface ReportsPage {
  readonly data: Report[];
  readonly nextCursor: string | null;
}

const NON_TERMINAL: ReportStatus[] = ["QUEUED", "GENERATING"];

const SECTION_LABELS: Record<ReportSection, string> = {
  summary: "Summary",
  score: "Score",
  trends: "Trends",
  recommendations: "Recommendations",
  comparison: "Comparison",
};

export function ReportsView({
  projectId,
  initialReports,
}: {
  projectId: string;
  initialReports: ReportsPage;
}) {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [selectedSections, setSelectedSections] = useState<ReportSection[]>([
    ...REPORT_SECTIONS,
  ]);

  const { data: reports } = useQuery({
    queryKey: ["reports", projectId],
    queryFn: () => apiFetch<ReportsPage>(`/v1/projects/${projectId}/reports?limit=20`),
    initialData: initialReports,
    refetchInterval: (query) => {
      const data = query.state.data?.data ?? [];
      return data.some((report) => NON_TERMINAL.includes(report.status)) ? 3000 : false;
    },
  });

  const generateReport = useMutation({
    mutationFn: () => {
      // An empty or an all-checked selection both mean "omit `sections`" per the API
      // contract (it defaults to all five) — only send the field when the user has
      // deliberately deselected something.
      const allChecked = selectedSections.length === REPORT_SECTIONS.length;
      const sections =
        selectedSections.length === 0 || allChecked ? undefined : selectedSections;
      return apiFetch<Report>(`/v1/projects/${projectId}/reports`, {
        method: "POST",
        body: sections ? { sections } : {},
        idempotencyKey: crypto.randomUUID(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reports", projectId] });
      setFormOpen(false);
      setSelectedSections([...REPORT_SECTIONS]);
    },
    onError: (error) => {
      if (error instanceof ApiError && error.problem.code === "NO_COMPLETED_CRAWL") {
        toast.error("Run a crawl before generating a report");
        return;
      }
      // 409 IDEMPOTENCY_KEY_REUSED is an internal-only edge case (a client bug, not a
      // user-actionable state) — a generic error toast is fine.
      toast.error(errorMessage(error));
    },
  });

  function toggleSection(section: ReportSection) {
    setSelectedSections((prev) =>
      prev.includes(section) ? prev.filter((s) => s !== section) : [...prev, section],
    );
  }

  return (
    <div className="flex flex-col gap-6 p-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Reports</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Generate and download PDF snapshots of your AI visibility.
          </p>
        </div>
        <Button onClick={() => setFormOpen((open) => !open)}>
          {formOpen ? "Cancel" : "Generate report"}
        </Button>
      </div>

      {formOpen && (
        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <SectionLabel>Sections to include</SectionLabel>
          <div className="mt-3 flex flex-wrap gap-4">
            {REPORT_SECTIONS.map((section) => (
              <label key={section} className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-border accent-primary"
                  checked={selectedSections.includes(section)}
                  onChange={() => toggleSection(section)}
                />
                {SECTION_LABELS[section]}
              </label>
            ))}
          </div>
          <Button
            className="mt-5"
            onClick={() => generateReport.mutate()}
            disabled={generateReport.isPending}
          >
            {generateReport.isPending ? "Generating…" : "Generate"}
          </Button>
        </div>
      )}

      <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
        {reports.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reports yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Generated</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Download</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.data.map((report) => (
                <TableRow key={report.id}>
                  <TableCell className="font-medium">{formatKind(report.kind)}</TableCell>
                  <TableCell>
                    <StatusBadge status={report.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatSize(report.sizeBytes)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(report.generatedAt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(report.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {report.status === "READY" ? (
                      <a
                        href={`${API_BASE_URL}/v1/projects/${projectId}/reports/${report.id}/download`}
                        className="text-sm font-semibold text-primary underline-offset-4 hover:underline"
                      >
                        Download
                      </a>
                    ) : (
                      <Button variant="outline" size="sm" disabled>
                        Download
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ReportStatus }) {
  const variant =
    status === "FAILED" ? "destructive" : status === "READY" ? "default" : "secondary";
  return <Badge variant={variant}>{status}</Badge>;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs font-bold tracking-wide text-muted-foreground uppercase">
      {children}
    </span>
  );
}

function formatKind(kind: ReportKind): string {
  return kind === "ON_DEMAND" ? "On demand" : "Scheduled";
}

function formatSize(sizeBytes: number | null): string {
  if (sizeBytes === null) return "—";
  return `${(sizeBytes / 1024).toFixed(0)} KB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  // Pinned locale — this SSR'd client component must render the exact same string on the
  // server and in the browser, and no-args toLocaleString resolves to each environment's
  // own default locale, which caused a hydration mismatch.
  return new Date(iso).toLocaleString("en-US");
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.problem.detail ?? error.problem.title;
  return "Something went wrong. Please try again.";
}
