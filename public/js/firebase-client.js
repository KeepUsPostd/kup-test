// Firebase Client SDK — Browser-side authentication
// This file initializes Firebase in the browser and provides
// helper functions for sign-up, login, and auth state management.
//
// IMPORTANT: Load the Firebase SDK scripts BEFORE this file:
// <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
// <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js"></script>
// <script src="/js/firebase-client.js"></script>

// Firebase config — production project (keepuspostd-38a88)
const firebaseConfig = {
  apiKey: 'AIzaSyBnF-M4eJya6SfH-gqUJAgb58r_UuLqt7I',
  authDomain: 'keepuspostd-38a88.firebaseapp.com',
  projectId: 'keepuspostd-38a88',
  storageBucket: 'keepuspostd-38a88.firebasestorage.app',
  messagingSenderId: '634719210006',
  appId: '1:634719210006:web:cedde80491b96b86604337',
};

// Initialize Firebase
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

const auth = firebase.auth();

// --- Auth Helper Functions ---

// Sign up with email & password
async function kupSignUp(email, password, firstName, lastName, profileType) {
  try {
    const userCredential = await auth.createUserWithEmailAndPassword(email, password);
    const firebaseUser = userCredential.user;

    // Register in our backend (creates MongoDB user + profile)
    const token = await firebaseUser.getIdToken();
    const response = await fetch('/api/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        email,
        firebaseUid: firebaseUser.uid,
        firstName,
        lastName,
        profileType, // 'influencer' or 'brand'
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Registration failed');

    // Send branded verification email via our API (non-blocking)
    try {
      await fetch('/api/auth/send-verification-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });
      console.log('📧 Branded verification email sent to', email);
    } catch (verifyErr) {
      console.warn('Verification email send failed (non-blocking):', verifyErr.message);
    }

    console.log('KUP signup successful:', data);
    return data;
  } catch (error) {
    console.error('KUP signup error:', error.message);
    throw error;
  }
}

// Sign in with email & password
async function kupSignIn(email, password) {
  try {
    const userCredential = await auth.signInWithEmailAndPassword(email, password);
    const firebaseUser = userCredential.user;

    // Update login tracking in our backend
    const token = await firebaseUser.getIdToken();
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });

    const data = await response.json();
    console.log('KUP login successful:', data);
    return data;
  } catch (error) {
    console.error('KUP login error:', error.message);
    throw error;
  }
}

// Sign in with Google
async function kupSignInWithGoogle() {
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    const userCredential = await auth.signInWithPopup(provider);
    const firebaseUser = userCredential.user;

    // Check if user exists in our backend, if not register
    const token = await firebaseUser.getIdToken();
    const meResponse = await fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (meResponse.ok) {
      // Existing user — update login
      const loginResponse = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });
      return await loginResponse.json();
    } else {
      // New user — register
      const nameParts = (firebaseUser.displayName || '').split(' ');
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          email: firebaseUser.email,
          firebaseUid: firebaseUser.uid,
          firstName: nameParts[0] || '',
          lastName: nameParts.slice(1).join(' ') || '',
          profileType: 'brand', // default for Google sign-in
        }),
      });
      return await response.json();
    }
  } catch (error) {
    console.error('Google sign-in error:', error.message);
    throw error;
  }
}

// Sign out
async function kupSignOut() {
  await auth.signOut();
  localStorage.removeItem('kupUser');
  window.location.href = '/pages/login.html';
}

// Get current Firebase ID token (for API calls)
async function getAuthToken() {
  const user = auth.currentUser;
  if (!user) return null;
  return await user.getIdToken();
}

// Listen for auth state changes
auth.onAuthStateChanged((user) => {
  if (user) {
    console.log('User signed in:', user.email);
  } else {
    console.log('User signed out');
  }
});
