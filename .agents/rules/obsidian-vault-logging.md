---
trigger: always_on
---

# 🧠 Obsidian Second Brain Directives — Global

These rules apply across every project and workspace, not just one. The vault is shared infrastructure; this document defines how any project gets read from and written to it consistently.

## Mental Model — Three Axes

The vault stops being a journal and becomes a brain when notes split into three types that link to each other instead of one flat log:

- **DevLog** (time axis) — what happened, and when. One entry per session/feature/fix.
- **Component notes** (entity axis) — what a file/module *is* and what it relates to. Updated only when the thing itself changes, not every time it's touched.
- **Architecture notes** (system axis) — how components fit together. Updated rarely, only on real structural decisions.

DevLog entries link *into* component notes via `[[WikiLinks]]`. Component notes link to each other (depends-on / used-by) and up to architecture notes. Obsidian's native **"Linked mentions"** backlink panel does the rest automatically — never manually duplicate "what references this" inside a note.

---

## Role & Connection

You are integrated with my local Obsidian vault via an MCP bridge. The absolute path to this vault is `C:\Users\chuchi\Documents\Obsidian Vault`. This vault is the shared source of truth across all of my projects — architecture, components, and development history for each one. These directives apply in any workspace you're operating in, regardless of which project it is.

---

## Rule 0 — Project Identification (do this first, every session)

Because this rule is global, it fires in every workspace you open. Before touching the vault, determine which project you're in:

1. **Check for an existing match first.** Look in `Projects/` for a folder whose name matches the current workspace's repo name, the `package.json` / `pyproject.toml` / `Cargo.toml` `"name"` field, or the git remote name. If found, that folder name is the canonical **Project Name** — use it exactly as it already appears in the vault.
2. **If no match exists** (a brand-new project never logged before), derive a candidate name from the manifest name or workspace folder name, stripped of repo-role suffixes (`-client`, `-server`, `-api`, `-app`, `-mobile`, `-web`, etc.) and title-cased.
3. **Confirm once.** Ask the user to confirm or correct the candidate Project Name before creating any folder for it. This is the one deliberate exception to Rule 4's "don't ask permission" — getting this wrong means every note for that project lands in the wrong place. Once confirmed, never ask again; the existing vault folder is the answer from then on.
4. **Determine repo scope.** If the project has more than one repo (e.g. client + server, or web + mobile), create a subfolder per repo under `Components/<repo-name>/`. If it's a single-repo project, skip that layer entirely — component notes go directly under `Components/`.
5. **Check for first encounter.** If `Projects/<ProjectName>/` doesn't exist yet, or exists but doesn't follow this structure (no `Components/` folder, unstructured logs, missing prefixes), go to Rule 7 before doing anything else this session.

---

## Vault Structure

```
Projects/<ProjectName>/
├── Architecture/
│   └── <ProjectName> - <Topic>.md
├── Components/
│   ├── <repo-name>/                          (omit this layer for single-repo projects)
│   │   └── <ProjectName> - <ComponentName>.md
│   └── <other-repo-name>/
│       └── <ProjectName> - <ComponentName>.md
└── Logs/
    └── <YYYY-MM-DD> - <short-title>.md
```

---

## Rule 1 — Context Retrieval (Read First)

Before making **structural or architectural** decisions — new packages, routing changes, data-model changes, new components — search the vault first, scoped to the current project (per Rule 0):

1. Check `Projects/<ProjectName>/Architecture/` for relevant system-level decisions.
2. Check `Projects/<ProjectName>/Components/` (and the relevant repo subfolder, if one exists) for an existing note on the file(s) you're about to touch.
3. Never guess the architecture — read it from the brain.

This does **not** trigger for trivial edits (typos, styling tweaks, copy changes). Scope it to decisions that would actually be worth documenting.

**If no relevant note exists:** proceed using whatever's already been decided in this project's planning notes or prior conversation context, and explicitly flag the gap in your chat response rather than silently inventing architecture.

---

## Rule 2 — Component Notes

This is what makes the vault interconnected instead of a pile of phantom links.

**What qualifies for its own note:** controllers, services, models/schemas, major screens or reusable UI components, state stores, routing modules, and third-party integration wrappers. This applies regardless of what the project does.

**What does NOT get a note:** config files, one-off helpers, test files, style-only files. Don't create noise.

**Lazy creation:** The first time a qualifying file is mentioned in a DevLog entry or referenced in code, create a stub note for it if one doesn't exist yet. Flesh it out over time.

**Update policy:** Only update a component note's `Depends On` / `Used By` / `API Surface` sections when that relationship *actually changes*. Do **not** maintain a changelog inside the component note — that's what the DevLog + automatic backlinks are for.

### Template — `<ProjectName> - <ComponentName>.md`

```markdown
---
type: component
project: <ProjectName>
repo: <repo-name>              # omit this line entirely for single-repo projects
path: <relative/path/to/file>
status: stable
tags: [<project-tag>, component]
---

# <ProjectName> - <ComponentName>

## Purpose
What this thing does and why it exists.

## Depends On
- [[<ProjectName> - OtherComponent]]

## Used By
- [[<ProjectName> - AnotherComponent]]

## API Surface
- Relevant endpoints, props, or exported functions

## Notes
Anything non-obvious — link to an Architecture note if a decision explains it.
```

*(No "Recent Changes" section needed — open this note in Obsidian and check "Linked mentions" at the bottom to see every DevLog entry that touched it, automatically.)*

---

## Rule 3 — DevLog Entries (Write After)

A task isn't done until logged. After successfully implementing a feature, integrating an API, or fixing a bug — gated on an actual success signal (tests pass / build succeeds / user confirms), not just "I think this is finished" — create a **new file** in `Projects/<ProjectName>/Logs/`.

Each entry is its own file, not a section appended to a growing log. Frontmatter is file-level metadata — stacking multiple `---` blocks inside one file only lets the first one register with Obsidian/Dataview; everything after it becomes unqueryable plain text. One file per entry keeps every entry's frontmatter (and therefore the Dataview query in the Optional Enhancement section below) actually functional.

Name the file `<YYYY-MM-DD> - <short-title>.md`. Every file or component mentioned must be linked with `[[<ProjectName> - ComponentName]]`, and the note created/updated per Rule 2 if it's a qualifying component.

### Template — `Logs/<YYYY-MM-DD> - <short-title>.md`

```markdown
---
date: <YYYY-MM-DD>
type: devlog
project: <ProjectName>
repo: <repo-name>              # omit for single-repo projects
tags: [devlog, <project-tag>]
components: ["<ProjectName> - ComponentA", "<ProjectName> - ComponentB"]
---

# <Short title of what was done>

**Summary:** One or two sentences.

**Files changed:**
- <repo-name>: `path/to/file.js` → [[<ProjectName> - ComponentA]]

**Dependencies added:** `package@^version` (if any)
```

---

## Rule 4 — Autonomous Execution

DO NOT ask "Should I update the DevLog?" Execute the vault update automatically. The only exception is Rule 0's one-time project-name confirmation. The confirmation message must carry actual substance — not just "Brain updated."

End your response with one line like:

> Brain updated → DevLog: Added JWT refresh flow to [[<ProjectName> - AuthController]] (<repo-name>). +1 dependency. No other changes.

---

## Rule 5 — WikiLink Namespacing

The vault holds notes for multiple projects. Generic component names (`AuthController`, `Cache`, `Routes`) will collide across projects since Obsidian resolves `[[links]]` by filename, not folder — and this matters more now that the rule is global, since every project sharing this vault needs the same protection, not just one pair of projects.

**Every note title and filename must be prefixed with its Project Name:** `<ProjectName> - <Name>.md`, linked as `[[<ProjectName> - <Name>]]`. Apply this to Architecture, Component, and any cross-referenced notes, in every project.

---

## Rule 6 — Conflict Flagging

If a request conflicts with something already documented in the vault (an Architecture note or an existing Component note), do not silently override either side. Flag the conflict explicitly in your chat response and ask which should win before proceeding with structural changes.

---

## Rule 7 — Onboarding Existing Projects (Migration & Bootstrap)

Triggered by Rule 0, step 5. Two different starting states need two different responses. Neither should happen silently — both touch a large amount of existing material at once, so both get proposed to the user before anything is created or moved, same exception class as Rule 0's project-name confirmation.

### Case A — Existing notes, wrong structure
The project already has notes in the vault, but they predate this system: no `Components/` folder, an unstructured or single-file log, no project-name prefixing.

1. Inventory what's there — list existing notes and classify each as Architecture-like, Log-like, Component-like, or Uncategorized.
2. Propose a migration plan in chat before touching anything: what gets renamed (add the `<ProjectName> - ` prefix), what moves into which subfolder, and how any existing monolithic log gets split into individual dated entries per Rule 3.
3. Only after approval: perform the renames/moves, preserving original content. Best-effort infer missing frontmatter (date, components) from context; if something's ambiguous, leave it flagged rather than guessing.
4. Once `Architecture/`, `Components/`, and `Logs/` exist and are populated, the migration is done — don't re-propose it in future sessions for this project.

### Case B — Existing codebase, no notes at all
The workspace has real, already-built code, but `Projects/<ProjectName>/` doesn't exist in the vault yet.

1. Don't rely on lazy/incremental creation alone here — that leaves most of an already-built system undocumented indefinitely, since notes would only appear for files touched going forward.
2. Run a one-time bootstrap: scan the codebase, identify components that qualify under Rule 2's criteria, and propose stub notes for the foundational ones first — entry points, core services, main data models — not literally every qualifying file in one pass.
3. Propose one Architecture overview note capturing current high-level structure (stack, major systems) as a starting point.
4. This is a snapshot of current state, not reconstructed history. Don't backfill the Logs folder with past sessions or old bug fixes unless explicitly asked — that's a separate, much bigger task with its own judgment calls.
5. Show the proposed list of notes before creating them — for a codebase with real history behind it, this could be a dozen-plus files at once.

---

If the Dataview plugin is installed, a component note can embed a live query instead of relying solely on the backlinks panel:

```dataview
LIST
FROM [[<ProjectName> - ComponentName]]
WHERE type = "devlog"
SORT date DESC
```

Purely cosmetic — the native "Linked mentions" panel already gives the same information with zero setup.