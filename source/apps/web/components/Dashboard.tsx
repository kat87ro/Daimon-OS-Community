"use client";

import { useEffect } from "react";
import { gateway } from "@/lib/gateway/GatewayClient";
import { useConfigStore } from "@/stores/config";
import { useLayoutStore } from "@/stores/layout";
import { useUiStore } from "@/stores/ui";
import { ModalHost } from "./modals/ModalHost";
import { Sidebar } from "./sidebar/Sidebar";
import { GoalsStrip } from "./grid/GoalsStrip";
import { MasterLog } from "./MasterLog";
import { ProjectTabs } from "./grid/ProjectTabs";
import { ProjectView } from "./grid/ProjectView";
import { TopBar } from "./TopBar";
import { BottomActionBar } from "./BottomActionBar";
import { UpdateBanner } from "./UpdateBanner";
import { GlobalDashboard } from "./GlobalDashboard";
import { AuditLog } from "./AuditLog";

export default function Dashboard() {
  const loadAll = useConfigStore((s) => s.loadAll);
  const setSidebarCollapsed = useLayoutStore((s) => s.setSidebarCollapsed);
  const openModal = useUiStore((s) => s.openModal);
  const globalView = useLayoutStore((s) => s.globalView);

  useEffect(() => {
    gateway.connect();
    void loadAll()
      .then(() => {
        // First-run onboarding: a fresh/empty install (no providers) that hasn't
        // been onboarded opens the Setup Wizard once. Reads post-load state
        // directly so it reflects what the server actually returned.
        const { providers, settings } = useConfigStore.getState();
        if (providers.length === 0 && !settings?.onboarded) {
          openModal({ type: "setup-wizard" });
        }
      })
      .catch(() => {
        /* surfaced via gateway error pill; REST retries on tab change */
      });
    // start collapsed on phones so the dashboard opens to content, not the menu
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      setSidebarCollapsed(true);
    }
  }, [loadAll, setSidebarCollapsed, openModal]);

  return (
    <div className="safe-px flex h-[100dvh] flex-col bg-ink text-sm">
      <UpdateBanner />
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          {globalView === "dashboard" ? (
            <GlobalDashboard />
          ) : globalView === "master-chat" ? (
            <MasterLog embedded />
          ) : globalView === "audit" ? (
            <AuditLog />
          ) : (
            <>
              <ProjectTabs />
              <GoalsStrip />
              <ProjectView />
              <BottomActionBar />
            </>
          )}
        </div>
      </div>
      {globalView === null && <MasterLog />}
      <ModalHost />
    </div>
  );
}
