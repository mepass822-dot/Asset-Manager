import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyAwzihnJuvwAbwU4wjx8KDmr-GWQPJuevg",
  authDomain: "mec-agent-ops.firebaseapp.com",
  databaseURL: "https://mec-agent-ops-default-rtdb.firebaseio.com",
  projectId: "mec-agent-ops",
  storageBucket: "mec-agent-ops.firebasestorage.app",
  messagingSenderId: "468449680397",
  appId: "1:468449680397:web:a26f06b29619e88f550944",
  measurementId: "G-PHQVQTJXPM",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export default app;

export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers as Record<string, string> | undefined),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}
