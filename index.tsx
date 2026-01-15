
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';

console.log("Mounting Itero Application...");

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Target container 'root' not found in the DOM.");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
