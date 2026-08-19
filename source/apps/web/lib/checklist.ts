export interface ChecklistSearchOption {
  label: string;
  description?: string;
  group?: string;
  keywords?: string[];
}

export function filterChecklistOptions<T extends ChecklistSearchOption>(
  options: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...options];
  return options.filter((option) =>
    [option.label, option.description, option.group, ...(option.keywords ?? [])]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase().includes(needle)),
  );
}
