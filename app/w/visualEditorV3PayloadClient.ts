type CachedPayload = {
  ok: boolean;
  status: number;
  payload: unknown;
};

type CachedResponse = {
  ok: boolean;
  status: number;
  json: <T = unknown>() => Promise<T>;
};

const payloadCache = new Map<string, Promise<CachedPayload>>();

function cacheKey(title: string) {
  return title.normalize("NFKC").trim();
}

function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

async function loadPayload(title: string): Promise<CachedPayload> {
  const key = cacheKey(title);
  let pending = payloadCache.get(key);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(`/api/wiki-edit-document-v3?title=${encodeURIComponent(title)}`, { cache: "no-store" });
      const payload = await response.json();
      const result = { ok: response.ok, status: response.status, payload };
      if (!response.ok) payloadCache.delete(key);
      return result;
    })().catch((error) => {
      payloadCache.delete(key);
      throw error;
    });
    payloadCache.set(key, pending);
  }
  return pending;
}

/**
 * Browser-side V3 document payload cache.
 *
 * Every V3 bridge used to fetch and JSON-parse the complete AST independently
 * when edit mode started. Large wiki pages therefore multiplied the same work
 * across all bridges. This returns a lightweight Response-like wrapper backed
 * by one shared parsed payload per page/title.
 *
 * Abort signals are consumer-local: aborting one bridge never cancels the
 * shared request needed by the other bridges.
 */
export async function fetchVisualEditorV3Payload(title: string, signal?: AbortSignal): Promise<CachedResponse> {
  if (signal?.aborted) throw abortError();
  const result = await loadPayload(title);
  if (signal?.aborted) throw abortError();
  return {
    ok: result.ok,
    status: result.status,
    json: async <T = unknown>() => result.payload as T,
  };
}

export function clearVisualEditorV3Payload(title?: string) {
  if (title) payloadCache.delete(cacheKey(title));
  else payloadCache.clear();
}
