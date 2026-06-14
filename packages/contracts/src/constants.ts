/** API version surfaced in the URL and the health payload. */
export const API_VERSION = 'v1' as const;

/** Global REST prefix — all business endpoints live under `/api/v1`. */
export const API_GLOBAL_PREFIX = 'api/v1' as const;

/** Swagger / OpenAPI docs path. */
export const API_DOCS_PATH = 'api/docs' as const;

/** Correlation header echoed on every response. */
export const REQUEST_ID_HEADER = 'x-request-id' as const;
