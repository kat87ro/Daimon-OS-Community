"use client";

import { useUiStore } from "@/stores/ui";
import { AgentModal } from "./AgentModal";
import { BlueprintModal } from "./BlueprintModal";
import { ConfigurationModal } from "./ConfigurationModal";
import { DocsModal } from "./docs/DocsModal";
import { FusionRunsModal } from "./FusionRunsModal";
import { GoalModal } from "./GoalModal";
import { GitModal } from "./GitModal";
import { McpModal } from "./McpModal";
import { OrgChartModal } from "./OrgChartModal";
import { ProjectModal } from "./ProjectModal";
import { ProviderImportModal } from "./ProviderImportModal";
import { ProviderModal } from "./ProviderModal";
import { ReviewModal } from "./ReviewModal";
import { ScheduleModal } from "./ScheduleModal";
import { SecretModal } from "./SecretModal";
import { SettingsModal } from "./SettingsModal";
import { SetupWizardModal } from "./SetupWizardModal";
import { SkillCloneModal } from "./SkillCloneModal";
import { SkillModal } from "./SkillModal";
import { SpawnModal } from "./SpawnModal";
import { TaskModal } from "./TaskModal";
import { TeamModal } from "./TeamModal";

export function ModalHost() {
  const modal = useUiStore((s) => s.modal);
  if (!modal) return null;
  switch (modal.type) {
    case "spawn":
      return <SpawnModal projectId={modal.projectId} />;
    case "project":
      return <ProjectModal id={modal.id} parentProjectId={modal.parentProjectId} />;
    case "git":
      return <GitModal projectId={modal.projectId} />;
    case "team":
      return <TeamModal id={modal.id} />;
    case "org":
      return <OrgChartModal />;
    case "org-team":
      return <OrgChartModal rootTeamId={modal.teamId} />;
    case "agent":
      return <AgentModal id={modal.id} />;
    case "fusion-runs":
      return <FusionRunsModal agentId={modal.agentId} />;
    case "provider":
      return <ProviderModal id={modal.id} />;
    case "skill":
      return <SkillModal id={modal.id} />;
    case "skill-clone":
      return <SkillCloneModal skillId={modal.skillId} />;
    case "mcp":
      return <McpModal id={modal.id} />;
    case "secret":
      return <SecretModal id={modal.id} />;
    case "blueprint":
      return <BlueprintModal id={modal.id} />;
    case "schedule":
      return <ScheduleModal id={modal.id} />;
    case "task":
      return <TaskModal projectId={modal.projectId} id={modal.id} />;
    case "goal":
      return <GoalModal projectId={modal.projectId} id={modal.id} />;
    case "review":
      return <ReviewModal taskId={modal.taskId} />;
    case "provider-import":
      return <ProviderImportModal providerId={modal.providerId} />;
    case "configuration":
      return <ConfigurationModal tab={modal.tab} notice={modal.notice} />;
    case "settings":
      return <SettingsModal />;
    case "setup-wizard":
      return <SetupWizardModal />;
    case "docs":
      return <DocsModal section={modal.section} />;
  }
}
