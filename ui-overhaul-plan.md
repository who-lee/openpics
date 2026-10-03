# OpenPics UI Overhaul Plan (Approved)

## Goals
- Additive, incremental refactor preserving existing UX, constraints, and identity.
- Implement: resizable right AI dock (expanded by default), floating selection bar, smarter filters, smart collections, EXIF expansion, breadcrumbs+Up, bundled local AI (llama.cpp) with user-editable prompt.

## Constraints to preserve
- Local-only processing, Recycle Bin behavior, hover metadata, context actions, Settings, credits, src/HOW-TO-USE.txt
- No video editor UI / no "Trim video" context-menu
- External links via `bridge.shell.openUrl`
- Canonical filters: none, punch, mono, sepia, warm, cool, faded, noir, vintage, cinematic
- Identity rewrite commits 7366bc7, e372c23 stay untouched; backup tags/branches unchanged
- Identity `who-lee <leekingori54@gmail.com>`, beta.5 at 1edbcd2

## Phase 0: Foundation & types
1. **shared/types.ts** - extend Settings:
   - `aiEnabled?: boolean` (default true or persisted; dock expanded by default means visible)
   - `aiDockWidth: number` (default ~360px, resizable)
   - `aiDockExpanded: boolean` (default true)
   - `aiModelPath?: string` (path to bundled GGUF)
   - `aiPromptPath?: string` (path to user-editable prompt file)
   - `aiCollections?: SmartCollection[]` (stored)
   - Add `SmartCollection` type (id, name, rules array: {field, op, value})
   - Add filter state types: `typeFilter`, `dateRange`, `sizeRange`, `camera`, `tags` (or store in library state)

2. **shared/settings-schema.ts** - validation for new numeric/fields (clamp aiDockWidth e.g. 240-720)

3. **electron/settings.ts** - defaults for new settings

4. **shared/protocol.ts** - add AI-related types if needed (messages, state)

## Phase 1: Library store (Zustand)
`src/store/library.ts` additions:
- `aiDockExpanded: boolean`, `aiDockWidth: number`, `setAiDockExpanded`, `setAiDockWidth`, `resizeAiDock`
- Selection bar state: compute `hasSelection` from `selected.size`
- Filters: `typeFilter: 'all'|'image'|'video'`, `dateRange?: {start,end}`, `sizeRange?: {min,max}`, `cameraFilter?: string`, `tagFilter?: string[]`, `activeCollectionId?: string`
- Smart collections: `collections: SmartCollection[]`, `addCollection`, `updateCollection`, `deleteCollection`, `setActiveCollection`
- EXIF cache: `exifCache` map (path->EXIF) - read on demand via bridge or lazy load
- AI state: `aiOpen`, `aiMessages`, `aiThinking`, `aiModelReady`, `aiModels`, `setAiOpen`, `sendAiMessage`, `toggleAi` (sync with expanded)
- Recompute `visible` to include all filters + collection + tags (incremental: keep existing name filter, add AND logic)

Also selection helpers: `selectAll()`, `invertSelection()` using `visible` or full `photos`.

## Phase 2: AI infrastructure (local, bundled)
- **electron/ai/** or **src/lib/ai/** + main process bridge: llama.cpp integration. Since bundled in installer, include model path resolution (extraResources or app.getAppPath/resources). 
- Model file: ship our ~500MB GGUF in `vendor/models/` or `build/models/` included via `extraResources` in electron-builder (add models to extraResources). 
- Prompt file: user-editable, default created in userData (`app.getPath('userData')/openpics-ai-prompt.txt`) on first run; Settings/AI shows path + Edit/Open.
- Bridge IPC: `ai:status`, `ai:init`, `ai:send`, `ai:stop`, `ai:tagBatch`, `ai:embed` (for semantic/similar). 
- Auto-tagging: background worker, throttled when idle (not scanning), can pause. Store tags on Photo? Extend Photo in shared/types or separate `photoTags` map in store (local-only, persisted? maybe in settings or side DB not needed; tags small).
- Chat sidebar state wired to dock.

## Phase 3: UI components (additive)
1. **SelectionBar.tsx** (new) - floating bar above grid when selected.size>=1: count, Select All, Invert, actions: Copy paths, Open, Set wallpaper, Rotate (if image), Recycle Bin. Use existing IconButton/Button, darkroom tokens.
2. **AiDock.tsx** (new) - right resizable panel: header (toggle, model status), tabs or sections (Chat, Tags, Similar). Chat input, thinking, messages. Resizer handle (vertical) on left edge. Expanded by default, persisted width/expanded.
3. **Breadcrumbs.tsx** (new) - path display + Up button (parentDir). Replace/augment folder UI in Toolbar or area above grid? Keep Toolbar clean; add above grid or in toolbar area? Breadcrumbs above grid (between Toolbar and Grid) or inline in toolbar. Minimal: add to Toolbar left area after Change folder? Or new bar strip.
4. **SmartCollectionsDropdown.tsx** (new) in Toolbar: dropdown to pick All/Smart collections + manage (create/edit rules).
5. **FilterBar.tsx** (new) - below Toolbar, compact row: Type, Date, Size, Camera, Tags chips + clear all. Filename stays in Toolbar.
6. **InfoPanel.tsx** - extend: add expandable EXIF section (Details + expandable EXIF). Lazy read EXIF on expand or on open info.
7. **Grid.tsx** - integrate SelectionBar overlay (absolute top of grid area). No other structural change.
8. **App.tsx** - layout: add Resizable split: main area (Toolbar+Breadcrumbs?+FilterBar+Grid+StatusBar+Terminal) + AiDock right (resizable). Use CSS flex + drag handle updating aiDockWidth in store.

## Phase 4: Wiring & shortcuts
- Ctrl+A = selectAll (visible/all? visible when filtered), Ctrl+Shift+A or invert? add Invert. 
- AI toggle: maybe Ctrl+Shift+A? or new shortcut (e.g. Ctrl+I? I is Info now; avoid conflict) — add to ShortcutsOverlay.
- Selection bar actions call existing bridge ops (shell.open, reveal, recycle bin, wallpaper) where applicable.

## Phase 5: Packaging (bundled model)
electron-builder: add `extraResources` for models and default prompt template.
- `build/models/openpics-llama-*.gguf` or `vendor/models/*` -> `resources/models/`
- `build/ai-prompt-default.txt` -> copied to userData on first run if missing (user-editable)

Model init checks presence, reports size/RAM in AI dock.

## Phase 6: Tests & verification
- Keep existing 210/77/107/57/178 passing. Add minimal unit tests if new pure helpers (filters, collections). No existing tests broken.
- Typecheck + build + package Windows. Verify installer includes models? bundled. Verify app.asar unchanged in core logic.

## Phase 7: Implementation order (safe)
1. Types/settings (non-breaking)
2. Store extensions (additive)
3. SelectionBar + selectAll/invert (low risk)
4. Breadcrumbs + Up (small)
5. FilterBar + smarter filters (recompute visible)
6. Smart collections + dropdown
7. EXIF expand in InfoPanel
8. AI dock UI + layout split (resizable)
9. AI backend bridge + model load (bundled)
10. Wiring, shortcuts, polish

## Notes
- Breadcrumbs+Up uses parentDir (exists conceptually) from store logic.
- Hover metadata preserved (Thumb onHover unchanged).
- No video trim, canonical filters untouched.
- All external links use bridge.shell.openUrl (already used).

Approved to proceed incrementally. Start Phase 0.