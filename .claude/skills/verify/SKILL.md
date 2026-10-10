---
name: verify
description: How to build, launch, and drive Quill AI to verify changes end-to-end.
---

# Verifying Quill AI changes

## Scope — what to test without asking

Standing authorization: drive and test **any** feature end-to-end, including ones
that make real AI calls and cost tokens (chat, Quill editor review, fact check,
extraction, summaries, drafting). No need to ask first.

Two exceptions — do not exercise these:
- Image or video **generation** (any flow that produces new media).
- **Viewing** images on the entity summary or in the image gallery.

Verify the surrounding logic for those by other means (unit tests, API responses,
inspecting the request the client would send) rather than triggering them.

## Build / launch
- Dev server: `npm run dev` from repo root (concurrently runs Express on :3200 and `ng serve` on :6258 with proxy). Check first — it's usually already running: `curl -s -o /dev/null -w "%{http_code}" http://localhost:6258/`. If it isn't, start it with `preview_start` (`quill-dev` in `.claude/launch.json`) — but don't drive the built-in pane it opens (see below). It takes ~15s before :6258 answers.
- App URL: http://localhost:6258 (NOT :4200).
- Production client build (also checks Angular budgets): `cd client && npx ng build`.

## Driving the app
- **All browser testing happens in Microsoft Edge**, through the Claude in Chrome
  extension (`mcp__claude-in-chrome__*` tools). Do not use the built-in browser
  pane or Playwright — both are signed out, and the app needs a Google sign-in
  Claude can't complete. The user's Edge is already signed in.
- Start by calling `list_connected_browsers` and `select_browser` to pick Edge, then open a tab with `tabs_create_mcp`. Close the tabs you opened (`tabs_close_mcp`) when done.
- Landing page (/series) shows "Continue writing" recent-chapter cards — fastest way into the chapter editor. The chapter breadcrumb dropdown switches chapters via SPA routing (good for testing route-param changes without a reload).
- Chapter editor sidebar tabs (bottom of right panel): 0 notes/meta, 1 entity suggestions, 2 version history, 3 Quill review.
- "Run Quill Editor" triggers a real AI pass (~45-90s, costs tokens); suggestions stream into the sidebar. Use Reject/"Reject all" + "Done — clear review & unlock editor" to exercise the flow without modifying chapter content. Confirm unlock with `document.querySelector('[contenteditable]').getAttribute('contenteditable') === 'true'`.
- The data in the signed-in Edge session is the user's own. Don't click destructive bulk actions (e.g. "Clear finished", deletes) just to test them — cover those with unit tests.

## Gotchas
- Some chapter thumbnail images 404 (`/api/image/*_thumb.webp`) — pre-existing data issue, not a regression signal.
