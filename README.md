# output-filter

A Claude Code mod: a bar above the prompt that filters the transcript, a coloured category label before each assistant output, highlights that persist (`/hl`), and flags listed in a Flags pane (`/flag`, `/flags`).

## Install

This repository is private: you need read access on GitHub and a git credential for github.com on your machine (an SSH key, or `gh auth login` then `gh auth setup-git`).

At the prompt of a Claude Code terminal session:

```
/plugin install output-filter --marketplace rsahtakr/claude-output-filter-mod
```

Answer `y` to add the marketplace, then press Enter to pick the user scope.

From a shell:

```
claude plugin install output-filter --marketplace rsahtakr/claude-output-filter-mod
```
