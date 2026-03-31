// modules/firebase.js
// Firestore CRUD helpers — all DB reads and writes go through here.
//
// Re-exports: auth, db (from firebase-config.js)
// Circular note: imports callAI + currentUser from state.js; state.js imports
//   updateStudentDoc from here. Safe — both sides are called at runtime, not init-time.

import { auth, db } from '../firebase-config.js';
import {
  doc, getDoc, setDoc, updateDoc,
  addDoc, collection, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { currentUser, callAI } from './state.js';

export { auth, db };

// ── FIREBASE HELPERS ─────────────────────────────────────────────
export function getStudentDoc(uid) {
  return getDoc(doc(db, 'students', uid));
}

export async function createStudentDoc(uid, data) {
  const blank = { accuracy: 0, attempted: 0, lastPracticed: null, trend: 'new' };
  await setDoc(doc(db, 'students', uid), {
    name:             data.name,
    email:            data.email,
    targetBand:       data.targetBand,
    examDate:         data.examDate || null,
    currentBand:      data.targetBand,
    weekNumber:       1,
    dayNumber:        1,
    streak:           0,
    isNewStudent:     false,
    createdAt:        serverTimestamp(),
    lastSession:      null,
    toughLoveResults: 0,
    weakAreas:        [],
    brain: {
      subjects: {
        'ielts-academic': {
          skills: {
            'reading-tfng':              { ...blank },
            'reading-matchingHeadings':  { ...blank },
            'reading-summaryCompletion': { ...blank },
            'listening-multipleChoice':  { ...blank },
            'listening-formCompletion':  { ...blank },
            'listening-mapDiagram':      { ...blank },
            'writing-task1':   { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
            'writing-task2':   { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
            'speaking-part1':  { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
            'speaking-part2':  { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
            'speaking-part3':  { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
          }
        }
      }
    }
  });
}

export async function createSkeletonDoc(uid) {
  const blank = { accuracy: 0, attempted: 0, lastPracticed: null, trend: 'new' };
  await setDoc(doc(db, 'students', uid), {
    name:             currentUser.displayName || 'Student',
    email:            currentUser.email       || '',
    targetBand:       6.5,
    examDate:         null,
    hasExperience:    null,
    currentBand:      6.5,
    weekNumber:       1,
    dayNumber:        1,
    streak:           0,
    isNewStudent:     true,
    createdAt:        serverTimestamp(),
    lastSession:      null,
    toughLoveResults: 0,
    weakAreas:        [],
    brain: {
      subjects: {
        'ielts-academic': {
          skills: {
            'reading-tfng':              { ...blank },
            'reading-matchingHeadings':  { ...blank },
            'reading-summaryCompletion': { ...blank },
            'listening-multipleChoice':  { ...blank },
            'listening-formCompletion':  { ...blank },
            'listening-mapDiagram':      { ...blank },
            'writing-task1':  { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
            'writing-task2':  { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
            'speaking-part1': { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
            'speaking-part2': { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
            'speaking-part3': { bandEstimate: 0, attempted: 0, lastPracticed: null, trend: 'new' },
          }
        }
      }
    }
  });
}

export async function updateStudentDoc(uid, updates) {
  await updateDoc(doc(db, 'students', uid), updates);
}

export async function saveSessionDoc(uid, data) {
  const ref = await addDoc(collection(db, 'students', uid, 'sessions'), {
    ...data,
    date: serverTimestamp()
  });
  return ref;
}

// Generates a 3-sentence mentor-facing session narrative and saves it to the session doc.
// Fire-and-forget — never awaited, never blocks UI.
export async function generateAndSaveNarrative(uid, sessionRef, ctx) {
  try {
    const prompt = {
      system: 'You are a clinical IELTS tutor writing session notes for a human mentor. Be specific, factual, and concise.',
      user: `Session data: ${JSON.stringify(ctx)}

In exactly 3 sentences, summarise this student's session. Sentence 1: what they practised and their overall score. Sentence 2: the specific pattern you observed — what they got right and what they got wrong at a sub-type level. Sentence 3: one honest observation about where the learning is and is not happening. Be specific and clinical — this will be read by a human mentor, not the student.`
    };
    const narrative = await callAI(prompt);
    await updateDoc(sessionRef, { sessionNarrative: narrative.trim() });
  } catch { /* non-critical — narrative is additive only */ }
}
