import { useCallback, useRef, useState } from "react";
import { saveConfig, type Config } from "../../config/config";

/** In-memory config snapshot plus serialized, observable disk persistence. */
export function useConfig(setNotice: (notice: string | null) => void) {
  const [config, setConfig] = useState<Config | null>(null);
  const configRef = useRef<Config | null>(null);

  /** Load a disk snapshot without writing it back. */
  const hydrateConfig = useCallback((next: Config) => {
    setConfig(next);
    configRef.current = next;
  }, []);

  const commitConfig = useCallback((next: Config) => {
    hydrateConfig(next);
    void saveConfig(next).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      setNotice(`Could not save settings: ${detail}`);
    });
  }, [hydrateConfig, setNotice]);

  /** Resolve a user action against the latest synchronous snapshot. */
  const updateConfig = useCallback((updater: (current: Config) => Config) => {
    const current = configRef.current;
    if (!current) return;
    commitConfig(updater(current));
  }, [commitConfig]);

  return { config, configRef, hydrateConfig, commitConfig, updateConfig };
}
