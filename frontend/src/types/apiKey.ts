/** API-key shapes — mirror the backend `ApiKeyOut` / `ApiKeyCreatedOut`
 *  (app/schemas/api_key.py). The raw `api_key` is present only on creation and
 *  is never stored or re-fetched. */
export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface ApiKeyCreated extends ApiKey {
  /** Raw secret — returned exactly once, at creation. */
  api_key: string;
}
