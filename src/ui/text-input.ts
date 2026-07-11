/** The subset of Ink key state used by the shared one-line text editor. */
export interface TextInputKey {
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  tab?: boolean;
}

export interface TextEdit {
  value: string;
  cursor: number;
  handled: boolean;
}

/** Apply readline-style one-line editing without coupling to a specific view. */
export function editText(
  value: string,
  cursor: number,
  input: string,
  key: TextInputKey,
): TextEdit {
  const pos = Math.max(0, Math.min(cursor, value.length));
  if (key.leftArrow || (key.ctrl && input === "b")) {
    return { value, cursor: Math.max(0, pos - 1), handled: true };
  }
  if (key.rightArrow || (key.ctrl && input === "f")) {
    return { value, cursor: Math.min(value.length, pos + 1), handled: true };
  }
  if (key.ctrl && input === "a") return { value, cursor: 0, handled: true };
  if (key.ctrl && input === "e") return { value, cursor: value.length, handled: true };
  if (key.backspace) {
    return pos > 0
      ? { value: value.slice(0, pos - 1) + value.slice(pos), cursor: pos - 1, handled: true }
      : { value, cursor: pos, handled: true };
  }
  if (key.delete) {
    return pos < value.length
      ? { value: value.slice(0, pos) + value.slice(pos + 1), cursor: pos, handled: true }
      : { value, cursor: pos, handled: true };
  }
  if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
    return { value, cursor: pos, handled: true };
  }
  if (input) {
    return {
      value: value.slice(0, pos) + input + value.slice(pos),
      cursor: pos + input.length,
      handled: true,
    };
  }
  return { value, cursor: pos, handled: false };
}
