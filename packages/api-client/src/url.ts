/**
 * Join a base URL and a path into a single normalized URL, collapsing any
 * duplicate slash at the boundary. Pure and side-effect free so it can be
 * unit-tested without a network.
 */
export function buildUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  const trimmedPath = path.replace(/^\/+/, '');
  return trimmedPath ? `${trimmedBase}/${trimmedPath}` : trimmedBase;
}
