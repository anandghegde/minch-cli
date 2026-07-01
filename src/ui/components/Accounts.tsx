import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store";
import { resolveKey, maskKey } from "../../debrid/keys";
import { truncate } from "../../util/format";
import { COLOR, ICON } from "../theme";

/**
 * Key-management overlay. Lets the user paste/clear a provider key and run
 * `checkAuth`. Keys are always shown masked (last 4 chars), env-provided keys
 * are read-only here (env precedence), and nothing is ever printed in full.
 */
export function Accounts({ active }: { active: boolean }) {
  const store = useStore();
  const { debridProviders, config, debridAuth, cols } = store;

  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const idx = Math.min(cursor, Math.max(0, debridProviders.length - 1));
  const provider = debridProviders[idx];

  useInput(
    (input, key) => {
      if (editing) {
        if (key.return) {
          if (provider) store.saveDebridKey(provider.id, draft.trim() || undefined);
          setDraft("");
          setEditing(false);
          return;
        }
        if (key.escape) {
          setDraft("");
          setEditing(false);
          return;
        }
        if (key.backspace || key.delete) {
          setDraft((d) => d.slice(0, -1));
          return;
        }
        if (key.ctrl || key.meta || key.tab) return;
        if (input) setDraft((d) => d + input);
        return;
      }

      if (key.escape || input === "a") {
        store.closeAccounts();
      } else if (key.downArrow || input === "j") {
        setCursor((c) => Math.min(debridProviders.length - 1, c + 1));
      } else if (key.upArrow || input === "k") {
        setCursor((c) => Math.max(0, c - 1));
      } else if (input === "e" || key.return) {
        if (!provider) return;
        if (resolveKey(provider.id, config).source === "env") {
          store.setNotice(`${provider.label} key comes from an env var; unset it to edit here.`);
          return;
        }
        setDraft("");
        setEditing(true);
      } else if (input === "c") {
        if (provider) store.checkDebridAuth(provider.id);
      } else if (input === "x") {
        if (provider && resolveKey(provider.id, config).source !== "env") {
          store.saveDebridKey(provider.id, undefined);
        }
      }
    },
    { isActive: active },
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={COLOR.accent}
      paddingX={2}
      paddingY={1}
    >
      <Text color={COLOR.accent} bold>
        Accounts
      </Text>

      <Box marginTop={1} flexDirection="column">
        {debridProviders.map((p, i) => {
          const sel = i === idx;
          const rk = resolveKey(p.id, config);
          const auth = debridAuth[p.id];
          const configured = p.isConfigured();
          return (
            <Box key={p.id} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
              <Box>
                <Text color={sel ? COLOR.accent : COLOR.dim}>
                  {sel ? ICON.pointer : " "}{" "}
                </Text>
                <Box width={14}>
                  <Text color={sel ? COLOR.text : COLOR.alt}>{p.label}</Text>
                </Box>
                {configured && rk.key ? (
                  <Text color={COLOR.good}>
                    {ICON.done} {maskKey(rk.key)}{" "}
                    <Text color={COLOR.dim}>({rk.source})</Text>
                  </Text>
                ) : (
                  <Text color={COLOR.warn}>{ICON.warn} no key</Text>
                )}
              </Box>
              <Box marginLeft={3}>
                {auth?.checking ? (
                  <Text color={COLOR.dim}>verifying…</Text>
                ) : auth?.error ? (
                  <Text color={COLOR.bad}>{truncate(auth.error, cols - 12)}</Text>
                ) : auth?.info ? (
                  <Text color={COLOR.good}>
                    {[
                      auth.info.plan ? `plan: ${auth.info.plan}` : undefined,
                      auth.info.email,
                      auth.info.premium ? "premium" : undefined,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "verified"}
                  </Text>
                ) : (
                  <Text color={COLOR.dim}>
                    {configured ? "press c to verify" : "press e to add a key"}
                  </Text>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>

      {editing && provider ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={COLOR.accent}>
            Paste {provider.label} key — enter to save, esc to cancel
          </Text>
          <Box borderStyle="round" borderColor={COLOR.accent} paddingX={1}>
            <Text color={COLOR.text}>{draft ? maskKey(draft) : ""}</Text>
            <Text color={COLOR.accent}>{"\u2588"}</Text>
          </Box>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={COLOR.dim}>
            {"\u2191\u2193"} select · e edit key · c verify · x clear · esc close
          </Text>
        </Box>
      )}
    </Box>
  );
}
