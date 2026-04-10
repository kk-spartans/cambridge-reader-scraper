Register-ArgumentCompleter -Native -CommandName 'cambridge-reader-scraper' -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)

  $commands = @('reconstruct', 'pdf', 'inspect', 'completion', 'help')
  $options = @('--userdata', '--app-name', '--isbn', '--outdir', '--workdir', '--browser', '--page-timeout-ms', '--max-pages', '--concurrency', '--keep-extracted', '--no-tui', '--help')
  $shells = @('bash', 'zsh', 'fish', 'powershell', 'xonsh')
  $tokens = $commandAst.CommandElements | ForEach-Object Value

  if ($tokens.Count -le 2) {
    $items = $commands + $options
  } elseif ($tokens[1] -eq 'completion') {
    $items = $shells
  } else {
    $items = $options
  }

  $items |
    Where-Object { $_ -like "$wordToComplete*" } |
    ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
}
