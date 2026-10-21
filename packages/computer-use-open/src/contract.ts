export interface NativeTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/** Native payloads, including screenshots, errors and query truncation, remain opaque. */
export interface NativeResult {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface NativeComputerPort {
  listTools(): Promise<NativeTool[]>;
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<NativeResult>;
  /** Clear native element/session caches before admission of a different turn. */
  endTurn(): Promise<void>;
  /** Idempotent; closes only this gateway's native transport, never another app. */
  close(): Promise<void>;
}

export interface ComputerUseOpenContract {
  /** Discovery has no native actions. Preview omits enumeration; production exposes narrowed native schemas. */
  listTools(): Promise<NativeTool[]>;
  /** Serialized, no replay. Trusted metadata is separate from model arguments. */
  call(
    name: string,
    args: Record<string, unknown>,
    meta: unknown,
    signal: AbortSignal,
  ): Promise<NativeResult>;
  /** Trusted host turn-complete notification; late events never interrupt a newer turn. */
  endTurn?(meta: unknown): Promise<void>;
  /** Cancels this instance and rejects subsequent calls; no persistence or events. */
  close(): Promise<void>;
}
