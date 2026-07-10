---
name: verify
description: How to build, launch, and drive Quill AI to verify changes end-to-end.
---

# Verifying Quill AI changes

## Build / launch
- Dev server: `npm run dev` from repo root (concurrently runs Express on :3200 and `ng serve` on :6258 with proxy). Check first — it's usually already running: `curl -s -o /dev/null -w "%{http_code}" http://localhost:6258/`.
- App URL: http://localhost:6258 (NOT :4200).
- Production client build (also checks Angular budgets): `cd client && npx ng build`.

## Driving the app
- Playwright MCP browser tools work; the persistent profile (`~/.playwright-profile` / mcp-chrome) is already authenticated — no login flow needed.
- If navigate fails with "Browser is already in use", kill stale instances (PowerShell):
  `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*mcp-chrome*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
- Landing page (/series) shows "Continue writing" recent-chapter cards — fastest way into the chapter editor. The chapter breadcrumb dropdown switches chapters via SPA routing (good for testing route-param changes without a reload).
- Chapter editor sidebar tabs (bottom of right panel): 0 notes/meta, 1 entity suggestions, 2 version history, 3 Quill review.
- "Run Quill Editor" triggers a real AI pass (~45-90s, costs tokens); suggestions stream into the sidebar. Use Reject/"Reject all" + "Done — clear review & unlock editor" to exercise the flow without modifying chapter content. Confirm unlock with `document.querySelector('[contenteditable]').getAttribute('contenteditable') === 'true'`.

## Gotchas
- Playwright screenshots save to the repo root — move them out or delete before finishing.
- Some chapter thumbnail images 404 (`/api/image/*_thumb.webp`) — pre-existing data issue, not a regression signal.
