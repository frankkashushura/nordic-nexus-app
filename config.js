/* NORDIC NEXUS server address. The publishable key is meant to be public:
   all data is protected by sign-in and the database rules, not by this key. */
window.NEXUS_CONFIG = {
  url: 'https://harlulhzxaqhidcwuyqy.supabase.co',
  key: 'sb_publishable_JfN_uK1UIKzJa7-Gko8SeQ_XE4wiBx7',
  edition: 'standalone',
  // Firebase (Google) – only used to deliver notifications to phones and computers. These values are public IDs, not secrets.
  firebase: {
    apiKey: 'AIzaSyBAGm6mcJ_vAVKRuF5drdIzEIu0PdYHRjE',
    authDomain: 'nordic-nexus.firebaseapp.com',
    projectId: 'nordic-nexus',
    storageBucket: 'nordic-nexus.firebasestorage.app',
    messagingSenderId: '246973686083',
    appId: '1:246973686083:web:f49218642f2d7424b14ff6',
    vapidKey: 'BAUqjHbYpVqBPX8rwf5p9JSFsn7g6G_ntt0grUyRx0dOeLWn8qLHNtbGZ0mdgWB_niHt5c7e_EbKm8SgV4Ld8l8'
  }
};
