"use client";

import { useEffect } from "react";
import { ArrowLeft, X } from "lucide-react";
import { useUiStore } from "@/stores/ui";

export function Modal({
  title,
  children,
  wide,
  xwide,
  huge,
  flush,
}: {
  title: string;
  children: React.ReactNode;
  wide?: boolean;
  /** extra-wide — e.g. the Configuration hub, so all tabs sit on one row */
  xwide?: boolean;
  /** widest — e.g. the Documentation page (tree nav + content) */
  huge?: boolean;
  /** drop the body padding/scroll so the modal owns its own layout (multi-pane) */
  flush?: boolean;
}) {
  const closeModal = useUiStore((s) => s.closeModal);
  const closeAll = useUiStore((s) => s.closeAll);
  // a modal layered on top of another (e.g. an editor opened from Configuration)
  // can go BACK to its parent rather than dismiss everything
  const canGoBack = useUiStore((s) => s.stack.length > 1);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal(); // Esc dismisses the current layer (→ back)
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeModal]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeModal();
      }}
    >
      <div
        className={`flex max-h-[92vh] w-full ${huge ? "h-[88vh] max-w-5xl" : xwide ? "max-w-4xl" : wide ? "max-w-2xl" : "max-w-md"} flex-col rounded-lg border border-line bg-panel shadow-2xl`}
      >
        <div className="flex flex-none items-center gap-2 border-b border-line px-4 py-3">
          {canGoBack && (
            <button
              onClick={closeModal}
              className="-ml-1 flex items-center gap-1 rounded px-1 py-0.5 text-xs text-soft hover:bg-raised hover:text-text"
              title="Back"
            >
              <ArrowLeft size={14} /> Back
            </button>
          )}
          <h2 className="truncate text-sm font-medium text-white">{title}</h2>
          <button
            onClick={closeAll}
            className="ml-auto text-faint hover:text-soft"
            aria-label={canGoBack ? "Close all" : "Close"}
            title={canGoBack ? "Close all" : "Close"}
          >
            <X size={16} />
          </button>
        </div>
        {flush ? (
          <div className="flex min-h-0 flex-1 overflow-hidden">{children}</div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        )}
      </div>
    </div>
  );
}
