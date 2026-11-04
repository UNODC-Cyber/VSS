import { useEffect, useState } from 'react';
import type { AppInfo } from '@shared/ipc/contract';
import { vss } from '../lib/api';

/** Build info (version, channel, schema) from main; null until it answers. It carries no vault data. */
export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    let live = true;
    void vss()
      .app.info()
      .then((r) => {
        if (live && r.ok) setInfo(r.value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return info;
}
