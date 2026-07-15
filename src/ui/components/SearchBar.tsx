import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useStdin } from "ink";
import { COLOR, ICON } from "../theme";
import { editText } from "../text-input";

export function SearchBar({
  value,
  active,
  onChange,
  onSubmit,
  onCancel,
  width,
}: {
  value: string;
  active: boolean;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onCancel: () => void;
  width: number;
}) {
  const [cursor, setCursor] = useState(value.length);
  const cursorRef = useRef(value.length);
  const latestRawInputRef = useRef("");
  const { internal_eventEmitter: inputEmitter } = useStdin();

  // Ink 5 classifies the DEL byte sent by most Backspace keys as `key.delete`.
  // Capture the raw sequence before useInput handles it so a physical Backspace
  // remains distinct from the forward-delete escape sequence (ESC [ 3 ~).
  useEffect(() => {
    if (!active) return;

    const captureRawInput = (data: Buffer | string) => {
      latestRawInputRef.current = data.toString();
    };
    inputEmitter.on("input", captureRawInput);
    return () => {
      inputEmitter.off("input", captureRawInput);
    };
  }, [active, inputEmitter]);

  // Keep the caret inside the string if the parent shortens `value`.
  useEffect(() => {
    cursorRef.current = Math.min(cursorRef.current, value.length);
    setCursor(cursorRef.current);
  }, [value]);

  // On focus, put the caret at the end so typing continues the query.
  useEffect(() => {
    if (active) {
      cursorRef.current = value.length;
      setCursor(value.length);
    }
    // Only re-run when edit mode turns on — not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit(value);
        return;
      }
      if (key.escape) {
        onCancel();
        return;
      }

      const editKey =
        key.delete && latestRawInputRef.current === "\x7f"
          ? { ...key, backspace: true, delete: false }
          : key;
      const edit = editText(value, cursorRef.current, input, editKey);
      if (!edit.handled) return;
      if (edit.value !== value) onChange(edit.value);
      cursorRef.current = edit.cursor;
      setCursor(edit.cursor);
    },
    { isActive: active },
  );

  // Room for "▸ " prefix and the block caret.
  const maxShown = Math.max(1, width - 5);
  const pos = Math.min(cursor, value.length);

  // Horizontal scroll so the caret stays visible when the query is long.
  let start = 0;
  if (value.length > maxShown) {
    if (pos - start >= maxShown) start = pos - maxShown + 1;
    start = Math.max(0, Math.min(start, Math.max(0, value.length - maxShown)));
  }
  const end = start + maxShown;
  const before = value.slice(start, pos);
  const after = value.slice(pos, end);
  const inactiveShown =
    value.length > maxShown ? value.slice(value.length - maxShown) : value;

  return (
    <Box
      borderStyle="round"
      borderColor={active ? COLOR.accent : COLOR.dim}
      paddingX={1}
      width={width}
    >
      <Text color={active ? COLOR.accent : COLOR.dim}>{ICON.pointer} </Text>
      {!value && !active ? (
        <Text color={COLOR.dim}>search public sources…</Text>
      ) : active ? (
        <>
          <Text color={COLOR.text}>{before}</Text>
          <Text color={COLOR.accent}>{"\u2588"}</Text>
          <Text color={COLOR.text}>{after}</Text>
        </>
      ) : (
        <Text color={COLOR.text}>{inactiveShown}</Text>
      )}
    </Box>
  );
}
