// Firebase de l'app Checklist (projet "check-list-peremption").
// Toutes les données de cette app sont dans des collections préfixées "stockapp_",
// donc totalement séparées de DispatchAI (collections "dispatchai_*").
import { initializeApp } from "firebase/app";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";

const config = {
  apiKey: "AIzaSyAHxMNER2le2Hb65R2qXWaYRhKrjN8zJaU",
  authDomain: "check-list-peremption.firebaseapp.com",
  databaseURL: "https://check-list-peremption-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "check-list-peremption",
  storageBucket: "check-list-peremption.firebasestorage.app",
  messagingSenderId: "20359103251",
  appId: "1:20359103251:web:c52af261ee73613aa4d0e6",
};

const app = initializeApp(config);
export const dbChecklists = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
