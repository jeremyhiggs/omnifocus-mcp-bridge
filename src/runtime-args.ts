export type RuntimeArgs = {
  verbose: boolean;
};

export function parseRuntimeArgs(args: string[]): RuntimeArgs {
  let verbose = false;

  for (const arg of args) {
    switch (arg) {
      case "--verbose":
      case "-v":
        verbose = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}. Usage: pnpm start [-- --verbose]`);
    }
  }

  return {
    verbose,
  };
}
