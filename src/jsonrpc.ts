export type Id = string | number | null;
export type JsonObject = Record<string, unknown>;

export interface RpcMessage extends JsonObject {
  jsonrpc?: string;
  id?: Id;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isRequest(m: unknown): m is RpcMessage & { method: string; id: Id } {
  return isObject(m) && typeof m.method === 'string' && 'id' in m && m.id !== undefined;
}

export function isNotification(m: unknown): m is RpcMessage & { method: string } {
  return isObject(m) && typeof m.method === 'string' && !('id' in m && m.id !== undefined);
}

export function isResponse(m: unknown): m is RpcMessage & { id: Id } {
  return isObject(m) && typeof m.method !== 'string' && 'id' in m && ('result' in m || 'error' in m);
}

/** Stable map key for a JSON-RPC id (1 and "1" are different ids). */
export function idKey(id: unknown): string {
  return JSON.stringify(id === undefined ? null : id);
}
