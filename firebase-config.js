import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, GoogleAuthProvider } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey:            "AIzaSyBwy5y_wFuuTU2i7jzEodenpIPCVOnifog",
  authDomain:        "toody-1ab05.firebaseapp.com",
  projectId:         "toody-1ab05",
  storageBucket:     "toody-1ab05.firebasestorage.app",
  messagingSenderId: "418315904096",
  appId:             "1:418315904096:web:89fe1cfec4fc7d53c7cf05"
};

export const firebaseApp    = initializeApp(firebaseConfig);
export const auth           = getAuth(firebaseApp);
export const db             = getFirestore(firebaseApp);
export const googleProvider = new GoogleAuthProvider();
