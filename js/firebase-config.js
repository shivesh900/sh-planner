// Firebase web config for SH PLANNER (project "sh-planner-c87c5", web app "SH PLANNER Web").
// These keys are public by design. Access to data is enforced by firestore.rules: each signed-in
// user can only read/write users/{their uid}/**. Analytics is not used.
export const firebaseConfig = {
  apiKey: 'AIzaSyCiSdFGkTYwAu5svkljwdcMu_0kcFBCh40',
  authDomain: 'sh-planner-c87c5.firebaseapp.com',
  projectId: 'sh-planner-c87c5',
  storageBucket: 'sh-planner-c87c5.firebasestorage.app',
  messagingSenderId: '815321535129',
  appId: '1:815321535129:web:1ab3e920a0580243aade08',
};
export const isConfigured = (c = firebaseConfig) => !!(c && c.apiKey && c.projectId && !/^PASTE/.test(c.apiKey) && !/^PASTE/.test(c.projectId));
