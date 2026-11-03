import { useCallback, useEffect, useRef, useState } from 'react';
import type { Result, VssApi } from '@shared/ipc/contract';
import { useUi } from '../store';

export class ApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The preload bridge (or the dev mock). Always resolved lazily so tests can swap it. */
export function vss(): VssApi {
  return window.vss;
}

export async function unwrap<T>(p: Promise<Result<T>>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new ApiError(r.error.code, r.error.message);
  return r.value;
}

export interface QueryState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Fetch on mount and whenever `deps` change. Stale responses are dropped. */
export function useQuery<T>(fn: () => Promise<Result<T>>, deps: readonly unknown[]): QueryState<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fnRef.current().then(
      (r) => {
        if (!alive) return;
        setState(
          r.ok
            ? { data: r.value, error: null, loading: false }
            : { data: null, error: r.error.message, loading: false },
        );
      },
      (e: unknown) => {
        if (alive) setState({ data: null, error: e instanceof Error ? e.message : 'Unexpected error', loading: false });
      },
    );
    return () => {
      alive = false;
    };
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((x) => x + 1), []);
  return { ...state, reload };
}

/** Run a mutation; errors become toasts and the call resolves to undefined. */
export function useAction(): <T>(p: Promise<Result<T>>, successMessage?: string) => Promise<T | undefined> {
  const toast = useUi((s) => s.pushToast);
  return useCallback(
    async <T>(p: Promise<Result<T>>, successMessage?: string) => {
      try {
        const r = await p;
        if (!r.ok) {
          toast({ kind: 'error', message: r.error.message });
          return undefined;
        }
        if (successMessage) toast({ kind: 'success', message: successMessage });
        return r.value;
      } catch (e) {
        toast({ kind: 'error', message: e instanceof Error ? e.message : 'Unexpected error' });
        return undefined;
      }
    },
    [toast],
  );
}
