"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Globe,
  ShieldCheck,
  Layers,
  MessageSquare,
  GitCompare,
  Lightbulb,
  FileText,
  CreditCard,
  type LucideIcon,
} from "lucide-react";
import type { ProjectDetail } from "@contracts/api/projects";
import type { Me } from "@contracts/api/auth";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

const NAV_ITEMS: ReadonlyArray<{ label: string; segment: string; icon: LucideIcon }> = [
  { label: "Crawls", segment: "crawls", icon: Globe },
  { label: "Crawler Access", segment: "crawler-access", icon: ShieldCheck },
  { label: "Topics & Coverage", segment: "topics", icon: Layers },
  { label: "Prompt Tracking", segment: "prompts", icon: MessageSquare },
  { label: "Comparison", segment: "comparison", icon: GitCompare },
  { label: "Recommendations", segment: "recommendations", icon: Lightbulb },
  { label: "Reports", segment: "reports", icon: FileText },
  { label: "Billing", segment: "billing", icon: CreditCard },
];

export function Sidebar({ project, me }: { project: ProjectDetail; me: Me }) {
  const pathname = usePathname();
  const dashboardHref = `/projects/${project.id}`;
  const isDashboardActive = pathname === dashboardHref;

  return (
    <aside className="flex w-60 min-w-60 flex-col gap-6 border-r border-border bg-card p-4">
      <Link href="/projects" className="flex items-center gap-2.5 px-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-primary">
          <svg viewBox="0 0 24 24" fill="none" className="h-4.5 w-4.5 text-primary-foreground">
            <path
              d="M4 12L10 18L20 6"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <span className="text-lg font-bold tracking-tight text-foreground">GEOlens</span>
      </Link>

      <Link
        href="/projects"
        className="flex items-center justify-between gap-2 rounded-[10px] border border-border bg-secondary px-3 py-2.5 text-sm font-semibold hover:border-primary/40"
      >
        <span className="flex items-center gap-2 truncate">
          <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />
          <span className="truncate">{project.name}</span>
        </span>
        <ChevronIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </Link>

      <nav className="flex flex-col gap-0.5">
        <Link
          href={dashboardHref}
          className={cn(
            "flex items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-sm font-semibold",
            isDashboardActive
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-secondary hover:text-foreground",
          )}
        >
          <GridIcon className="h-4.5 w-4.5" />
          Dashboard
        </Link>
        {NAV_ITEMS.map(({ label, segment, icon: Icon }) => {
          const href = `/projects/${project.id}/${segment}`;
          const isActive = pathname === href || pathname?.startsWith(`${href}/`);
          return (
            <Link
              key={segment}
              href={href}
              className={cn(
                "flex items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-sm font-semibold",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              <Icon className="h-4.5 w-4.5" />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto flex items-center gap-2.5 border-t border-border pt-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-xs font-bold text-accent-foreground">
          {(me.name ?? me.email).slice(0, 1).toUpperCase()}
        </div>
        <div className="flex flex-col overflow-hidden">
          <span className="truncate text-sm font-semibold">{me.name ?? me.email}</span>
          <Badge variant="secondary" className="w-fit px-1.5 py-0 text-[10px]">
            {me.plan === "PRO" ? "Pro plan" : "Free plan"}
          </Badge>
        </div>
      </div>
    </aside>
  );
}

function GridIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth={2}>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth={2}>
      <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
