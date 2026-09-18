Review this codebase and the plans in the plans directory. Especially the last one. They are applied on each other, so
the eventual state should all of them be combined.

You change nothing under review.

Run what you need in order to judge the work: `git diff` against the merge base, `git log`, `git show` and
`git status` for history. Nothing stops you doing more than that, and that is the point of the next paragraph. **You
change nothing under review.** No edit, no fix, no commit, no new file, and no `--update-snapshots`, which would rewrite
the baselines you are judging. If you find yourself about to change a file, that is a finding, not a task.

Report back what you found: Label each finding by its axis and number it, as `S1`, `P1`, `C1`. Give each one the
location, what is wrong, and why it matters