import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store";
import { resolveKey, maskKey } from "../../debrid/keys";
import { PROVIDER_LABELS, type DebridId } from "../../debrid/types";
import type {
  DiscoveryAdapterId,
  ImdbRatingProvider,
  RelevanceConfig,
} from "../../config/config";
import { truncate } from "../../util/format";
import { COLOR, ICON } from "../theme";
import { editText } from "../text-input";
import {
  isDiscoveryAdapterEnabled,
  resolveStreamingAvailabilityCredential,
  resolveApifyCredential,
  resolveFirecrawlCredential,
  resolveTmdbCredential,
  withDiscoveryAdapterEnabled,
  resolveMdblistCredential,
  withDiscoveryRatingProvider,
} from "../../discovery/config";

type SettingId =
  | "torbox"
  | "realdebrid"
  | "downloadDir"
  | "preferred"
  | "preferQuality"
  | "hideTrash"
  | "strictAnd"
  | "tmdb"
  | "streamingAvailability"
  | "apify"
  | "firecrawl"
  | "discoveryTmdb"
  | "discoveryStreaming"
  | "discoveryApify"
  | "discoveryBluray"
  | "discoveryTamilmv"
  | "ratingProvider"
  | "mdblist";

type Editing = {
  id: "torbox" | "realdebrid" | "tmdb" | "streamingAvailability" | "apify" | "firecrawl" | "mdblist" | "downloadDir";
  draft: string;
  cursor: number;
};

const SETTING_IDS: SettingId[] = [
  "torbox",
  "realdebrid",
  "downloadDir",
  "tmdb",
  "streamingAvailability",
  "discoveryTmdb",
  "discoveryStreaming",
  "discoveryBluray",
  "ratingProvider",
  "mdblist",
  "preferred",
  "preferQuality",
  "hideTrash",
  "strictAnd",
  "apify",
  "discoveryApify",
  "firecrawl",
  "discoveryTamilmv",
];

const PREFERRED: Array<DebridId | undefined> = [undefined, "torbox", "realdebrid"];
const RATING_PROVIDERS: ImdbRatingProvider[] = ["off", "imdb-dataset", "mdblist"];
const RATING_PROVIDER_LABELS: Record<ImdbRatingProvider, string> = {
  off: "Off",
  "imdb-dataset": "Official dataset",
  mdblist: "MDBList",
};

const DISCOVERY_ADAPTER_SETTINGS: Partial<Record<SettingId, {
  source: DiscoveryAdapterId;
  label: string;
}>> = {
  discoveryTmdb: { source: "tmdb", label: "TMDB discovery" },
  discoveryStreaming: {
    source: "streaming-availability",
    label: "Streaming Availability discovery",
  },
  discoveryApify: { source: "apify", label: "Apify discovery" },
  discoveryBluray: { source: "bluray", label: "Blu-ray RSS discovery" },
  discoveryTamilmv: { source: "tamilmv", label: "TamilMV discovery" },
};

function providerLabel(id: DebridId | undefined): string {
  return id ? PROVIDER_LABELS[id] : "Auto (first configured)";
}

/** Persistent application settings, including credentials and local download behavior. */
export function Settings({
  active,
  onEditingChange,
}: {
  active: boolean;
  onEditingChange: (editing: boolean) => void;
}) {
  const store = useStore();
  const { config, cols, listRows } = store;
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<Editing | null>(null);

  const setEditState = (next: Editing | null): void => {
    setEditing(next);
    onEditingChange(next !== null);
  };

  const saveDirectory = (draft: string): void => {
    const value = draft.trim();
    store.updateConfig((current) => ({
      ...current,
      debrid: { ...(current.debrid ?? {}), downloadDir: value || undefined },
    }));
    store.setNotice(value ? "Saved download folder." : "Using the OS Downloads folder.");
  };

  const saveRelevance = (id: keyof RelevanceConfig): void => {
    store.updateConfig((current) => {
      const relevance = { ...(current.relevance ?? {}) };
      relevance[id] = relevance[id] !== true;
      const hasEnabled = Object.values(relevance).some((value) => value === true);
      return { ...current, relevance: hasEnabled ? relevance : undefined };
    });
    store.setNotice(`${id === "preferQuality" ? "Quality ranking" : id === "hideTrash" ? "Trash release filter" : "Strict matching"} ${relevance[id] ? "enabled" : "disabled"}.`);
  };

  const toggleDiscoveryAdapter = (id: SettingId): void => {
    const descriptor = DISCOVERY_ADAPTER_SETTINGS[id];
    if (!descriptor) return;
    let enabled = false;
    store.updateConfig((current) => {
      enabled = !isDiscoveryAdapterEnabled(current, descriptor.source);
      return withDiscoveryAdapterEnabled(current, descriptor.source, enabled);
    });
    store.setNotice(`${descriptor.label} ${enabled ? "enabled" : "disabled"}.`);
  };

  const setPreferred = (offset: number): void => {
    let selected: DebridId | undefined;
    store.updateConfig((current) => {
      const index = PREFERRED.indexOf(current.debrid?.preferred);
      selected = PREFERRED[(index + offset + PREFERRED.length) % PREFERRED.length];
      return {
        ...current,
        debrid: { ...(current.debrid ?? {}), preferred: selected },
      };
    });
    store.setNotice(`Preferred provider: ${providerLabel(selected)}.`);
  };

  const setRatingProvider = (offset: number): void => {
    const configured = config.discovery?.ratingProvider ?? "off";
    const index = RATING_PROVIDERS.indexOf(configured);
    const selected = RATING_PROVIDERS[(index + offset + RATING_PROVIDERS.length) % RATING_PROVIDERS.length]!;
    store.updateConfig((current) => withDiscoveryRatingProvider(current, selected));
    if (selected === "mdblist" && !resolveMdblistCredential(config).apiKey) {
      store.setNotice("MDBList selected; configure MDBLIST_API_KEY or the MDBList API key setting.");
    } else {
      store.setNotice(`IMDb ratings source: ${RATING_PROVIDER_LABELS[selected]}.`);
    }
  };

  useInput(
    (input, key) => {
      if (editing) {
        if (key.return) {
          if (editing.id === "downloadDir") saveDirectory(editing.draft);
          else if (editing.id === "tmdb") store.saveTmdbToken(editing.draft.trim() || undefined);
            else if (editing.id === "streamingAvailability") {
              store.saveStreamingAvailabilityKey(editing.draft.trim() || undefined);
            }
            else if (editing.id === "apify") store.saveApifyToken(editing.draft.trim() || undefined);
            else if (editing.id === "firecrawl") store.saveFirecrawlKey(editing.draft.trim() || undefined);
          else if (editing.id === "mdblist") store.saveMdblistKey(editing.draft.trim() || undefined);
          else store.saveDebridKey(editing.id, editing.draft.trim() || undefined);
          setEditState(null);
          return;
        }
        if (key.escape) {
          setEditState(null);
          return;
        }
        const edit = editText(editing.draft, editing.cursor, input, key);
        if (edit.handled) {
          setEditing((state) => state
            ? { ...state, draft: edit.value, cursor: edit.cursor }
            : state);
        }
        return;
      }

      if (key.escape) {
        store.setView("search");
      } else if (key.downArrow || input === "j") {
        setCursor((value) => Math.min(SETTING_IDS.length - 1, value + 1));
      } else if (key.upArrow || input === "k") {
        setCursor((value) => Math.max(0, value - 1));
      } else if (key.leftArrow && SETTING_IDS[cursor] === "preferred") {
        setPreferred(-1);
      } else if (key.rightArrow && SETTING_IDS[cursor] === "preferred") {
        setPreferred(1);
      } else if (key.leftArrow && SETTING_IDS[cursor] === "ratingProvider") {
        setRatingProvider(-1);
      } else if (key.rightArrow && SETTING_IDS[cursor] === "ratingProvider") {
        setRatingProvider(1);
      } else if (input === " " && SETTING_IDS[cursor] !== "preferred") {
        const id = SETTING_IDS[cursor]!;
        if (id === "preferQuality" || id === "hideTrash" || id === "strictAnd") saveRelevance(id);
        else if (DISCOVERY_ADAPTER_SETTINGS[id]) toggleDiscoveryAdapter(id);
      } else if (input === "e" || key.return) {
        const id = SETTING_IDS[cursor]!;
        if (id === "torbox" || id === "realdebrid" || id === "tmdb" || id === "streamingAvailability" || id === "apify" || id === "firecrawl" || id === "mdblist") {
          const resolved = id === "tmdb"
            ? resolveTmdbCredential(config)
            : id === "streamingAvailability"
              ? resolveStreamingAvailabilityCredential(config)
              : id === "apify"
                ? resolveApifyCredential(config)
              : id === "firecrawl"
                ? resolveFirecrawlCredential(config)
              : id === "mdblist"
                ? resolveMdblistCredential(config)
              : resolveKey(id, config);
          const label = id === "tmdb"
            ? "TMDB"
              : id === "streamingAvailability"
                ? "Streaming Availability"
                : id === "apify"
                  ? "Apify"
                : id === "firecrawl"
                  ? "Firecrawl"
                : id === "mdblist"
                ? "MDBList"
              : PROVIDER_LABELS[id];
          if (resolved.source === "env") {
            store.setNotice(`${label} key comes from an env var; unset it to edit here.`);
          } else {
           setEditState({ id, draft: "", cursor: 0 });
          }
        } else if (id === "downloadDir") {
          const draft = config.debrid?.downloadDir ?? "";
          setEditState({ id, draft, cursor: draft.length });
        } else if (id === "preferred") {
          setPreferred(1);
        } else if (id === "ratingProvider") {
          setRatingProvider(1);
        } else if (id === "preferQuality" || id === "hideTrash" || id === "strictAnd") {
          saveRelevance(id);
        } else if (DISCOVERY_ADAPTER_SETTINGS[id]) {
          toggleDiscoveryAdapter(id);
        }
      } else if (input === "x") {
        const id = SETTING_IDS[cursor]!;
        if (id === "torbox" || id === "realdebrid" || id === "tmdb" || id === "streamingAvailability" || id === "apify" || id === "firecrawl" || id === "mdblist") {
          const resolved = id === "tmdb"
            ? resolveTmdbCredential(config)
            : id === "streamingAvailability"
              ? resolveStreamingAvailabilityCredential(config)
              : id === "apify"
                ? resolveApifyCredential(config)
              : id === "firecrawl"
                ? resolveFirecrawlCredential(config)
              : id === "mdblist"
                ? resolveMdblistCredential(config)
              : resolveKey(id, config);
          if (resolved.source !== "env") {
            if (id === "tmdb") store.saveTmdbToken(undefined);
            else if (id === "streamingAvailability") store.saveStreamingAvailabilityKey(undefined);
            else if (id === "apify") store.saveApifyToken(undefined);
            else if (id === "firecrawl") store.saveFirecrawlKey(undefined);
            else if (id === "mdblist") store.saveMdblistKey(undefined);
            else store.saveDebridKey(id, undefined);
          }
        } else if (id === "downloadDir") {
          saveDirectory("");
        }
      }
    },
    { isActive: active },
  );

  const selected = SETTING_IDS[cursor];
  const row = (id: SettingId, label: string, value: string, detail?: string) => {
    const isSelected = id === selected;
    const labelWidth = Math.min(28, Math.max(18, Math.floor((cols - 8) * 0.45)));
    const valueWidth = Math.max(12, cols - labelWidth - 10);
    const displayLabel = truncate(label, labelWidth).padEnd(labelWidth, " ");
    return (
      <Text key={`${id}-row`}>
        <Text color={isSelected ? COLOR.accent : COLOR.dim}>{isSelected ? ICON.pointer : " "} </Text>
        <Text color={isSelected ? COLOR.text : COLOR.alt}>{displayLabel}</Text>
        <Text color={isSelected ? COLOR.bright : COLOR.alt}>{truncate(value, valueWidth)}</Text>
        {detail && valueWidth > 18 ? <Text color={COLOR.dim}> {detail}</Text> : null}
      </Text>
    );
  };

  const torboxKey = resolveKey("torbox", config);
  const realdebridKey = resolveKey("realdebrid", config);
  const tmdbToken = resolveTmdbCredential(config);
  const streamingKey = resolveStreamingAvailabilityCredential(config);
  const apifyToken = resolveApifyCredential(config);
  const firecrawlKey = resolveFirecrawlCredential(config);
  const mdblistKey = resolveMdblistCredential(config);
  const relevance = config.relevance ?? {};
  const preferred = config.debrid?.preferred;
  const editingDisplay = editing
    ? editing.id === "downloadDir"
      ? editing.draft
      : "•".repeat(editing.draft.length)
    : "";
  const capacity = Math.max(4, Math.min(6, listRows - (editing ? 7 : 3)));
  const start = Math.max(
    0,
    Math.min(cursor - Math.floor(capacity / 2), SETTING_IDS.length - capacity),
  );
  const visibleSettings = SETTING_IDS.slice(start, start + capacity);
  const settingRow = (id: SettingId) => {
    if (id === "torbox") {
      return row(id, "TorBox API key", torboxKey.key ? maskKey(torboxKey.key) : "not configured", torboxKey.source === "env" ? "env" : undefined);
    }
    if (id === "realdebrid") {
      return row(id, "Real Debrid token", realdebridKey.key ? maskKey(realdebridKey.key) : "not configured", realdebridKey.source === "env" ? "env" : undefined);
    }
    if (id === "downloadDir") {
      return row(id, "Download folder", config.debrid?.downloadDir?.trim() || "OS Downloads folder");
    }
    if (id === "tmdb") {
      return row(id, "TMDB read token", tmdbToken.token ? maskKey(tmdbToken.token) : "not configured", tmdbToken.source === "env" ? "env" : undefined);
    }
    if (id === "streamingAvailability") {
      return row(id, "Streaming Availability key", streamingKey.apiKey ? maskKey(streamingKey.apiKey) : "not configured", streamingKey.source === "env" ? "env" : undefined);
    }
    if (id === "apify") {
      return row(id, "Apify API token", apifyToken.apiToken ? maskKey(apifyToken.apiToken) : "not configured", apifyToken.source === "env" ? "env" : undefined);
    }
    if (id === "firecrawl") {
      return row(id, "Firecrawl API key", firecrawlKey.apiKey ? maskKey(firecrawlKey.apiKey) : "not configured", firecrawlKey.source === "env" ? "env" : undefined);
    }
    if (id === "ratingProvider") {
      return row(id, "IMDb ratings source", RATING_PROVIDER_LABELS[config.discovery?.ratingProvider ?? "off"]);
    }
    if (id === "mdblist") {
      return row(id, "MDBList API key", mdblistKey.apiKey ? maskKey(mdblistKey.apiKey) : "not configured", mdblistKey.source === "env" ? "env" : undefined);
    }
    if (id === "discoveryTmdb") {
      return row(id, "TMDB discovery", isDiscoveryAdapterEnabled(config, "tmdb") ? "on" : "off");
    }
    if (id === "discoveryStreaming") {
      return row(id, "Streaming Availability discovery", isDiscoveryAdapterEnabled(config, "streaming-availability") ? "on" : "off");
    }
    if (id === "discoveryBluray") {
      return row(id, "Blu-ray RSS discovery", isDiscoveryAdapterEnabled(config, "bluray") ? "on" : "off");
    }
    if (id === "discoveryApify") {
      return row(id, "Apify discovery", isDiscoveryAdapterEnabled(config, "apify") ? "on" : "off");
    }
    if (id === "discoveryTamilmv") {
      return row(id, "TamilMV discovery", isDiscoveryAdapterEnabled(config, "tamilmv") ? "on" : "off");
    }
    if (id === "preferred") return row(id, "Preferred provider", providerLabel(preferred));
    if (id === "preferQuality") {
      return row(id, "Prefer quality", relevance.preferQuality === true ? "on" : "off");
    }
    if (id === "hideTrash") {
      return row(id, "Hide low-quality releases", relevance.hideTrash === true ? "on" : "off");
    }
    return row(id, "Strict text matching", relevance.strictAnd === true ? "on" : "off");
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={COLOR.accent} paddingX={2} paddingY={1}>
      <Box justifyContent="space-between">
        <Text color={COLOR.accent} bold>Settings</Text>
        <Text color={COLOR.dim}>
          config.json · {start + 1}-{Math.min(SETTING_IDS.length, start + capacity)}/{SETTING_IDS.length}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {visibleSettings.map(settingRow)}
      </Box>

      {editing ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={COLOR.accent}>
            {editing.id === "downloadDir"
              ? "Enter download folder"
              : `Paste ${editing.id === "tmdb"
                ? "TMDB read token"
                : editing.id === "streamingAvailability"
                  ? "Streaming Availability API key"
                  : editing.id === "apify"
                    ? "Apify API token"
                  : editing.id === "firecrawl"
                    ? "Firecrawl API key"
                  : editing.id === "mdblist"
                    ? "MDBList API key"
                  : `${PROVIDER_LABELS[editing.id]} key`}`} — enter to save, esc to cancel
          </Text>
          <Box borderStyle="round" borderColor={COLOR.accent} paddingX={1}>
            <Text color={COLOR.text}>{editingDisplay.slice(0, editing.cursor)}</Text>
            <Text color={COLOR.accent}>▊</Text>
            <Text color={COLOR.text}>{editingDisplay.slice(editing.cursor)}</Text>
          </Box>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Text color={COLOR.dim}>↑↓ select · e/enter edit · space toggle · ←→ choice · x clear</Text>
          <Text color={COLOR.dim}>Keys from environment variables cannot be edited here.</Text>
        </Box>
      )}
      {cols < 70 ? <Text color={COLOR.dim}>Esc returns to search.</Text> : null}
    </Box>
  );
}
