export const CLI_NAME = "cambridge-reader-scraper";

type CompletionShell = "bash" | "zsh" | "fish" | "powershell" | "xonsh";

type CommandDefinition = {
  name: string;
  description: string;
};

type OptionDefinition = {
  name: string;
  description: string;
  expectsValue: boolean;
};

const COMMANDS: CommandDefinition[] = [
  { name: "reconstruct", description: "rebuild selected books into PDFs" },
  { name: "pdf", description: "alias for reconstruct" },
  { name: "inspect", description: "list detected Cambridge Reader book blobs" },
  { name: "completion", description: "print a shell completion script" },
  { name: "help", description: "show CLI help" },
];

const OPTIONS: OptionDefinition[] = [
  {
    name: "--userdata",
    description: "path to the Cambridge Reader userdata root",
    expectsValue: true,
  },
  {
    name: "--app-name",
    description: "override the app name used for default userdata discovery",
    expectsValue: true,
  },
  { name: "--isbn", description: "limit work to one or more ISBN values", expectsValue: true },
  { name: "--outdir", description: "output directory for generated PDFs", expectsValue: true },
  { name: "--workdir", description: "temporary extraction directory", expectsValue: true },
  {
    name: "--browser",
    description: "path to a Playwright Chromium executable",
    expectsValue: true,
  },
  {
    name: "--page-timeout-ms",
    description: "page navigation timeout in milliseconds",
    expectsValue: true,
  },
  {
    name: "--max-pages",
    description: "render only the first N pages of each book",
    expectsValue: true,
  },
  {
    name: "--concurrency",
    description: "number of books to process in parallel",
    expectsValue: true,
  },
  {
    name: "--keep-extracted",
    description: "keep extracted book files after rendering",
    expectsValue: false,
  },
  {
    name: "--no-tui",
    description: "disable the interactive selection and progress UI",
    expectsValue: false,
  },
  { name: "--help", description: "show CLI help", expectsValue: false },
];

const COMPLETION_SHELLS: CompletionShell[] = ["bash", "zsh", "fish", "powershell", "xonsh"];

export function isCompletionShell(value: string): value is CompletionShell {
  return COMPLETION_SHELLS.includes(value as CompletionShell);
}

function formatOptionsForHelp(): string {
  return OPTIONS.map(
    (option) =>
      `  ${option.name}${option.expectsValue ? " <value>" : ""}\n      ${option.description}`,
  ).join("\n");
}

function formatCommandsForHelp(): string {
  return COMMANDS.map((command) => `  ${command.name}\n      ${command.description}`).join("\n");
}

export function renderHelp(): string {
  return [
    `${CLI_NAME} rebuilds Cambridge Reader books into PDFs.`,
    "",
    "Usage:",
    `  ${CLI_NAME} [command] [options]`,
    "",
    "Commands:",
    formatCommandsForHelp(),
    "",
    "Options:",
    formatOptionsForHelp(),
    "",
    "Examples:",
    `  ${CLI_NAME}`,
    `  ${CLI_NAME} inspect --userdata ./userdata`,
    `  ${CLI_NAME} reconstruct --isbn 9781000000000 --outdir ./pdfs`,
    `  ${CLI_NAME} completion fish`,
  ].join("\n");
}

function shellWords(values: string[]): string {
  return values.join(" ");
}

function optionNames(): string[] {
  return OPTIONS.map((option) => option.name);
}

function renderBashCompletion(): string {
  const commands = shellWords(COMMANDS.map((command) => command.name));
  const options = shellWords(optionNames());
  const shells = shellWords(COMPLETION_SHELLS);

  return `_${CLI_NAME.replace(/-/g, "_")}() {
  local cur prev command
  cur="${"$"}{COMP_WORDS[COMP_CWORD]}"
  prev="${"$"}{COMP_WORDS[COMP_CWORD-1]}"
  command="${"$"}{COMP_WORDS[1]}"

  if [[ ${"$"}{COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${commands} ${options}" -- "${"$"}{cur}") )
    return 0
  fi

  if [[ "${"$"}{command}" == "completion" && ${"$"}{COMP_CWORD} -eq 2 ]]; then
    COMPREPLY=( $(compgen -W "${shells}" -- "${"$"}{cur}") )
    return 0
  fi

  COMPREPLY=( $(compgen -W "${options}" -- "${"$"}{cur}") )
}

complete -F _${CLI_NAME.replace(/-/g, "_")} ${CLI_NAME}
`;
}

function renderZshCompletion(): string {
  const commandEntries = COMMANDS.map(
    (command) => `${command.name}:${command.description.replace(/:/g, "\\:")}`,
  )
    .map((entry) => `'${entry}'`)
    .join(" ");
  const optionEntries = OPTIONS.map(
    (option) =>
      `${option.name}[${option.description.replace(/]/g, "\\]")}]${option.expectsValue ? ":value:_files" : ""}`,
  )
    .map((entry) => `'${entry}'`)
    .join(" ");
  const shellEntries = COMPLETION_SHELLS.map((shell) => `'${shell}'`).join(" ");

  return `#compdef ${CLI_NAME}

local -a commands options shells
commands=(${commandEntries})
options=(${optionEntries})
shells=(${shellEntries})

if (( CURRENT == 2 )); then
  _describe 'command' commands
  _describe 'option' options
  return 0
fi

if [[ ${"$"}{words[2]} == completion ]]; then
  _values 'shell' ${COMPLETION_SHELLS.join(" ")}
  return 0
fi

_arguments -s ${OPTIONS.map((option) => `'${option.name}[${option.description.replace(/]/g, "\\]")}]${option.expectsValue ? ":value:_files" : ""}'`).join(" ")}
`;
}

function renderFishCompletion(): string {
  const commandLines = COMMANDS.map(
    (command) =>
      `complete -c ${CLI_NAME} -n "not __fish_seen_subcommand_from ${COMMANDS.map((item) => item.name).join(" ")}" -a "${command.name}" -d "${command.description}"`,
  );
  const optionLines = OPTIONS.map(
    (option) =>
      `complete -c ${CLI_NAME} -l ${option.name.slice(2)}${option.expectsValue ? " -r" : ""} -d "${option.description}"`,
  );
  const shellLines = COMPLETION_SHELLS.map(
    (shell) =>
      `complete -c ${CLI_NAME} -n "__fish_seen_subcommand_from completion" -a "${shell}" -d "${shell} completion script"`,
  );

  return (
    [`complete -c ${CLI_NAME} -f`, ...commandLines, ...optionLines, ...shellLines].join("\n") + "\n"
  );
}

function renderPowerShellCompletion(): string {
  const commands = COMMANDS.map((command) => `'${command.name}'`).join(", ");
  const options = optionNames()
    .map((option) => `'${option}'`)
    .join(", ");
  const shells = COMPLETION_SHELLS.map((shell) => `'${shell}'`).join(", ");

  return `Register-ArgumentCompleter -Native -CommandName '${CLI_NAME}' -ScriptBlock {
  param(${"$"}wordToComplete, ${"$"}commandAst, ${"$"}cursorPosition)

  ${"$"}commands = @(${commands})
  ${"$"}options = @(${options})
  ${"$"}shells = @(${shells})
  ${"$"}tokens = ${"$"}commandAst.CommandElements | ForEach-Object Value

  if (${"$"}tokens.Count -le 2) {
    ${"$"}items = ${"$"}commands + ${"$"}options
  } elseif (${"$"}tokens[1] -eq 'completion') {
    ${"$"}items = ${"$"}shells
  } else {
    ${"$"}items = ${"$"}options
  }

  ${"$"}items |
    Where-Object { ${"$"}_ -like "${"$"}wordToComplete*" } |
    ForEach-Object {
      [System.Management.Automation.CompletionResult]::new(${"$"}_, ${"$"}_, 'ParameterValue', ${"$"}_)
    }
}
`;
}

function renderXonshCompletion(): string {
  const commands = JSON.stringify(COMMANDS.map((command) => command.name));
  const options = JSON.stringify(optionNames());
  const shells = JSON.stringify(COMPLETION_SHELLS);

  return `def _complete_${CLI_NAME.replace(/-/g, "_")}(prefix, line, begidx, endidx, ctx=None):
    commands = ${commands}
    options = ${options}
    shells = ${shells}
    tokens = line[:endidx].split()

    if len(tokens) <= 1:
        return {item for item in commands + options if item.startswith(prefix)}

    if len(tokens) == 2 and tokens[1] == 'completion':
        return {item for item in shells if item.startswith(prefix)}

    return {item for item in options if item.startswith(prefix)}


completer add ${CLI_NAME.replace(/-/g, "_")} _complete_${CLI_NAME.replace(/-/g, "_")} end
`;
}

export function renderCompletion(shell: CompletionShell): string {
  switch (shell) {
    case "bash":
      return renderBashCompletion();
    case "zsh":
      return renderZshCompletion();
    case "fish":
      return renderFishCompletion();
    case "powershell":
      return renderPowerShellCompletion();
    case "xonsh":
      return renderXonshCompletion();
    default:
      return shell;
  }
}
