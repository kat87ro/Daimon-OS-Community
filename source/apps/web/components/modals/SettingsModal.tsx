"use client";

import { useUiStore } from "@/stores/ui";
import { Modal } from "./Modal";
import { OrchestratorSettings } from "./OrchestratorSettings";

/** Standalone wrapper kept for the `{type:"settings"}` route. The orchestrator
 *  settings now live primarily as a tab in the Configuration hub; this reuses
 *  the same form and closes the modal on save. */
export function SettingsModal() {
  const closeModal = useUiStore((s) => s.closeModal);
  return (
    <Modal title="Orchestrator settings">
      <OrchestratorSettings onSaved={closeModal} />
    </Modal>
  );
}
