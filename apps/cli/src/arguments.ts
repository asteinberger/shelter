export interface ParsedOptions {
  positionals: string[];
  values: Readonly<Record<string, string>>;
  flags: ReadonlySet<string>;
}

export interface GlobalArguments {
  args: string[];
  json: boolean;
  help: boolean;
  version: boolean;
}

export function parseGlobalArguments(argv: readonly string[]): GlobalArguments {
  let json = false;
  let help = false;
  let version = false;
  const args: string[] = [];
  for (const argument of argv) {
    if (argument === "--json") json = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--version" || argument === "-v") version = true;
    else args.push(argument);
  }
  return { args, json, help, version };
}

export function parseOptions(
  argv: readonly string[],
  valueOptions: readonly string[] = [],
  flagOptions: readonly string[] = []
): ParsedOptions {
  const allowedValues = new Set(valueOptions);
  const allowedFlags = new Set(flagOptions);
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const positionals: string[] = [];
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && argument.startsWith("--")) {
      const equals = argument.indexOf("=");
      const name = argument.slice(2, equals === -1 ? undefined : equals);
      if (allowedFlags.has(name)) {
        if (equals !== -1) throw new Error(`Option --${name} does not take a value.`);
        if (flags.has(name)) throw new Error(`Option --${name} may only be specified once.`);
        flags.add(name);
        continue;
      }
      if (!allowedValues.has(name)) throw new Error(`Unknown option: --${name}`);
      if (Object.hasOwn(values, name)) throw new Error(`Option --${name} may only be specified once.`);
      const value = equals === -1 ? argv[index + 1] : argument.slice(equals + 1);
      if (value === undefined || (!positionalOnly && value.startsWith("--"))) {
        throw new Error(`Option --${name} requires a value.`);
      }
      if (equals === -1) index += 1;
      if (!value) throw new Error(`Option --${name} requires a non-empty value.`);
      values[name] = value;
      continue;
    }
    if (!positionalOnly && argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    positionals.push(argument);
  }

  return { positionals, values, flags };
}

export function requiredOption(options: ParsedOptions, name: string): string {
  const value = options.values[name];
  if (!value) throw new Error(`Missing required option --${name}.`);
  return value;
}

export function requirePositionals(
  options: ParsedOptions,
  minimum: number,
  maximum = minimum
): string[] {
  if (options.positionals.length < minimum || options.positionals.length > maximum) {
    const expected = minimum === maximum ? String(minimum) : `${minimum}-${maximum}`;
    throw new Error(`Expected ${expected} positional argument${maximum === 1 ? "" : "s"}.`);
  }
  return options.positionals;
}
