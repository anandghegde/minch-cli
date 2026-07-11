import { useCallback, type MutableRefObject } from "react";
import type { Config } from "../../config/config";
import { clearCache } from "../../sources/cache";
import { probeAll, probeSource } from "../../sources/health";
import { activeMirror, isEnabled, type Registry } from "../../sources/registry";
import { mergeSourceProbe } from "../source-state";

interface SourceActionsOptions {
  registry: Registry | null;
  configRef: MutableRefObject<Config | null>;
  updateConfig: (updater: (current: Config) => Config) => void;
  setNotice: (notice: string | null) => void;
}

/** Source toggles, mirror choice, and async health retests. */
export function useSourceActions({
  registry,
  configRef,
  updateConfig,
  setNotice,
}: SourceActionsOptions) {
  const retestSource = useCallback(
    (id: string, mirror?: string) => {
      const reg = registry;
      const started = configRef.current;
      if (!reg || !started) return;
      const source = reg.byId.get(id);
      if (!source) return;
      clearCache();
      setNotice(`Testing ${source.label}…`);
      void (async () => {
        const base = mirror ?? activeMirror(source, started);
        const outcome = await probeSource(
          mirror ? { ...source, links: [mirror] } : source,
          base,
        );
        updateConfig((current) =>
          mergeSourceProbe(current, started, source, outcome, mirror),
        );
        setNotice(
          `${source.label}: ${outcome.health.ok ? "working" : outcome.health.code ?? "failed"}`,
        );
      })();
    },
    [registry, configRef, updateConfig, setNotice],
  );

  const retestAll = useCallback(() => {
    const reg = registry;
    const started = configRef.current;
    if (!reg || !started) return;
    clearCache();
    setNotice("Retesting all sources…");
    void (async () => {
      const targets = reg.sources.filter((source) => !source.requiresConfig);
      const outcomes = await probeAll(targets, (source) => activeMirror(source, started), () => {});
      updateConfig((current) => outcomes.reduce((updated, outcome) => {
        const source = reg.byId.get(outcome.id);
        return source ? mergeSourceProbe(updated, started, source, outcome) : updated;
      }, current));
      setNotice("Retest complete.");
    })();
  }, [registry, configRef, updateConfig, setNotice]);

  const toggleSource = useCallback(
    (id: string) => {
      const source = registry?.byId.get(id);
      if (!source || !configRef.current) return;
      updateConfig((current) => ({
        ...current,
        sources: {
          ...current.sources,
          [id]: { ...current.sources[id], enabled: !isEnabled(source, current) },
        },
      }));
    },
    [registry, configRef, updateConfig],
  );

  const setMirror = useCallback(
    (id: string, mirror: string) => {
      updateConfig((current) => ({
        ...current,
        sources: {
          ...current.sources,
          [id]: {
            ...current.sources[id],
            enabled: current.sources[id]?.enabled ?? true,
            mirror,
          },
        },
      }));
    },
    [updateConfig],
  );

  return { retestSource, retestAll, toggleSource, setMirror };
}
