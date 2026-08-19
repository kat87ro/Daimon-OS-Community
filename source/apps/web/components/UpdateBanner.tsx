"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { UpdateInfo } from "@/lib/desktopBridge";

// Non-intrusive update notification banner — shown only in the Electron shell
// when the main process detects a newer GitHub release. Dismissed per session.
export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.daimon?.onUpdateAvailable) return;
    const unsub = window.daimon.onUpdateAvailable(setUpdate);
    return unsub;
  }, []);

  if (!update) return null;

  return (
    <div className="flex items-center justify-between gap-3 bg-amber px-4 py-2 text-[12px] font-medium text-ink">
      <span>
        Daimon OS {update.version} is available.{" "}
        <a
          href={update.url}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:opacity-80"
          onClick={(e) => {
            e.preventDefault();
            // open in system browser; window.open blocked in Electron context
            window.open(update.url, "_blank");
          }}
        >
          Download
        </a>
      </span>
      <button
        onClick={() => setUpdate(null)}
        aria-label="Dismiss update notification"
        className="flex-none rounded p-0.5 hover:bg-ink/10"
      >
        <X size={14} />
      </button>
    </div>
  );
}
