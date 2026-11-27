import type {CapacitorConfig} from '@capacitor/cli';

const serverUrl = process.env.CAPACITOR_SERVER_URL?.trim();

const config: CapacitorConfig = {
  appId: 'com.funtarget.app',
  appName: 'FUN TARGET',
  webDir: 'dist',
  // Set CAPACITOR_SERVER_URL to the deployed HTTPS Cloud Run URL before
  // running `npx cap sync android`. The app then uses the same API + WebSocket
  // backend as the browser version instead of a broken local-only WebView.
  ...(serverUrl ? {server: {url: serverUrl, cleartext: false}} : {}),
};

export default config;
