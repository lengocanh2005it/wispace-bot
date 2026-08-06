export function printHelp(text) {
  console.log(text);
}

export function parseArgs(argv, spec) {
  const args = { ...spec.defaults };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      printHelp(spec.help);
      process.exit(0);
    } else if (!spec.handle(args, arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}
