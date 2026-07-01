import { Box, Text, useInput } from "ink";
import { COLOR, ICON } from "../theme";

export function SearchBar({
  value,
  active,
  onChange,
  onSubmit,
  width,
}: {
  value: string;
  active: boolean;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  width: number;
}) {
  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit(value);
        return;
      }
      if (key.backspace || key.delete) {
        onChange(value.slice(0, -1));
        return;
      }
      if (key.ctrl || key.meta || key.escape || key.tab) return;
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      if (input) onChange(value + input);
    },
    { isActive: active },
  );

  const shown = value.length > width - 4 ? value.slice(value.length - (width - 4)) : value;
  return (
    <Box
      borderStyle="round"
      borderColor={active ? COLOR.accent : COLOR.dim}
      paddingX={1}
      width={width}
    >
      <Text color={active ? COLOR.accent : COLOR.dim}>{ICON.pointer} </Text>
      <Text color={COLOR.text}>{shown}</Text>
      {active ? <Text color={COLOR.accent}>{"\u2588"}</Text> : null}
      {!value && !active ? (
        <Text color={COLOR.dim}>search public sources…</Text>
      ) : null}
    </Box>
  );
}
