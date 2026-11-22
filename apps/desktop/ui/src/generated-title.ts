/**
 * Whether a session title is the backend's placeholder rather than a name
 * somebody chose.
 *
 * It lives in its own module because two things need the same answer — the
 * label on screen and the file name an export is saved under — and the file
 * name is built in the API layer, which the label's module already depends
 * on. A leaf keeps both honest without either importing the other.
 */
export function isGeneratedTitle(title: string): boolean {
  return /^new session\s*-\s*\d{4}-\d{2}-\d{2}t/i.test(title.trim());
}
