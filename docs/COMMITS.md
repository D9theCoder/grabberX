# Commit rules

## Format

```
<tag>: <short title>

- What changed, one point per line.
- Why it changed, if it is not obvious.
```

## Title

- Starts with a tag, then a colon and a space: `feat: add a download link`.
- Imperative mood and lowercase after the tag ("add", "fix", not "added", "fixes").
- 72 characters or fewer, no trailing period.

## Tags

| Tag | Use for |
| --- | --- |
| `feat` | A new feature the user can see or use |
| `fix` | A bug fix |
| `docs` | Documentation only |
| `test` | Adding or changing tests only |
| `refactor` | A code change that does not change behavior |
| `style` | Formatting or UI styling with no logic change |
| `perf` | A change that makes something faster |
| `build` | Build, packaging or dependency changes |
| `ci` | GitHub Actions and other pipeline changes |
| `chore` | Anything else that is not user-facing (including `chore: release X.Y.Z`) |

## Description

- Written as bullet points, one idea per bullet, each starting with `- `.
- Say what changed and why. Leave out how the code works; the diff shows that.
- Leave it out only when the title says everything (a typo fix, for example).
- Separate the title and the description with one blank line.

## Rules

- One logical change per commit.
- Do not put AI tool names, model names or `Co-Authored-By` lines in commits.
- Every push to `main` publishes a release (see `PACKAGING.md`). Batch local commits and push once to get one release.
- `git pull --rebase` before you push, because CI adds its own `chore: release X.Y.Z` commit after each release.
- Do not rewrite pushed history. Releases and tags point at those commits.

## Example

```
fix: let the Library editor rename a folder by case only

- Compare the folder names exactly instead of ignoring case.
- Add a test for renaming "Name" to "name".
```
