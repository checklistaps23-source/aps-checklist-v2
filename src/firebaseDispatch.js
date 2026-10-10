// Accès en LECTURE SEULE au Firebase de DispatchAI (projet "dispatchai-aps"),
// utilisé uniquement par le bouton "Importer depuis DispatchAI" (Paramètres).
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const config = {
  apiKey: "AIzaSyBdqAtlMJdVATFwJbQyhOEN8R50GCOB2vI",
  authDomain: "dispatchai-aps.firebaseapp.com",
  projectId: "dispatchai-aps",
  storageBucket: "dispatchai-aps.firebasestorage.app",
  messagingSenderId: "251632976678",
  appId: "1:251632976678:web:716a0b97785c238c30f7e7",
};

const app = initializeApp(config, "dispatchai");
export const dbDispatch = getFirestore(app);
