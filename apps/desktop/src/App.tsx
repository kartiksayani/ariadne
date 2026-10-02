import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface PingReceipt {
  nonce: string;
  payload: string;
  pid: number;
  receipt_id: string;
}

export default function App() {
  const [nonce, setNonce] = useState('0'.repeat(64));
  const [payload, setPayload] = useState('Ariadne scaffold');
  const [receipt, setReceipt] = useState<PingReceipt>();
  const [error, setError] = useState('');
  async function ping() {
    setError('');
    try {
      setReceipt(await invoke<PingReceipt>('native_ping', { request: { nonce, payload } }));
    } catch (failure) {
      setError(typeof failure === 'object' && failure !== null && 'code' in failure ? String(failure.code) : 'transport_unavailable');
    }
  }
  return (
    <main>
      <h1>Ariadne scaffold</h1>
      <p>Test the desktop wiring. This temporary diagnostic receipt is discarded when the app closes.</p>
      <label>
        Nonce
        <input id="nonce" value={nonce} onChange={event => setNonce(event.target.value)} />
      </label>
      <label>
        Payload
        <input id="payload" value={payload} onChange={event => setPayload(event.target.value)} />
      </label>
      <button id="ping" onClick={() => { void ping(); }}>Send diagnostic ping</button>
      <pre id="receipt">{receipt ? JSON.stringify(receipt) : ''}</pre>
      <p id="error" role="alert">{error}</p>
    </main>
  );
}
