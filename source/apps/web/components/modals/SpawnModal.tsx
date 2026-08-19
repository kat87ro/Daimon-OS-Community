"use client";

import { useState } from "react";
import { Bot } from "lucide-react";
import { SCRATCH_PROJECT_ID } from "@daimon-os/shared";
import { gateway } from "@/lib/gateway/GatewayClient";
import { useConfigStore } from "@/stores/config";
import { useLayoutStore } from "@/stores/layout";
import { useUiStore } from "@/stores/ui";
import { Field, Select, TextInput } from "../sidebar/fields";
import { Modal } from "./Modal";

export function SpawnModal({ projectId }: { projectId?: string }) {
  const agents = useConfigStore((s) => s.agents);
  const projects = useConfigStore((s) => s.projects);
  const activeProjectId = useLayoutStore((s) => s.activeProjectId);
  const closeModal = useUiStore((s) => s.closeModal);

  const providers = useConfigStore((s) => s.providers);
  const [targetProject, setTargetProject] = useState(projectId ?? activeProjectId);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [model, setModel] = useState("");
  const [cwd, setCwd] = useState("");
  const [displayName, setDisplayName] = useState("");

  const project = projects.find((p) => p.id === targetProject);
  // agents run in the project folder too — that's where their CLI works
  const effectiveCwd = cwd || project?.path || undefined;
  const agent = agents.find((a) => a.id === agentId);
  const provider = providers.find((p) => p.id === agent?.providerId);

  const spawn = () => {
    gateway.spawn({
      kind: "agent",
      agent,
      model: model || undefined,
      cwd: effectiveCwd,
      displayName: displayName || undefined,
      projectId: targetProject === SCRATCH_PROJECT_ID ? undefined : targetProject,
    });
    closeModal();
  };

  return (
    <Modal title="Start agent pane">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 rounded border border-line bg-raised p-3 text-xs text-soft">
          <Bot size={18} className="text-plum" />
          <span>
            Opens a supervised provider-agent pane, including Ollama/LM Studio through Codex OSS. Enter instructions directly in the pane after launch.
          </span>
        </div>

        <Field label="Project tab">
          <Select
            value={targetProject}
            options={[
              { value: SCRATCH_PROJECT_ID, label: "scratch (no project)" },
              ...projects.map((p) => ({ value: p.id, label: p.name })),
            ]}
            onChange={setTargetProject}
          />
        </Field>

        <>
            <Field label="Agent">
              <Select
                value={agentId}
                options={agents.map((a) => ({
                  value: a.id,
                  label: a.description ? `${a.name} — ${a.description}` : a.name,
                }))}
                onChange={(v) => {
                  setAgentId(v);
                  setModel("");
                }}
              />
            </Field>
            <Field label={`Model (default: ${agent?.model ?? provider?.defaultModel ?? "provider default"})`}>
              <Select
                value={model}
                options={[
                  { value: "", label: "— provider default —" },
                  ...(provider?.models ?? []).map((m) => ({ value: m.id, label: m.label })),
                ]}
                onChange={setModel}
              />
            </Field>
            <Field label={`Working directory ${project ? `(default: ${project.path})` : "(default: ~)"}`}>
              <TextInput value={cwd} placeholder="leave empty for project folder" onChange={setCwd} />
            </Field>
        </>

        <Field label="Pane name (optional)">
          <TextInput value={displayName} placeholder='e.g. "codex — checkout flow"' onChange={setDisplayName} />
        </Field>

        <button
          onClick={spawn}
          disabled={!agent}
          className="rounded bg-amber px-3 py-2 text-xs font-medium text-ink hover:bg-amber/90 disabled:opacity-40"
        >
          Start {agent?.name ?? "agent"}
        </button>
      </div>
    </Modal>
  );
}
