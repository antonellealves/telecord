import { useCallback, useState } from 'react';
import { normalizeDisplayName } from '@telecord/shared';
import { readStoredDisplayName, writeStoredDisplayName } from '../lib/storage';

/** Nome de exibição persistido em localStorage (SPEC §5). */
export function useDisplayName(): [string, (value: string) => void] {
  const [displayName, setDisplayName] = useState<string>(() => readStoredDisplayName());

  const update = useCallback((value: string) => {
    const normalized = normalizeDisplayName(value);
    setDisplayName(normalized);
    writeStoredDisplayName(normalized);
  }, []);

  return [displayName, update];
}
