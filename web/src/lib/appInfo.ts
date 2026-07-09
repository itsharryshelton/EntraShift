/**
 * Per-deployment branding hook. One EntraShift Worker serves ONE customer (no mixing) — the
 * Worker's PROJECT_NAME var identifies which one. Fetched once from the public GET /api/app-info
 * and cached module-side; the browser tab title is set to the project name so the customer is
 * obvious even from the taskbar.
 */
import { useEffect, useState } from 'react';
import { getAppInfo, type AppInfo } from './api';

const DEFAULT: AppInfo = { projectName: 'EntraShift', product: 'EntraShift' };

let cached: AppInfo | null = null;

function applyTitle(info: AppInfo): void {
  document.title =
    info.projectName && info.projectName !== info.product
      ? `${info.projectName} · ${info.product}`
      : info.product;
}

export function useAppInfo(): AppInfo {
  const [info, setInfo] = useState<AppInfo>(cached ?? DEFAULT);

  useEffect(() => {
    if (cached) {
      applyTitle(cached);
      return;
    }
    let alive = true;
    getAppInfo()
      .then((i) => {
        cached = i;
        if (!alive) return;
        setInfo(i);
        applyTitle(i);
      })
      .catch(() => {
        /* keep the default; app-info is non-critical branding */
      });
    return () => {
      alive = false;
    };
  }, []);

  return info;
}
