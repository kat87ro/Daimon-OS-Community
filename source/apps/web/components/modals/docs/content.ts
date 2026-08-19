import {
  Bot,
  Brain,
  CalendarClock,
  CheckCircle2,
  Database,
  KeyRound,
  LayoutTemplate,
  LifeBuoy,
  ListChecks,
  Lock,
  Network,
  Play,
  Plug,
  Rocket,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Users,
} from "lucide-react";
import type { DocGroup, DocSection } from "./types";

export const DOC_SECTIONS: DocSection[] = [
  {
    id: "getting-started",
    title: "Getting Started",
    icon: Rocket,
    blocks: [
      {
        kind: "p",
        text: "Daimon OS orchestrates multiple real agent CLIs — Claude Code, Codex, Gemini, plus Ollama and LM Studio local models through Codex OSS — running in live terminals. You organize those agents into teams, point a team at a project, and the work is coordinated by a Team Lead while optional durable knowledge is kept in a centralized local memory store.",
      },
      {
        kind: "p",
        text: "A clean installation contains no providers, models, MCP servers, agents, teams, projects, goals, or tasks. Setup follows one line: verify a provider, create least-privileged agents, assemble them into a team, attach that team to a local project, then create a goal or task graph and review the exact Git evidence produced by each run.",
      },
      {
        kind: "h",
        text: "Recommended first steps",
      },
      {
        kind: "steps",
        items: [
          "Test the local gateway in the first-run wizard.",
          "Configure and verify at least one provider.",
          "Optionally configure GitHub, API tokens, MCP servers, skills, and Memory.",
          "Create agents and grant only the capabilities each one needs.",
          "Create a team, add its agents, and select a supported CLI-backed Team Lead.",
          "Create a project for an existing local folder and attach the team.",
          "Add a detailed goal or explicit task graph.",
          "Start work and observe the isolated runs.",
          "Review the captured diff and approve its exact hash before local promotion.",
          "Commit and push separately after reviewing the promoted checkout.",
        ],
      },
      {
        kind: "h",
        text: "Optional next steps",
      },
      {
        kind: "list",
        items: [
          "Configure a Blueprint — a reusable task-DAG template — under Configuration ▸ Blueprints.",
          "Configure a Schedule to run a project or blueprint on a cadence, from the Schedules section in the left sidebar.",
        ],
      },
      {
        kind: "callout",
        tone: "info",
        title: "Single-operator local app",
        text: "This is a single-operator, locally running application. There is no multi-user server, Daimon cloud account, or shared tenancy. Provider traffic still goes directly to the provider selected by the operator, under that provider's account and terms.",
      },
    ],
  },
  {
    id: "settings-overview",
    title: "Settings Overview",
    icon: SlidersHorizontal,
    blocks: [
      {
        kind: "p",
        text: "There is no separate Settings menu. Providers, GitHub, API Tokens, Skills, MCP Servers, Blueprints, Memory, and the Orchestrator are all tabs inside one Configuration hub, opened from the Configuration button in the left sidebar. Projects, Teams, Agents, and Schedules live in the sidebar tree, not here.",
      },
      {
        kind: "path",
        segments: ["Sidebar", "Configuration"],
      },
      {
        kind: "cards",
        items: [
          {
            title: "Providers",
            text: "Connections to model backends and agent CLIs (Claude, Codex, Gemini, Ollama, LM Studio). Configure first — agents cannot run without at least one provider. Used by every agent at spawn time.",
          },
          {
            title: "GitHub",
            text: "Uses your existing GitHub CLI login from the OS keyring. Verify and link an existing owner/repository to a root project's origin after native confirmation; Daimon does not push code from this screen.",
          },
          {
            title: "API Tokens",
            text: "Encrypted secrets (env vars) that authenticate providers, tools, and external services. Add them here, then opt a project into a secret in the project editor. Used by agents at runtime.",
          },
          {
            title: "Skills",
            text: "Reusable capabilities, workflows, and domain instructions. Add, paste, or import them here, then attach to agents. Used by agents while working a task.",
          },
          {
            title: "MCP Servers",
            text: "External capabilities — filesystem, tools, databases, integrations — exposed to agents via the Model Context Protocol. Configure here and enable per agent. Materialized as .mcp.json in the project cwd.",
          },
          {
            title: "Blueprints",
            text: "Reusable task-DAG templates that describe a multi-step workflow once and replay it. Author them here; run them ad hoc or on a schedule.",
          },
          {
            title: "Memory",
            text: "The centralized, durable knowledge store for agents, teams, projects, sessions, and tasks. Enable and point at storage here. Used across every run.",
          },
          {
            title: "Orchestrator",
            text: "Global coordination settings for how the Team Leader delegates and how runs are managed. Configure here; applies to team runs.",
          },
        ],
      },
    ],
  },
  {
    id: "providers",
    title: "Providers",
    icon: KeyRound,
    blocks: [
      {
        kind: "p",
        text: "Providers connect the system to model backends and CLIs. Configure at least one before creating agents — an agent needs a provider to run.",
      },
      {
        kind: "path",
        segments: ["Configuration", "Providers"],
      },
      {
        kind: "steps",
        items: [
          "Open Configuration ▸ Providers.",
          "Add a new provider, or select an existing one to edit.",
          "Configure its name, kind (CLI command or API wire format), base URL, and default model.",
          "Save.",
          "Verify the provider by spawning a terminal in a project, or by importing models with \"Browse & import…\".",
        ],
      },
      {
        kind: "callout",
        tone: "tip",
        text: "There is no generic \"test provider\" button. A provider is proven working when \"Browse & import…\" returns models, or when an agent spawned against it produces real output in a terminal.",
      },
    ],
  },
  {
    id: "api-tokens",
    title: "API Tokens",
    icon: Lock,
    blocks: [
      {
        kind: "p",
        text: "API tokens are secrets that authenticate providers, tools, and external services. They are stored only in the app's encrypted vault and injected into agent processes as environment variables — never written to project files or prompts.",
      },
      {
        kind: "path",
        segments: ["Configuration", "API Tokens"],
      },
      {
        kind: "steps",
        items: [
          "Open Configuration ▸ API Tokens.",
          "Add a token: an UPPER_SNAKE_CASE environment-variable name plus its value.",
          "Optionally assign a group or label to keep tokens organized.",
          "Save. The value is encrypted with AES-256-GCM; only a masked tail is ever displayed again.",
          "In the project editor, allow the secret for that project.",
          "In each agent editor, grant only the secrets that specific agent needs. A secret is injected only when both project and agent grants are present.",
          "Verify by confirming the connected provider or tool works — spawn a terminal or run a small task that uses it.",
        ],
      },
      {
        kind: "callout",
        tone: "security",
        title: "Keep secrets out of everything else",
        text: "Never store API tokens inside Memory, project files, prompts, or documentation notes. The encrypted vault is the only correct place — agents receive the secret as an env var, so it never needs to appear anywhere a model can echo it.",
      },
    ],
  },
  {
    id: "mcp-servers",
    title: "MCP Servers",
    icon: Plug,
    blocks: [
      {
        kind: "p",
        text: "MCP servers give agents external capabilities — filesystem access, tools, databases, and third-party integrations — over the Model Context Protocol. Configure them centrally, then enable the ones each agent should have.",
      },
      {
        kind: "path",
        segments: ["Configuration", "MCP Servers"],
      },
      {
        kind: "steps",
        items: [
          "Open Configuration ▸ MCP Servers.",
          "Add and configure a server: a command with args and env, or a URL endpoint.",
          "Restrict allowed paths and permissions wherever the server supports it.",
          "Note that the app materializes .mcp.json in the project cwd on a merge-only basis — it never clobbers an existing file.",
          "Mark the server as a default for all spawns, or scope it per provider family.",
          "Validate the server connects, then enable it for the relevant agents.",
        ],
      },
      {
        kind: "callout",
        tone: "info",
        title: "Memory has its own MCP",
        text: "Memory carries a separate MCP configuration under Configuration ▸ Memory, used in particular for filesystem access to the configured memory root. Configure memory-related MCP access there rather than in the general MCP Servers tab.",
      },
    ],
  },
  {
    id: "skills",
    title: "Skills",
    icon: Sparkles,
    blocks: [
      {
        kind: "p",
        text: "Skills are reusable capabilities, workflows, and domain instructions that agents draw on while working. Build a library once and attach the right skills to each agent.",
      },
      {
        kind: "path",
        segments: ["Configuration", "Skills"],
      },
      {
        kind: "steps",
        items: [
          "Open Configuration ▸ Skills.",
          "Add a skill, paste a .md definition, or import one via a provider with \"Browse & import…\".",
          "Review its description and any permissions it requests.",
          "Attach skills to agents where supported.",
          "Test the skill by running a small task that exercises it.",
        ],
      },
    ],
  },
  {
    id: "memory-setup",
    title: "Memory Setup",
    icon: Brain,
    blocks: [
      {
        kind: "p",
        text: "Memory stores durable knowledge for agents, teams, projects, sessions, and tasks. It is centralized and is not stored inside individual project folders. The preferred storage is an Obsidian Vault folder; if Obsidian is not present, a local app-managed memory folder is used instead.",
      },
      {
        kind: "path",
        segments: ["Configuration", "Memory"],
      },
      {
        kind: "steps",
        items: [
          "Open Configuration ▸ Memory.",
          "Enable Memory (centralized memory).",
          "Choose a storage mode: Obsidian Vault or Local App Memory Folder.",
          "If Obsidian: select the vault path, then select or create the AgenticOS-Memory folder inside it.",
          "If local: confirm the local memory folder path (the fallback used when Obsidian is missing).",
          "Validate the memory root to confirm it is reachable and writable.",
          "Enable or disable Memory retrieval, Memory writes, Approval before writes, Session summaries, Agent memory, Team memory, Project memory, and JSON indexes — including the retrieval token budget.",
          "Configure Memory MCP access if agents need filesystem reach into the memory root.",
          "Run Test write to confirm the system can persist a file.",
          "Rebuild indexes if you edited memory by hand or the indexes look stale.",
        ],
      },
      {
        kind: "h",
        text: "Active memory root",
      },
      {
        kind: "p",
        text: "The Active memory root is the actual folder where memory currently lives — the resolved path of whichever storage mode is in effect. Every memory path resolves through this root, so when you move from local to an Obsidian vault, all memory addressing follows the new root automatically.",
      },
    ],
  },
  {
    id: "project-memory",
    title: "Project Memory",
    icon: Database,
    blocks: [
      {
        kind: "p",
        text: "When Memory is enabled, every new project is initialized in the centralized memory store. Project memory is kept under the active memory root — not in the project's working folder, which is never used for durable memory.",
      },
      {
        kind: "code",
        text: "active_memory_root/projects/{project_id}/",
      },
      {
        kind: "p",
        text: "The project workspace path may be recorded only as metadata; the durable record of the project's context, decisions, and history lives entirely under the path above.",
      },
      {
        kind: "steps",
        items: [
          "Create a new project.",
          "Confirm Memory was initialized for it.",
          "Attach a team to the project.",
          "Verify the team has default read/write access to that project's memory.",
          "Use the project — run tasks against it.",
          "Review the project memory files if you need to inspect what was captured.",
        ],
      },
      {
        kind: "kv",
        title: "Project memory files",
        items: [
          { k: "project.md", v: "Project identity and overview — name, goal, scope." },
          { k: "context.md", v: "Working context and background the team needs to operate." },
          { k: "decisions.md", v: "Decisions taken during the project, with rationale." },
          { k: "timeline.md", v: "Chronological log of events and milestones." },
          { k: "team.md", v: "The team and agents assigned to the project." },
          { k: "tasks.md", v: "Tasks, their status, and assignments." },
          { k: "artifacts.md", v: "References to outputs and produced artifacts." },
          { k: "memory.md", v: "Distilled durable knowledge and learnings for the project." },
        ],
      },
    ],
  },
  {
    id: "orchestration",
    title: "Orchestration",
    icon: Settings,
    blocks: [
      {
        kind: "p",
        text: "The Orchestrator holds the global coordination settings for team runs: how the Team Leader delegates work to members, how runs are managed, and the defaults that apply when a team executes against a project.",
      },
      {
        kind: "path",
        segments: ["Configuration", "Orchestrator"],
      },
      {
        kind: "list",
        items: [
          "Delegation behavior — how the Team Leader selects and invokes member agents.",
          "Run management — how concurrent work, retries, and completion are handled.",
          "Defaults that apply across every team run, unless a team or project overrides them.",
        ],
      },
    ],
  },
  {
    id: "creating-agents",
    title: "Creating Agents",
    icon: Bot,
    blocks: [
      {
        kind: "p",
        text: "Agents perform specialized roles. Each agent can be given a provider, tools, skills, memory access, and the optional Fusion capability.",
      },
      {
        kind: "p",
        text: "Agents are created from the Agents section in the left sidebar — not in the Configuration hub.",
      },
      {
        kind: "path",
        segments: ["Sidebar", "Agents", "+"],
      },
      {
        kind: "steps",
        items: [
          "Open Agents in the left sidebar.",
          "Create a new agent.",
          "Set its name and role.",
          "Choose its model and provider.",
          "Add instructions — the system prompt that defines how it behaves.",
          "Attach skills and tools it should have.",
          "Configure memory access if available.",
          "Save.",
          "Test the agent with a small task and confirm the output.",
        ],
      },
    ],
  },
  {
    id: "fusion",
    title: "Fusion Capability",
    icon: Network,
    blocks: [
      {
        kind: "p",
        text: "Fusion is an optional, per-agent capability. It activates only when a Fusion-enabled agent is invoked by the Team Leader during a team/project workflow. When active, it lets that agent consult a configured panel of agents — and a judge — before producing its own answer.",
      },
      {
        kind: "callout",
        tone: "info",
        title: "Who answers the Team Leader",
        text: "Panel agents and the judge agent do not answer the Team Leader directly. They inform the originally invoked agent, which produces the final response. Fusion is an internal consultation, not a hand-off.",
      },
      {
        kind: "h",
        text: "Fusion flow",
      },
      {
        kind: "steps",
        items: [
          "The Team Leader calls a Fusion-enabled agent.",
          "The Fusion panel agents analyze the task independently.",
          "The judge agent compares the panel outputs.",
          "The resulting Fusion analysis is injected into the invoked agent.",
          "The invoked agent responds to the Team Leader.",
        ],
      },
      {
        kind: "h",
        text: "Step-by-step configuration",
      },
      {
        kind: "steps",
        items: [
          "Open the agent.",
          "Open the Fusion Capability section.",
          "Enable Fusion.",
          "Select the panel agents.",
          "Select a judge agent.",
          "Choose the context to share: team context, project memory, conversation context, agent memory, and files/context artifacts.",
          "Configure limits: timeout, max tool calls, and max output tokens if supported.",
          "Save.",
          "Attach the Fusion-enabled agent to a team.",
          "Run a project task where the Team Leader invokes that agent.",
        ],
      },
      {
        kind: "callout",
        tone: "tip",
        text: "The panel and judge run headless and one-shot. They cannot themselves trigger another Fusion — there is no recursion, so a Fusion call always terminates in a single layer of consultation.",
      },
    ],
  },
  {
    id: "creating-teams",
    title: "Creating Teams",
    icon: Users,
    blocks: [
      {
        kind: "p",
        text: "Teams group agents under a Team Leader. The Leader delegates work to member agents. If a member has Fusion enabled, Fusion runs automatically whenever that member is invoked.",
      },
      {
        kind: "path",
        segments: ["Sidebar", "Teams", "+"],
      },
      {
        kind: "steps",
        items: [
          "Open Teams in the left sidebar.",
          "Create a team.",
          "Select a Team Leader agent.",
          "Add member agents.",
          "Include Fusion-enabled agents if desired.",
          "Save.",
          "Attach the team to a project.",
        ],
      },
    ],
  },
  {
    id: "running-project",
    title: "Running a Project With a Team",
    icon: Play,
    blocks: [
      {
        kind: "p",
        text: "Running a project ties the whole system together: a team executes against a project goal, the Team Leader delegates to members, memory is retrieved and updated, and you review the result.",
      },
      {
        kind: "steps",
        items: [
          "Create or open a project.",
          "Attach a team.",
          "Provide the task or goal.",
          "Start the team run.",
          "The Team Leader delegates work to member agents.",
          "Agents respond with their results.",
          "Fusion runs automatically only for Fusion-enabled agents when they are invoked.",
          "Relevant memory is retrieved to inform the work.",
          "Useful outcomes may be saved back to memory.",
          "Review the final output, the logs (Work Log), and the memory updates.",
        ],
      },
    ],
  },
  {
    id: "example-fusion-todo",
    title: "Example: Testing Fusion With a Todo API Project",
    icon: ListChecks,
    blocks: [
      {
        kind: "p",
        text: "A concrete worked example that exercises Fusion end to end. Set up a small team where one member has Fusion enabled, then ask that member to do a design task and watch the panel and judge feed its final answer.",
      },
      {
        kind: "kv",
        title: "Setup",
        items: [
          { k: "Project", v: "Todo API Design Review" },
          { k: "Team Leader", v: "Product Lead Agent" },
          { k: "Fusion-enabled agent", v: "API Architect Agent" },
          { k: "Panel agents", v: "Security Agent, Backend Agent, QA Agent" },
          { k: "Judge", v: "Principal Engineer Agent" },
          { k: "Task", v: "Ask the API Architect Agent to design an MVP REST API for a personal todo app." },
        ],
      },
      {
        kind: "h",
        text: "Expected behavior",
      },
      {
        kind: "steps",
        items: [
          "The Security Agent reviews auth and input validation.",
          "The Backend Agent suggests endpoints and a data model.",
          "The QA Agent suggests tests and edge cases.",
          "The Judge (Principal Engineer Agent) compares the panel outputs.",
          "The API Architect Agent produces the final API design, informed by the fused analysis.",
        ],
      },
    ],
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    icon: LifeBuoy,
    blocks: [
      {
        kind: "p",
        text: "Common issues and how to resolve them. Each card names the symptom, then the likely cause and the fix.",
      },
      {
        kind: "cards",
        items: [
          {
            title: "Provider not working",
            text: "Cause: misconfigured kind, base URL, default model, or a missing CLI on PATH. Fix: re-check the provider settings, confirm the CLI runs in a terminal, and verify with \"Browse & import…\" or a freshly spawned terminal.",
          },
          {
            title: "API token missing or invalid",
            text: "Cause: the project was not opted into the secret, or the stored value is wrong/expired. Fix: open the project editor and tick the secret so it is injected as an env var; re-enter the token value in Configuration ▸ API Tokens if it is invalid.",
          },
          {
            title: "MCP server disconnected",
            text: "Cause: bad command/args/env or URL, or the server process failed to start. Fix: validate the server in Configuration ▸ MCP Servers, confirm the command runs standalone, and check that .mcp.json in the project cwd merged correctly.",
          },
          {
            title: "Memory folder invalid",
            text: "Cause: the configured memory root does not exist or is not writable. Fix: run Validate in Configuration ▸ Memory, correct the path, and confirm permissions, then run Test write.",
          },
          {
            title: "Obsidian Vault not found",
            text: "Cause: the selected vault path is missing or moved. Fix: reselect the vault path and the AgenticOS-Memory folder, or switch storage mode to Local App Memory Folder.",
          },
          {
            title: "Local memory fallback active",
            text: "Cause: Obsidian was not detected, so the system fell back to the local app-managed folder. Fix: this is expected behavior — install/point at Obsidian and reselect the vault if you want vault-based storage, otherwise no action is needed.",
          },
          {
            title: "Project memory not initialized",
            text: "Cause: Memory was disabled when the project was created. Fix: enable Memory in Configuration ▸ Memory, then re-create the project or trigger initialization so the projects/{project_id} files are written.",
          },
          {
            title: "Agent cannot access memory",
            text: "Cause: memory access is disabled for the agent, retrieval is off, or Memory MCP filesystem access is not configured. Fix: enable the agent's memory access, turn on Memory retrieval, and configure Memory MCP access to the memory root.",
          },
          {
            title: "Fusion did not run",
            text: "Cause: Fusion is not enabled on the agent, or the agent was not invoked by the Team Leader (Fusion only fires on invocation in a team run). Fix: enable Fusion on the agent and run a task where the Team Leader actually calls that agent.",
          },
          {
            title: "Fusion panel agent unavailable",
            text: "Cause: a configured panel agent was deleted, or its provider is failing. Fix: re-select valid panel agents in the agent's Fusion section and confirm each one's provider works.",
          },
          {
            title: "Judge failed",
            text: "Cause: the judge agent's provider errored or it hit a configured limit (timeout / max tokens). Fix: verify the judge's provider, then raise the Fusion timeout or max output tokens if the comparison is being cut off.",
          },
          {
            title: "Team Leader did not call expected agent",
            text: "Cause: agent roles/instructions are ambiguous, or the agent was not added as a team member. Fix: sharpen the agent's role and instructions, confirm it is a member of the team, and make the task description point clearly at the work that agent owns.",
          },
        ],
      },
    ],
  },
  {
    id: "best-practices",
    title: "Best Practices",
    icon: CheckCircle2,
    blocks: [
      {
        kind: "p",
        text: "Habits that keep runs predictable, memory clean, and secrets safe.",
      },
      {
        kind: "list",
        items: [
          "Start with one provider and one simple team before scaling up.",
          "Use clear, distinct agent roles so the Team Leader delegates correctly.",
          "Keep Fusion panels small — 2 to 4 agents.",
          "Use Fusion for complex review or decision tasks, not for every task.",
          "Configure Memory before starting long-running projects.",
          "Use project memory for durable context rather than re-explaining each run.",
          "Keep API tokens out of Memory — they belong only in the encrypted vault.",
          "Validate MCP allowed paths carefully to limit filesystem reach.",
          "Rebuild indexes after any manual edit to memory files.",
          "Review memory writes when approval mode is enabled.",
        ],
      },
    ],
  },
  {
    id: "blueprints",
    title: "Blueprints",
    icon: LayoutTemplate,
    blocks: [
      {
        kind: "p",
        text: "A blueprint is a reusable task-DAG template. Instead of hand-creating the same goal and tasks for every similar project, you define them once and instantiate the blueprint onto a project — manually or on a schedule — with variables filled in.",
      },
      { kind: "path", segments: ["Configuration", "Blueprints"] },
      { kind: "h", text: "What a blueprint contains" },
      {
        kind: "kv",
        items: [
          { k: "Name", v: "How the blueprint appears in lists and schedules." },
          { k: "Description", v: "Optional note describing what it produces when instantiated." },
          { k: "Attach team", v: "Optional team to attach to the project when the blueprint is instantiated." },
          { k: "Goal template", v: "Optional templated goal text created alongside the tasks. {goal} and {var} placeholders are substituted on instantiate." },
          { k: "Tasks (DAG)", v: "The ordered set of tasks, with dependencies, that the blueprint creates." },
        ],
      },
      { kind: "h", text: "What each task has" },
      {
        kind: "kv",
        items: [
          { k: "Ref", v: "A short unique id (e.g. t1) used to wire dependencies. Must be unique within the blueprint." },
          { k: "Title template", v: "The task title; supports {goal} and {var}, e.g. \"Draft post about {goal}\"." },
          { k: "Description template", v: "Optional longer instructions; also supports substitution." },
          { k: "Assigned agent", v: "Optional agent (by name) to own the task; leave unassigned to let the Team Leader delegate." },
          { k: "Depends on", v: "Other task refs that must finish first. This is what makes it a DAG — dependents wait for their prerequisites." },
        ],
      },
      { kind: "h", text: "Create a blueprint" },
      {
        kind: "steps",
        items: [
          "Open Configuration ▸ Blueprints and click Add.",
          "Enter a Name and an optional Description.",
          "Optionally pick a team to attach on instantiate, and write a Goal template.",
          "Click Add task for each step; give it a unique Ref and a Title template.",
          "Add a description and assign an agent if you want a specific owner.",
          "Tick Depends on to require other tasks to finish first (this builds the DAG).",
          "Repeat for every task — refs must be unique (the editor blocks duplicates).",
          "Save.",
        ],
      },
      { kind: "h", text: "Variables" },
      {
        kind: "p",
        text: "Use {goal} and any {var} inside titles, descriptions, or the goal template. Their values are supplied when the blueprint is instantiated — manually onto a project, or by a schedule's Vars list — so one blueprint produces project-specific tasks.",
      },
      { kind: "h", text: "Full example — build a “Daily AI News Digest” blueprint" },
      {
        kind: "p",
        text: "First create the four agents this example uses (see Creating Agents): Researcher, Writer, Editor, Publisher — and a project to run them on, e.g. “AI Tech News”. Then open Configuration ▸ Blueprints ▸ Add and fill the form in exactly like this:",
      },
      {
        kind: "kv",
        title: "Top of the form — type these values",
        items: [
          { k: "Name", v: "Daily AI News Digest" },
          { k: "Description", v: "Research, draft, review and publish a short AI news digest." },
          { k: "Attach team", v: "— none —  (we attach a team on the project instead)" },
          { k: "Goal template", v: "Produce today's AI news digest." },
        ],
      },
      {
        kind: "p",
        text: "Now click “Add task” four times and fill each one. Ref is a short id you choose; Depends on is where you tick the task that must finish first:",
      },
      {
        kind: "code",
        text: "Ref   Title template                       Assigned agent   Depends on\n--------------------------------------------------------------------------\nt1    Research the latest AI news          Researcher       (none)\nt2    Draft the digest from the research   Writer           t1\nt3    Review and fact-check the draft      Editor           t2\nt4    Publish the approved digest          Publisher        t3",
      },
      {
        kind: "p",
        text: "The chain t1 → t2 → t3 → t4 is the DAG: each task stays Blocked until the task it depends on is done. Click Save.",
      },
      { kind: "h", text: "Run it once by hand to test" },
      {
        kind: "steps",
        items: [
          "In the left sidebar, hover your project and click its edit (gear) icon.",
          "Find “Start from blueprint”, select “Daily AI News Digest”, and click Run.",
          "You see “Created 4 tasks.” — t1 starts in Backlog; t2, t3 and t4 are Blocked until their dependency finishes.",
          "Open the project's Kanban or Work Log to watch them progress as the team works.",
        ],
      },
      {
        kind: "callout",
        tone: "info",
        title: "The manual Run uses no variables",
        text: "Running a blueprint by hand instantiates it immediately with no variables, so any {placeholder} is left exactly as written. To fill placeholders, fire the blueprint from a Schedule with a Vars list (see the Schedules section).",
      },
      { kind: "h", text: "Make it reusable with a variable" },
      {
        kind: "p",
        text: "To reuse the same blueprint for any subject, swap the fixed words for a {topic} placeholder in the goal template and the first task title:",
      },
      {
        kind: "kv",
        items: [
          { k: "Goal template", v: "Produce today's AI news digest about {topic}." },
          { k: "t1 title", v: "Research the latest {topic} news" },
        ],
      },
      {
        kind: "p",
        text: "Now {topic} is filled in whenever the blueprint is instantiated with a variable named topic — which is exactly what a Schedule's Vars field does. With topic = large language models, t1's title becomes “Research the latest large language models news”.",
      },
      {
        kind: "callout",
        tone: "info",
        title: "Where blueprints are used",
        text: "A saved blueprint can be instantiated onto a project to create its goal and task DAG, and it is the unit a Schedule fires on a cadence. The scheduler then auto-dispatches the tasks, respecting their dependencies.",
      },
      {
        kind: "callout",
        tone: "tip",
        title: "Keep refs stable",
        text: "Dependencies are wired by ref. Renaming a ref clears any dependents that pointed at it, so choose short, stable refs (t1, t2 …) up front.",
      },
    ],
  },
  {
    id: "schedules",
    title: "Schedules",
    icon: CalendarClock,
    blocks: [
      {
        kind: "p",
        text: "A schedule fires a blueprint onto a project automatically — on a clock, on an interval, or when a folder changes. It is how you run recurring or event-driven work without starting it by hand.",
      },
      { kind: "path", segments: ["Sidebar", "Schedules", "+"] },
      { kind: "h", text: "What a schedule contains" },
      {
        kind: "kv",
        items: [
          { k: "Name", v: "Label for the schedule." },
          { k: "Blueprint", v: "The blueprint to instantiate when it fires. Create the blueprint first." },
          { k: "Project", v: "The project the blueprint is instantiated onto each time it fires." },
          { k: "Kind", v: "How it triggers: cron, interval, or watch." },
          { k: "Spec", v: "The trigger value — its meaning depends on Kind (see below)." },
          { k: "Vars", v: "KEY=value lines passed on instantiate to fill the blueprint's {goal} / {var} placeholders." },
          { k: "Enabled", v: "Turn the schedule on or off without deleting it." },
        ],
      },
      { kind: "h", text: "Trigger kinds and their Spec" },
      {
        kind: "kv",
        items: [
          { k: "cron", v: "A cron expression at minute resolution. Example: 0 9 * * * — every day at 09:00." },
          { k: "interval", v: "Milliseconds between runs. Example: 3600000 — every hour." },
          { k: "watch", v: "An absolute folder path; a create/change under it fires the run (debounced). Example: /Users/you/inbox." },
        ],
      },
      { kind: "h", text: "Create a schedule" },
      {
        kind: "steps",
        items: [
          "Make sure the blueprint and the target project already exist.",
          "In the left sidebar, open Schedules and click + (New schedule).",
          "Enter a Name.",
          "Select the Blueprint to fire and the Project to fire it onto.",
          "Choose the Kind: cron, interval, or watch.",
          "Enter the Spec for that kind (a cron expression, a number of milliseconds, or a folder path).",
          "Add any Vars as KEY=value lines (e.g. goal=Publish the weekly digest) to fill the blueprint's placeholders.",
          "Leave Enabled ticked to activate it now, or untick to save it disabled.",
          "Save — the scheduler picks it up and fires it whenever the trigger condition is met.",
        ],
      },
      { kind: "h", text: "Full example — run the digest every morning at 8am" },
      {
        kind: "p",
        text: "This fires the “Daily AI News Digest” blueprint onto your “AI Tech News” project automatically every day. In the left sidebar open Schedules, click +, and fill the form in exactly like this:",
      },
      {
        kind: "kv",
        title: "The form — type these values",
        items: [
          { k: "Name", v: "Morning AI digest" },
          { k: "Blueprint", v: "Daily AI News Digest" },
          { k: "Project", v: "AI Tech News" },
          { k: "Kind", v: "cron" },
          { k: "Spec", v: "0 8 * * *" },
          { k: "Vars", v: "topic=large language models" },
          { k: "Enabled", v: "ticked" },
        ],
      },
      {
        kind: "p",
        text: "Click Save. Every day at 08:00 the scheduler instantiates the blueprint onto the project, substitutes topic, and the Team Leader starts working the four tasks in dependency order — with no clicks from you.",
      },
      { kind: "h", text: "Cron cheat-sheet (copy a line into Spec)" },
      {
        kind: "code",
        text: "Field order:  minute  hour  day-of-month  month  day-of-week\n\n0 8 * * *      every day at 08:00\n30 9 * * *     every day at 09:30\n0 * * * *      every hour, on the hour\n*/15 * * * *   every 15 minutes\n0 9 * * 1      every Monday at 09:00\n0 8 1 * *      the 1st of every month at 08:00",
      },
      {
        kind: "p",
        text: "Prefer “every N milliseconds”? Set Kind = interval and Spec = 3600000 (one hour). Want it to fire when a file arrives? Set Kind = watch and Spec = an absolute folder path such as /Users/you/inbox.",
      },
      {
        kind: "callout",
        tone: "tip",
        title: "Test before you automate",
        text: "Instantiate the blueprint onto the project manually once (Project editor ▸ Start from blueprint ▸ Run) to confirm the tasks look right, then create the schedule to run it on a cadence.",
      },
      {
        kind: "callout",
        tone: "warn",
        title: "Watch paths",
        text: "For watch schedules use an absolute path you control. Changes fire the run (debounced), so point it at a dedicated inbox folder rather than a busy directory.",
      },
    ],
  },
];

export const DOC_GROUPS: DocGroup[] = [
  { label: "Getting Started", sectionIds: ["getting-started"] },
  {
    label: "Settings & Configuration",
    sectionIds: [
      "settings-overview",
      "providers",
      "api-tokens",
      "mcp-servers",
      "skills",
      "blueprints",
      "memory-setup",
      "project-memory",
      "orchestration",
    ],
  },
  {
    label: "Agents, Fusion & Teams",
    sectionIds: ["creating-agents", "fusion", "creating-teams"],
  },
  {
    label: "Running Projects",
    sectionIds: ["running-project", "schedules", "example-fusion-todo"],
  },
  { label: "Reference", sectionIds: ["troubleshooting", "best-practices"] },
];
