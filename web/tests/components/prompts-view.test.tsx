import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PromptTemplate } from "@contracts/api/prompts";
import type { PromptResult, PromptRun } from "@contracts/api/prompt-runs";
import { PromptsView } from "@/app/(app)/projects/[projectId]/prompts/prompts-view";
import { apiFetch, ApiError, API_BASE_URL } from "@/lib/api/client";
import { renderWithQueryClient } from "../test-utils";

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

/**
 * `prompts-view.tsx` opens a real `EventSource` while the latest run is QUEUED/RUNNING.
 * jsdom has no SSE implementation, so this fake gives it something to call
 * `addEventListener`/`removeEventListener`/`close` on, and lets tests drive server frames
 * deterministically via `.emit(type, data)` instead of racing a network connection.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly withCredentials: boolean;
  closed = false;
  private readonly listeners = new Map<string, Set<(event: { data?: string }) => void>>();

  constructor(url: string, options?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = options?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: { data?: string }) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data?: unknown) {
    const event = data === undefined ? {} : { data: typeof data === "string" ? data : JSON.stringify(data) };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const PROMPT_ID = "22222222-2222-2222-2222-222222222222";
const RUN_ID = "33333333-3333-3333-3333-333333333333";
const RUNS_PATH = `/v1/projects/${PROJECT_ID}/prompt-runs`;

function prompt(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: PROMPT_ID,
    text: "What is the best CRM for a 10-person sales team?",
    intent: "comparison",
    source: "USER",
    pinned: false,
    status: "ACTIVE",
    position: 0,
    ...overrides,
  };
}

function promptRun(overrides: Partial<PromptRun> = {}): PromptRun {
  return {
    id: RUN_ID,
    status: "COMPLETED",
    trigger: "MANUAL",
    engines: ["chatgpt", "perplexity"],
    mentionRate: 62,
    citationShare: 40,
    metrics: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function promptResult(overrides: Partial<PromptResult> = {}): PromptResult {
  return {
    id: "101",
    promptTemplateId: PROMPT_ID,
    engine: "chatgpt",
    sampleIndex: 0,
    brandMentioned: true,
    brandCited: true,
    mentionPosition: 1,
    sentiment: "POSITIVE",
    competitorsMentioned: [{ name: "Acme Rival", cited: false }],
    citations: ["https://example.com/best-crm"],
    answerText: "For a 10-person sales team, Vryse is a strong pick because...",
    model: "gpt-4.1",
    latencyMs: 1200,
    error: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderPrompts(
  prompts: PromptTemplate[] = [],
  runs: PromptRun[] = [],
  nextCursor: string | null = null,
) {
  return renderWithQueryClient(
    <PromptsView
      projectId={PROJECT_ID}
      initialPrompts={prompts}
      initialRuns={runs}
      initialRunsNextCursor={nextCursor}
    />,
  );
}

describe("PromptsView", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.mocked(apiFetch).mockReset();
    toastError.mockReset();
    FakeEventSource.instances = [];
    vi.unstubAllGlobals();
  });

  it("renders the tracked prompt list with intent, source, and pin state, with no fetch on mount", () => {
    renderPrompts([prompt()]);

    expect(screen.getByText("What is the best CRM for a 10-person sales team?")).toBeInTheDocument();
    expect(screen.getByText("comparison")).toBeInTheDocument();
    expect(screen.getByText("USER")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pin" })).toBeInTheDocument();
    // initialData from the Server Component covers the first render — no background fetch.
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("shows an empty state when there are no tracked prompts", () => {
    renderPrompts([]);
    expect(
      screen.getByText(/no prompts tracked yet/i),
    ).toBeInTheDocument();
  });

  it("does not submit and shows a validation error when the prompt text is too short", async () => {
    const user = userEvent.setup();
    renderPrompts([]);

    await user.click(screen.getByRole("button", { name: /add prompt/i }));
    await user.type(screen.getByLabelText("Prompt text"), "short");
    await user.click(screen.getByRole("button", { name: /add prompt/i }));

    await waitFor(() => expect(apiFetch).not.toHaveBeenCalled());
    expect(screen.getByText("String must contain at least 8 character(s)")).toBeInTheDocument();
  });

  it("adds a prompt and refreshes the tracked list on success", async () => {
    const created = prompt({
      id: "44444444-4444-4444-4444-444444444444",
      text: "What tools do you recommend for cold outreach?",
      intent: null,
    });
    vi.mocked(apiFetch).mockImplementation(async (path, options) => {
      const method = options?.method ?? "GET";
      if (method === "POST" && path === `/v1/projects/${PROJECT_ID}/prompts`) {
        expect(options?.body).toMatchObject({ text: "What tools do you recommend for cold outreach?" });
        return created;
      }
      if (path === `/v1/projects/${PROJECT_ID}/prompts`) return { data: [created] };
      throw new Error(`unexpected call: ${String(path)} ${method}`);
    });
    const user = userEvent.setup();
    renderPrompts([]);

    await user.click(screen.getByRole("button", { name: /add prompt/i }));
    await user.type(screen.getByLabelText("Prompt text"), "What tools do you recommend for cold outreach?");
    await user.click(screen.getByRole("button", { name: /add prompt/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        `/v1/projects/${PROJECT_ID}/prompts`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(await screen.findByText("What tools do you recommend for cold outreach?")).toBeInTheDocument();
    // The form collapses back to the toggle button once the prompt is created.
    expect(screen.getByRole("button", { name: /add prompt/i })).toBeInTheDocument();
    expect(screen.queryByLabelText("Prompt text")).not.toBeInTheDocument();
  });

  it("pins a prompt via PATCH with only {pinned}, never text", async () => {
    vi.mocked(apiFetch).mockImplementation(async (path, options) => {
      const method = options?.method ?? "GET";
      if (method === "PATCH" && path === `/v1/projects/${PROJECT_ID}/prompts/${PROMPT_ID}`) {
        expect(options?.body).toEqual({ pinned: true });
        return prompt({ pinned: true });
      }
      if (path === `/v1/projects/${PROJECT_ID}/prompts`) return { data: [prompt({ pinned: true })] };
      throw new Error(`unexpected call: ${String(path)} ${method}`);
    });
    const user = userEvent.setup();
    renderPrompts([prompt({ pinned: false })]);

    await user.click(screen.getByRole("button", { name: "Pin" }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        `/v1/projects/${PROJECT_ID}/prompts/${PROMPT_ID}`,
        expect.objectContaining({ method: "PATCH", body: { pinned: true } }),
      ),
    );
    expect(await screen.findByRole("button", { name: "Pinned" })).toBeInTheDocument();
  });

  it("triggers a run with a fresh idempotency key when none is active", async () => {
    // The mutation's POST resolves to the new run; its onSuccess invalidates the runs list,
    // which refetches GET .../prompt-runs through this same mock — that call must resolve to
    // the paginated shape, not the bare run, or `runs.map` crashes on an `undefined` element
    // (the exact bug this two-branch mock exists to avoid).
    vi.mocked(apiFetch).mockImplementation(async (_path, options) =>
      options?.method === "POST"
        ? promptRun({ status: "QUEUED", finishedAt: null })
        : { data: [], nextCursor: null },
    );
    const user = userEvent.setup();
    renderPrompts([], []);

    await user.click(screen.getByRole("button", { name: /run now/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        RUNS_PATH,
        expect.objectContaining({ method: "POST", body: {} }),
      ),
    );
    const [, options] = vi.mocked(apiFetch).mock.calls[0]!;
    expect(typeof (options as { idempotencyKey?: string }).idempotencyKey).toBe("string");
  });

  it("surfaces a 409 already-active failure as a toast instead of crashing", async () => {
    vi.mocked(apiFetch).mockRejectedValue(
      new ApiError({
        type: "https://api.vryse.example/errors/prompt-run-already-active",
        code: "PROMPT_RUN_ALREADY_ACTIVE",
        title: "Prompt run already active",
        status: 409,
        detail: "A prompt run is already in progress for this project.",
      }),
    );
    const user = userEvent.setup();
    renderPrompts([], []);

    await user.click(screen.getByRole("button", { name: /run now/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "A prompt run is already in progress for this project.",
      ),
    );
  });

  it("opens a credentialed SSE connection while the latest run is in flight, and renders live cell progress", async () => {
    renderPrompts([], [promptRun({ status: "QUEUED", finishedAt: null })]);

    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe(
      `${API_BASE_URL}/v1/projects/${PROJECT_ID}/prompt-runs/${RUN_ID}/progress`,
    );
    expect(source.withCredentials).toBe(true);
    expect(screen.getByRole("button", { name: /run in progress/i })).toBeDisabled();

    source.emit("progress", { cellsDone: 5, cellsTotal: 20 });
    expect(await screen.findByText("5 / 20 cells")).toBeInTheDocument();
  });

  it("closes the SSE connection and refetches runs when a 'done' frame arrives", async () => {
    vi.mocked(apiFetch).mockImplementation(
      (async (path: string) => {
        if (path.includes("/results")) return { data: [], nextCursor: null };
        if (path.includes("/prompt-runs")) return { data: [promptRun({ status: "COMPLETED" })], nextCursor: null };
        throw new Error(`unexpected call: ${path}`);
      }) as typeof apiFetch,
    );
    renderPrompts([], [promptRun({ status: "RUNNING", finishedAt: null })]);
    const source = FakeEventSource.instances[0]!;

    source.emit("done");

    await waitFor(() => expect(source.closed).toBe(true));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining(RUNS_PATH)),
    );
  });

  it("does not open an SSE connection once the latest run has finished", () => {
    renderPrompts([], [promptRun({ status: "COMPLETED" })]);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("selects a run, loads its results, and renders mention/citation/sentiment badges plus the full answer in the detail sheet", async () => {
    const result = promptResult();
    vi.mocked(apiFetch).mockImplementation(
      (async (path: string) => {
        if (path === `/v1/projects/${PROJECT_ID}/prompt-runs/${RUN_ID}/results?limit=50`) {
          return { data: [result], nextCursor: null };
        }
        throw new Error(`unexpected call: ${path}`);
      }) as typeof apiFetch,
    );
    const user = userEvent.setup();
    renderPrompts([], [promptRun({ status: "COMPLETED" })]);

    await user.click(screen.getByText("COMPLETED"));

    const engineCell = await screen.findByText("chatgpt");
    // Scoped to the result row: the table also has "Mentioned"/"Cited" column headers, so
    // an unscoped query matches both the header and this row's badge.
    const row = engineCell.closest("tr") as HTMLElement;
    expect(within(row).getByText("Mentioned")).toBeInTheDocument();
    expect(within(row).getByText("Cited")).toBeInTheDocument();
    expect(within(row).getByText("POSITIVE")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /view answer/i }));

    expect(
      await screen.findByText("For a 10-person sales team, Vryse is a strong pick because..."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "https://example.com/best-crm" })).toHaveAttribute(
      "href",
      "https://example.com/best-crm",
    );
    expect(screen.getByText(/Acme Rival/)).toBeInTheDocument();
  });

  it("shows an error note in the detail sheet when a result has no answer text", async () => {
    const failed = promptResult({
      id: "202",
      answerText: null,
      error: "Upstream engine timed out.",
      brandMentioned: false,
      brandCited: false,
      sentiment: null,
      citations: null,
      competitorsMentioned: null,
    });
    vi.mocked(apiFetch).mockImplementation(
      (async (path: string) => {
        if (path === `/v1/projects/${PROJECT_ID}/prompt-runs/${RUN_ID}/results?limit=50`) {
          return { data: [failed], nextCursor: null };
        }
        throw new Error(`unexpected call: ${path}`);
      }) as typeof apiFetch,
    );
    const user = userEvent.setup();
    renderPrompts([], [promptRun({ status: "COMPLETED" })]);

    await user.click(screen.getByText("COMPLETED"));
    await user.click(await screen.findByRole("button", { name: /view answer/i }));

    expect(await screen.findByText("Upstream engine timed out.")).toBeInTheDocument();
  });
});
