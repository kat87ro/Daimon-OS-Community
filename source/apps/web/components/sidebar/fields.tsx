"use client";

import { useEffect, useState } from "react";

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-soft">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded border border-line bg-raised px-2 py-1.5 text-xs text-white outline-none placeholder:italic placeholder:text-faint focus:border-amber";

/** small muted, italic example/format hint shown under a field */
export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="-mt-0.5 text-[10px] italic leading-relaxed text-faint">{children}</p>;
}

export function TextInput(props: {
  value: string;
  placeholder?: string;
  type?: "text" | "password";
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <input
      className={inputCls}
      type={props.type ?? "text"}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

export function NumberInput(props: {
  value: number;
  min?: number;
  max?: number;
  onChange: (v: number) => void;
}) {
  // Local string draft so transient empty/partial input is allowed while typing.
  const [draft, setDraft] = useState(String(props.value));

  // Keep the draft in sync when the committed value changes from outside.
  useEffect(() => {
    setDraft(String(props.value));
  }, [props.value]);

  return (
    <input
      type="number"
      className={inputCls}
      value={draft}
      min={props.min}
      max={props.max}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        // Permissive: do NOT clamp during typing. Propagate the parsed number
        // up only when it is a finite number; allow empty/partial drafts.
        const n = Number(raw);
        if (raw !== "" && Number.isFinite(n)) {
          props.onChange(n);
        }
      }}
      onBlur={() => {
        // Commit on blur: parse, clamp to [min,max], then sync draft + value.
        const parsed = Number(draft);
        const base = Number.isFinite(parsed) ? parsed : (props.min ?? 0);
        const clamped = Math.min(props.max ?? base, Math.max(props.min ?? base, base));
        setDraft(String(clamped));
        if (clamped !== props.value) {
          props.onChange(clamped);
        }
      }}
    />
  );
}

export function TextArea(props: {
  value: string;
  rows?: number;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <textarea
      className={`${inputCls} resize-y`}
      rows={props.rows ?? 3}
      placeholder={props.placeholder}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

export function Select(props: {
  value: string;
  options: Array<string | { value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <select
      className={inputCls}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    >
      {props.options.map((o) => {
        const { value, label } = typeof o === "string" ? { value: o, label: o } : o;
        return (
          <option key={value} value={value}>
            {label}
          </option>
        );
      })}
    </select>
  );
}

export function SaveButton({
  saving,
  onClick,
  label = "Save",
  disabled = false,
}: {
  saving: boolean;
  onClick: () => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={saving || disabled}
      className="rounded border border-line bg-raised px-3 py-1.5 text-xs text-white hover:border-amber disabled:opacity-50"
    >
      {saving ? "Saving…" : label}
    </button>
  );
}
