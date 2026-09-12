/**
 * socket.js — WebSocket client for activity state.
 *
 * Connects to the activity server's WebSocket endpoint
 * and provides real-time playback state + jingle events.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export function useSocket(botPort) {
  const [state, setState] = useState(null);
  const [jingles, setJingles] = useState([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const reconnectRef = useRef(null);
  const attemptRef = useRef(0);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[socket] Connected');
        setConnected(true);
        attemptRef.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'state') {
            if (data.state) {
              setState(prev => ({
                ...data.state,
                updatedAt: data.timestamp,
              }));
            }
            if (data.jingles && data.jingles.length > 0) {
              setJingles(prev => [...prev, ...data.jingles].slice(-20));
            }
          }
        } catch {}
      };

      ws.onclose = () => {
        console.log('[socket] Disconnected');
        setConnected(false);
        wsRef.current = null;

        // Reconnect with exponential backoff
        const delay = Math.min(
          RECONNECT_BASE_MS * Math.pow(2, attemptRef.current),
          RECONNECT_MAX_MS,
        );
        attemptRef.current += 1;
        reconnectRef.current = setTimeout(connect, delay);
      };

      ws.onerror = (err) => {
        console.error('[socket] Error:', err);
      };
    } catch (err) {
      console.error('[socket] Connection failed:', err);
    }
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

  return { state, jingles, connected };
}
