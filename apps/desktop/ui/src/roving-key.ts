export function handleRovingKey(
  event: KeyboardEvent,
  index: number,
  options: readonly { id: string }[],
  onChange: (id: string) => void,
  items: readonly (HTMLElement | undefined)[],
): void {
  if (options.length === 0) return;
  let next: number | undefined;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % options.length;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = options.length - 1;
  if (next === undefined) return;
  event.preventDefault();
  onChange(options[next]!.id);
  items[next]?.focus();
}
