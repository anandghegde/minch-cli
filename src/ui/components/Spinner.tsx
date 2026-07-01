import { useEffect, useState } from "react";
import { Text } from "ink";
import { COLOR, ICON } from "../theme";

export function Spinner({ label }: { label?: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % ICON.spinner.length), 80);
    return () => clearInterval(t);
  }, []);
  return (
    <Text color={COLOR.accent}>
      {ICON.spinner[frame]}
      {label ? ` ${label}` : ""}
    </Text>
  );
}
