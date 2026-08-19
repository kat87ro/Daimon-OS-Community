"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { filterChecklistOptions } from "@/lib/checklist";

export interface SearchableChecklistOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
  keywords?: string[];
  disabled?: boolean;
}

export function SearchableChecklist({
  options,
  selected,
  onChange,
  placeholder = "Select options",
  searchPlaceholder = "Search…",
}: {
  options: readonly SearchableChecklistOption[];
  selected: readonly string[];
  onChange: (selected: string[]) => void;
  placeholder?: string;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const visible = useMemo(() => filterChecklistOptions(options, query), [options, query]);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const groups = [...new Set(visible.map((option) => option.group ?? "Options"))];
  const selectedLabels = options.filter((option) => selectedSet.has(option.value)).map((option) => option.label);
  const summary = selectedLabels.length === 0
    ? placeholder
    : selectedLabels.length <= 2
      ? selectedLabels.join(", ")
      : `${selectedLabels.slice(0, 2).join(", ")} +${selectedLabels.length - 2}`;

  const commit = (next: Set<string>) => onChange(options
    .filter((option) => next.has(option.value))
    .map((option) => option.value));

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded border border-line bg-raised px-2 py-1.5 text-left text-xs text-white outline-none hover:border-amber focus:border-amber"
      >
        <span className={`min-w-0 flex-1 truncate ${selectedLabels.length ? "text-white" : "text-faint"}`}>
          {summary}
        </span>
        <span className="rounded bg-ink px-1.5 py-0.5 text-[10px] text-soft">{selectedLabels.length}</span>
        <ChevronDown size={13} className={`text-faint transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-[80] mt-1 overflow-hidden rounded border border-line bg-panel shadow-2xl">
          <div className="border-b border-line p-2">
            <div className="flex items-center gap-2 rounded border border-line bg-ink px-2 focus-within:border-amber">
              <Search size={12} className="text-faint" />
              <input
                ref={search}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                className="min-w-0 flex-1 bg-transparent py-1.5 text-xs text-white outline-none placeholder:text-faint"
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-[10px]">
              <span className="text-faint">{visible.length} of {options.length} available</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="text-sky hover:underline"
                  onClick={() => {
                    const next = new Set(selectedSet);
                    for (const option of visible) next.add(option.value);
                    commit(next);
                  }}
                >
                  Select visible
                </button>
                <button
                  type="button"
                  className="text-soft hover:underline"
                  onClick={() => {
                    const next = new Set(selectedSet);
                    for (const option of visible) {
                      if (!option.disabled) next.delete(option.value);
                    }
                    commit(next);
                  }}
                >
                  Clear visible
                </button>
              </div>
            </div>
          </div>

          <div role="listbox" aria-multiselectable="true" className="max-h-72 overflow-y-auto p-1.5">
            {groups.map((group) => (
              <div key={group} className="mb-1.5 last:mb-0">
                <p className="px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-faint">{group}</p>
                {visible.filter((option) => (option.group ?? "Options") === group).map((option) => {
                  const checked = selectedSet.has(option.value);
                  return (
                    <label
                      key={option.value}
                      className={`flex items-start gap-2 rounded px-2 py-1.5 ${option.disabled ? "cursor-default opacity-70" : "cursor-pointer hover:bg-raised"}`}
                    >
                      <span className={`mt-0.5 flex h-3.5 w-3.5 flex-none items-center justify-center rounded border ${checked ? "border-amber bg-amber text-ink" : "border-line bg-ink"}`}>
                        {checked && <Check size={10} strokeWidth={3} />}
                      </span>
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={checked}
                        disabled={option.disabled}
                        onChange={(event) => {
                          const next = new Set(selectedSet);
                          if (event.target.checked) next.add(option.value);
                          else next.delete(option.value);
                          commit(next);
                        }}
                      />
                      <span className="min-w-0">
                        <span className="block text-[11px] text-text">
                          {option.label}{option.disabled ? " · always attached" : ""}
                        </span>
                        {option.description && <span className="block text-[9px] leading-relaxed text-faint">{option.description}</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            ))}
            {visible.length === 0 && <p className="px-3 py-6 text-center text-[11px] text-faint">No matching tools.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
