/** A result line names one archived session. It stays only while that session is still in the list. */
export function visibleArchiveNote(
  note: { id: string; text: string } | undefined,
  ids: readonly string[],
): string | undefined {
  if (!note || !ids.includes(note.id)) return undefined;
  return note.text;
}
