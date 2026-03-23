# Toody V2 — Claude Code Reference

---

## 1. What Toody Is

Toody is not an IELTS practice app. It is a personal coach.

The distinction matters for every line of code written here. A practice app gives students content to work through. A coach gives students a mirror — it shows them exactly where their thinking breaks down and why. Every session Toody runs is a coaching intervention: it knows what the student got wrong last time, it knows what band they need, and it generates content specifically designed to close that gap.

**The product mission in one sentence:** Get this specific student to their target band — not "help students prepare for IELTS" in general.

**What makes Toody different from generic IELTS prep:**
- Every passage, question, scenario, and evaluation is generated at runtime for one student
- Difficulty is set to the student's target band — not a fixed level
- Feedback names the exact reasoning failure, not just the correct answer
- The AI knows the student's history and adapts — sessions are not interchangeable

**The coaching loop:**
1. Student completes a session (reading, listening, writing, or speaking)
2. Results and behaviour are written to Firestore (`studentBrain`)
3. On the next session, `buildContextSnippet()` constructs a personalised context block injected into every AI prompt — content adapts to actual weaknesses, not perceived ones

---

## 2. How the Vision Is Enforced in Code

Every AI call in `app.js` goes through `callAI()`. The system prompt for every call is built in three layers:

```
Layer 1 — Vision:   getVisionPrompt(studentData)      from api/vision-prompt.js
Layer 2 — Context:  buildContextSnippet()              from app.js
Layer 3 — Task:     prompt.system                      from the calling function
```

**`api/vision-prompt.js`** establishes Toody's coaching identity: who the student is, what band they're targeting, and what "good content" means for this product. This is the mission layer — it prevents generic content generation.

**`buildContextSnippet()`** injects the student's live data: skill accuracy per sub-type, behaviour patterns (scroll-backs, answer changes, time-per-question), weak areas, and a plain-English summary of what the student needs most right now.

**`prompt.system`** is the task-specific instruction written by each session-loading function (e.g. "You are an IELTS examiner. Generate a Summary Completion exercise...").

> **Rule:** Never bypass `callAI()` for content generation. Adding a direct `fetch(API_URL, ...)` somewhere skips the vision and context layers and produces generic content.

---

## 3. Tech Stack

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

## 4. File Structure

```
toody-v2/
├── index.html          # Login page — Google Sign-In button, redirects to app.html on auth
├── app.html            # Main app shell — all screens as hidden <div class="screen"> elements
├── app.js              # All client-side logic — routing, state, API calls, Firebase reads/writes
├── styles.css          # All styling — design system, screen layouts, component classes
├── firebase-config.js  # Firebase SDK initialisation — exports auth, db, googleProvider
├── firebase.json       # Firebase Hosting config — serves current directory, ignores test files
├── manifest.json       # PWA manifest — name, icons, theme colour (#6557D4), standalone display
├── sw.js               # Service Worker — caches app shell, bypasses Firebase/API calls
├── api/
│   └── vision-prompt.js  # Exports getVisionPrompt(studentData) — injected into every AI call
└── icons/
    └── toody-logo.png    # App logo — used at 36px in header, 80px on login screen
```

---

## 5. Key Decisions — Locked

### Layout & PWA
- **Mobile-first, 390px base width.** Max-width 430px. Never design for desktop breakpoints.
- **PWA from day one.** Service worker installed on first load. App shell cached.

### Screen Architecture
- **One shared screen per section type.** There is one `s-reading`, one `s-listening`, one `s-writing`, one `s-speaking` screen. Firebase (`studentData.dayNumber`) tells each screen what content to load and which variant to run. Do not create day-specific screens.
- Routing is handled by `goTo(screenId)` — toggles `.active` class.
- Screen IDs: `s-loading`, `s-onboarding`, `s-home`, `s-session-intro`, `s-teach`, `s-warmup`, `s-reading`, `s-toughlove`, `s-listening`, `s-writing`, `s-speaking`, `s-notebook`, `s-minimock`, `s-progress`

### Content
- **No hardcoded content anywhere (except the Day 1 TRAP question).** Every passage, scenario, question set, and writing prompt is AI-generated at session start using the student's context.
- The TRAP question on Day 1 is intentionally hardcoded — it tests True/False/Not Given reasoning on a specific NG edge case and must not be replaced with AI content.

### studentBrain (Firestore)
- The `studentBrain` object in the student's Firestore document is the personalisation engine. It stores:
  - `skills` — accuracy and attempts per sub-skill (tfng, matchingHeadings, multipleChoice, formCompletion, task1, task2, part1)
  - `behaviourPatterns` — scroll behaviour, time-per-question, rereading count
  - `contextSnippet` — a short plain-English summary injected into every AI prompt
- Always update `studentBrain` after every session. Always inject `contextSnippet` via `buildContextSnippet()`.

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

- **Logo:** `icons/toody-logo.png` at `36px` height in the header. Icon only — no text wordmark.

---

## 6. Current Build Status

### Screens — Done
| Screen | What it does |
|---|---|
| `s-loading` | Spinner shown while Firebase auth resolves |
| `s-onboarding` | 3-step flow: target band (slider 5.0–9.0), exam date (optional), prior experience (yes/no) |
| `s-home` | Greeting, today's session card, skill snapshot, Coming Up (next 3 days), streak |
| `s-session-intro` | Skill icon, label, expectations list, "I'm ready" button |
| `s-teach` | Day 1 only — 3-phase teach-first: concept explanation → worked example → micro test |
| `s-warmup` | Days 2–10 — one recall question from the previous session before loading the main session |
| `s-reading` | AI passage + 5 TF/NG or Summary Completion questions, per-question feedback, submit |
| `s-toughlove` | Post-correct-answer reasoning check — student identifies the key sentence from 4 options |
| `s-listening` | AI scenario + ElevenLabs audio + questions (Multiple Choice or Form Completion depending on day) |
| `s-writing` | Task 1 or Task 2 prompt, textarea, live word count, AI band evaluation with 4 criteria |
| `s-speaking` | Mic recording, Whisper transcription, AI band evaluation with 4 criteria |
| `s-notebook` | Session results — standard view (Days 1–4, 6–9), Week 1 Report (Day 5), writing/speaking views |
| `s-progress` | Full session history from Firestore — stats, skill bars, sortable session list |

### Screens — In Progress / Incomplete
| Screen | Status |
|---|---|
| `s-minimock` | Partially built — 4-section flow exists, results view exists, but no timed countdown |
| Day 9 Drill | Currently re-runs the weakest skill with no drill-specific UI |

### Known Bugs
- `console.log` and `console.warn` statements still present in `app.js` — strip before production
- `alert()` used for writing validation and mic permission — replace with in-app toast
- Pronunciation criterion in speaking evaluation gives an artificial neutral score — cannot assess from transcript text alone
- Behaviour analytics collected and saved to Firestore but never surfaced in any UI view

---

## 7. What NOT To Do

- **No hardcoded answers or question content** (except the Day 1 TRAP). Every question must come from the AI via `callAI()`.
- **Never bypass `callAI()`** for content generation — it carries the vision and context layers. A direct `fetch(API_URL)` produces generic content.
- **No fake feedback.** If an AI evaluation call fails, show an error state — do not display made-up scores or placeholder band estimates.
- **No binary mastery thresholds.** Do not gate content behind "you must score 80% to proceed". Progress is always forward; difficulty adapts via `contextSnippet`.
- **No placeholder data shown to students.** If `studentData` hasn't loaded, show the loading screen. Never show `0.0`, `null`, or `undefined` in UI.
- **Do not add new screens for individual days.** Add conditional blocks inside existing shared screens.
- **Do not modify the TRAP question.** It is hardcoded intentionally.
