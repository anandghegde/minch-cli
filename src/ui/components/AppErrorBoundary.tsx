import { Component, type ErrorInfo, type ReactNode } from "react";
import { Box, Text } from "ink";
import { getLogFilePath, logError } from "../../util/logger";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

/** Keep render failures inside the TUI long enough to record React's component stack. */
export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logError("ui.render.error", error, { componentStack: info.componentStack });
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color="red">minch encountered a rendering error.</Text>
          <Text>{this.state.error.message}</Text>
          <Text>Diagnostics: {getLogFilePath()}</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
