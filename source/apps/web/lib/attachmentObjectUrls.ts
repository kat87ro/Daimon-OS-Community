"use client";

import { useEffect, useState } from "react";
import type { Attachment } from "@daimon-os/shared";
import { api } from "./api";

/**
 * Fetch authenticated attachment bytes and expose only local blob URLs to DOM
 * elements. Every URL is revoked on attachment changes/unmount.
 */
export function useAttachmentObjectUrls(attachments: readonly Attachment[]): {
  urls: Readonly<Record<string, string>>;
  loadError?: string;
} {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string>();
  const ids = attachments.map((attachment) => attachment.id).join(",");

  useEffect(() => {
    const abort = new AbortController();
    const created: string[] = [];
    setUrls({});
    setLoadError(undefined);
    void Promise.all(
      attachments.map(async (attachment) => {
        const blob = await api.attachments.download(attachment.id, abort.signal);
        const objectUrl = URL.createObjectURL(blob);
        if (abort.signal.aborted) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        created.push(objectUrl);
        setUrls((current) => ({ ...current, [attachment.id]: objectUrl }));
      }),
    ).catch((err: unknown) => {
      if (!abort.signal.aborted) {
        setLoadError(err instanceof Error ? err.message : "attachment download failed");
      }
    });
    return () => {
      abort.abort();
      for (const objectUrl of created) URL.revokeObjectURL(objectUrl);
    };
    // The stable id list represents the fetch set; metadata-only changes do not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  return { urls, loadError };
}
