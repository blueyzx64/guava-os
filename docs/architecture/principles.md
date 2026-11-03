# Guava OS: engineering principles

> **Summary:** code is done when it works, we can show that it works, and it will keep working.
> Every change answers to the definition of good code below, to the interaction bar in §2, and
> to the process in §3. Agents and humans follow the same rules.

## 1. Definition of good code

1. **Correct.** It does what it says it does, without bugs.
2. **Demonstrable.** We know it works and can show others: a unit test, a harness probe, a
   measured number or a screenshot from the real Shell.
3. **The right problem.** It fixes the cause the user sees, not a symptom next to it.
4. **Fails well.** It handles errors on purpose, not only the happy path. A failure leaves the
   desktop usable, gives GNOME's behaviour back where it can, and logs one `[Guava]` line that
   says what failed, where, and with what input.
5. **Simple and minimal.** It does what is needed and nothing more.
6. **Protected by tests.** Tests show what works today and stop us quietly breaking it later.
7. **Documented at the right level.** The code map, the feature page and the comments describe
   the system as it is now. A change that makes a doc wrong fixes the doc in the same commit.
8. **Easy to change.** Clear seams (pure models, one adapter per Shell surface, `ctx` services)
   make the next change cheap. YAGNI: no hooks for features nobody asked for.
9. **Quality attributes.** Accessibility, testability, reliability, security, maintainability,
   observability, usability and performance are requirements, not extras.
10. **No knowing debt.** Do it right the first time, even when that takes longer. When a shortcut
    is unavoidable, it gets a `TODO(guava): why, and what replaces it` and an entry in the board.

## 2. The interaction bar (a desktop shell is felt, not read)

The Shell is the thing the user touches all day. Every feature must meet this bar:

- **Instant.** Input gets a visible response in the next frame. Nothing on the input path waits
  for disk, D-Bus or a subprocess. Work that can wait is deferred, batched or dropped.
- **Smooth.** Animations hold the display's refresh rate. No dropped frames, jumps, reversals
  or flicker; the harness measures this (`perf_start`/`track_actor`, `tools/harness/README.md`).
- **Interruptible.** Every animation has a clear start and end state, and the user can cut in at
  any moment: a new input retargets the motion from where it is now, never snaps back to the
  start or waits for the old animation to finish. `core/motion.js` is the only animation path.
- **Sharp.** Everything renders at the display's native resolution and scale. Never draw at a
  lower size and scale up, never cache a texture below the monitor's scale factor, and redraw
  on scale changes. Icons, text, shadows and glass stay crisp at 100%, 125%, 200% and beyond.
- **Graceful under load.** When the CPU or GPU is saturated, decorative work (blur, live
  previews, magnification) degrades first; window management, input, the dock and the menu bar
  keep working. Startup never blocks the first frame of the session.
- **Respectful.** Animations off and reduced motion are honoured everywhere (`core/motionModel.js`).

## 3. How we work

11. **Prototype to learn, then build.** Test a risky hypothesis in a throwaway spike (a harness
    scenario, a 30-line `P '<js>'` probe in the real Shell) before reshaping production code.
    Spikes are never merged as they are.
12. **Compounding loop.** Every finished, user-approved change leaves a note in
    `docs/agents/learnings.md`: what worked, what failed, what to do differently. Read it first.
13. **Shared memory, single writer.** The orchestrator owns the shared memory; each agent owns
    its own file; everyone can read everything (`docs/agents/workflow.md` §3).
14. **A test environment that matches the real one.** Fedora 44 packages, GNOME Shell 50.6, real
    apps, in chroot roots (`tools/harness/`). A change is not done until it passes there.
15. **Parallel work without collisions.** One git worktree per agent and the ownership log
    (`tools/agents/claim.sh`) so nobody edits a file another agent holds.
