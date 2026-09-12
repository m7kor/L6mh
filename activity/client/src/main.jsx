/**
 * main.jsx — Discord Activity entry point.
 *
 * Initializes the Discord Embedded App SDK, handles OAuth,
 * and renders the synchronized player + jingle overlay.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
