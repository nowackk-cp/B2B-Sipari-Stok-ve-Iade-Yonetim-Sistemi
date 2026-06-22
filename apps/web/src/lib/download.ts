/**
 * Trigger a browser download for an in-memory blob.
 *
 * The export endpoint returns the CSV as a blob (not a navigable URL), so we
 * wrap it in an object URL, click a transient anchor, then revoke the URL. Kept
 * in its own module so callers (and their tests) can mock the DOM side-effect.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
