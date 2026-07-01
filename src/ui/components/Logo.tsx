import { Box, Text } from "ink";
import { COLOR } from "../theme";
import { VERSION } from "../../version";

export function Logo() {
  return (
    <Box>
      <Text color={COLOR.accent} bold>
        minch
      </Text>
      <Text color={COLOR.dim}> v{VERSION} </Text>
      <Text color={COLOR.alt}>· public torrent finder</Text>
    </Box>
  );
}
