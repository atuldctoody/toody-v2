# Toody V2 — Claude Code Reference

## 1. Project Overview

Toody is an AI-powered IELTS Academic preparation app. It is a 2-week MVP structured as 10 sessions delivered over 5 days per week (Mon–Fri). Each session targets one IELTS skill or sub-skill. The app is fully personalised: all content is AI-generated at runtime based on the student's target band, prior performance, and behaviour patterns stored in Firestore.

The core loop:
1. Student completes a session (reading, listening, writing, or speaking)
2. Results and behaviour are written to Firestore (`studentBrain`)
3. On the next session, `studentBrain.contextSnippet` is injected into the AI prompt so the content adapts to the student's actual weaknesses

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JS (ES6 modules), HTML5, CSS3 — no framework, no bundler |
| Auth | Firebase Authentication v10.12.0 (Google OAuth) |
| Database | Firebase Firestore (student profile + session subcollection) |
| Hosting | Firebase Hosting |
| AI content | OpenAI GPT-4o mini via Vercel serverless function (`/api/generate`) |
| Listening audio | ElevenLabs TTS via Vercel serverless function (`/api/audio`) |
| Speaking transcription | OpenAI Whisper via Vercel serverless function (`/api/transcribe`) |
| PWA | Custom Service Worker (`sw.js`), cache name `toody-v2-v6` |

**API base URL:** `https://toody-api.vercel.app`

Firebase project: `toody-1ab05`

---

## 3. File Structure

```
toody-v2/
├── index.html          # Login page — Google Sign-In button, redirects to app.html on auth
├── app.html            # Main app shell — all 14 screens as hidden <div class="screen"> elements
├── app.js              # All client-side logic (~2100 lines) — routing, state, API calls, Firebase reads/writes
├── styles.css          # All styling (~875 lines) — design system, screen layouts, component classes
├── firebase-config.js  # Firebase SDK initialisation — exports auth, db, googleProvider
├── firebase.json       # Firebase Hosting config — serves current directory, ignores .dotfiles and .docx
├── manifest.json       # PWA manifest — name, icons, theme colour (#6557D4), standalone display
├── sw.js               # Service Worker — caches app shell, bypasses Firebase/API calls (always network)
├── icons/
│   └── toody-logo.png  # App logo — used at 36px in header (icon only, no wordmark)
└── CLAUDE.md           # This file
```

---

## 4. Key Decisions — Locked

### Layout & PWA
- **Mobile-first, 390px base width.** Max-width 430px. Never design for desktop breakpoints.
- **PWA from day one.** Service worker installed on first load. App shell cached. Works offline for cached assets.

### Screen Architecture
- **One shared screen per section type.** There is one `s-reading`, one `s-listening`, one `s-writing`, one `s-speaking` screen. Firebase (`studentData.dayNumber`) tells each screen what content to load and which variant to run. Do not create day-specific screens.
- Routing is handled by `goTo(screenId)` — toggles `.active` class, forces `display:flex` if CSS override detected.
- Screen IDs: `s-loading`, `s-onboarding`, `s-home`, `s-session-intro`, `s-teach`, `s-warmup`, `s-reading`, `s-toughlove`, `s-listening`, `s-writing`, `s-speaking`, `s-notebook`, `s-minimock`, `s-progress`

### Content
- **No hardcoded content anywhere (except the Day 1 TRAP question).** Every passage, scenario, question set, and writing prompt is AI-generated at session start using the student's `contextSnippet`.
- The TRAP question on Day 1 is intentionally hardcoded — it tests True/False/Not Given reasoning on a specific NG edge case and must not be replaced with AI content.

### studentBrain (Firestore)
- The `studentBrain` object in the student's Firestore document is the personalisation engine. It stores:
  - `skills` — accuracy and attempts per sub-skill (tfng, matchingHeadings, multipleChoice, formCompletion, task1, task2, part1)
  - `behaviourPatterns` — scroll behaviour, time-per-question, rereading count
  - `contextSnippet` — a short plain-English summary injected into every AI prompt (e.g. "Student scored 60% on TF/NG. Tends to confuse True and Not Given. Weak on negative statements.")
- Always update `studentBrain` after every session. Always inject `contextSnippet` into AI prompts.

### Design System
| Token | Value |
|---|---|
| `--accent` | `#6557D4` (purple) |
| `--success` | `#2EC48A` |
| `--bg` | `#F4F4F9` |
| `--r` | `14px` (border radius) |
| Font | Sora (Google Fonts) |
| Shadow sm | `0 1px 4px rgba(0,0,0,.08)` |
| Shadow | `0 4px 16px rgba(0,0,0,.10)` |

- **Logo:** `icons/toody-logo.png` at `36px` height in the header. Icon only — no text wordmark next to it anywhere in the app.

---

## 5. Current Build Status

### Screens — Done
| Screen | What it does |
|---|---|
| `s-loading` | Spinner shown while Firebase auth resolves |
| `s-onboarding` | 3-step flow: target band (slider 5.0–9.0), exam date (optional), prior experience (yes/no) |
| `s-home` | Greeting, today's session card, skill snapshot, Coming Up (next 3 days), streak |
| `s-session-intro` | Skill icon, label, expectations list, "I'm ready" button |
| `s-teach` | Day 1 only — 3-phase teach-first: concept explanation → worked example → micro test |
| `s-warmup` | Days 2–10 — one recall question from the previous session before loading the main session |
| `s-reading` | AI passage + 5 TF/NG or Matching Headings questions, per-question feedback, submit |
| `s-toughlove` | Post-correct-answer reasoning check — student identifies the key sentence from 4 options |
| `s-listening` | AI scenario + ElevenLabs audio + questions (Multiple Choice or Form Completion depending on day) |
| `s-writing` | Task 1 or Task 2 prompt, textarea, live word count, AI band evaluation with 4 criteria |
| `s-speaking` | Mic recording, Whisper transcription, AI band evaluation with 4 criteria |
| `s-notebook` | Session results — standard view (Days 1–4, 6–9), Week 1 Report (Day 5), writing/speaking views |
| `s-progress` | Full session history from Firestore — stats, skill bars, sortable session list |

### Screens — In Progress / Incomplete
| Screen | Status |
|---|---|
| `s-minimock` | Partially built — 4-section flow exists, results view exists, but no timed countdown (real IELTS is timed) |
| Day 9 Drill | `DAY_PLAN[9]` has `screen: null` — currently re-runs the weakest skill with no drill-specific UI |

### Known Bugs
- `console.log` and `console.warn` statements are still present in `app.js` — strip before production
- `alert()` is used for writing validation (line ~1364) and mic permission (line ~1554) — replace with in-app toast
- Pronunciation criterion in speaking evaluation gives an artificial neutral score with a caveat — cannot assess from transcript text alone
- Behaviour analytics are collected and saved to Firestore but never surfaced in any UI view
- `studentBrain.contextSnippet` is written after sessions but not yet confirmed to be injected in all AI prompt paths — verify each `loadXxxSession()` function includes it

---

## 6. What NOT To Do

- **No hardcoded answers or question content** (except the Day 1 TRAP). Every question must come from the AI via `/api/generate`.
- **No fake feedback.** If an AI evaluation call fails, show an error state — do not display made-up scores or placeholder band estimates.
- **No binary mastery thresholds.** Do not gate content behind "you must score 80% to proceed". Progress is always forward; the difficulty and focus adapt via `contextSnippet`.
- **No placeholder data shown to students.** If `studentData` hasn't loaded, show the loading screen. If a session hasn't been completed, show `—` or omit the field. Never show `0.0`, `null`, or `undefined` in UI.
- **Do not add new screens for individual days.** If Day 9 needs special UI, add a conditional block inside the existing shared screen, not a new `s-drill` screen.
- **Do not modify the TRAP question.** It is hardcoded intentionally and specifically designed to catch a particular reasoning error.
