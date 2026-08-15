// firebase-config.js
// Centralized Firebase Configuration File

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getFirestore, enableIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js";

// നിങ്ങളുടെ ഫയർബേസ് കോൺഫിഗറേഷൻ
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyCQgPVNSb2egQK2CHtGCwituXNH5dCNk0g",
  authDomain: "fast-portal-003.firebaseapp.com",
  projectId: "fast-portal-003",
  storageBucket: "fast-portal-003.firebasestorage.app",
  messagingSenderId: "815494478086",
  appId: "1:815494478086:web:b2fcdaa0adde8cf8fa4687",
  measurementId: "G-H3SDSG82Z7"
};

// ആപ്പ് ഇനിഷ്യലൈസ് ചെയ്യുന്നു
const app = initializeApp(firebaseConfig);

// Auth, Firestore സേവനങ്ങൾ ഇവിടെ സെറ്റ് ചെയ്യുന്നു
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// Performance Optimization: Offline Data Persistence
// ഇത് എനേബിൾ ചെയ്തതോടെ ഒരിക്കൽ ലോഡ് ആയ ഡാറ്റ ഫോണിൽ സേവ് ആകും. 
// പിന്നീട് റീലോഡ് ചെയ്യുമ്പോൾ വളരെ പെട്ടെന്ന് (Fast & Smooth) വർക്ക് ചെയ്യും.
enableIndexedDbPersistence(db)
  .catch((err) => {
      if (err.code == 'failed-precondition') {
          // Multiple tabs open, persistence can only be enabled in one tab at a time.
          console.log('Persistence failed: Multiple tabs open');
      } else if (err.code == 'unimplemented') {
          // The current browser does not support all of the features required to enable persistence
          console.log('Persistence is not supported by this browser');
      }
  });

// Export services so other files can use them
export { app, auth, db, storage };
